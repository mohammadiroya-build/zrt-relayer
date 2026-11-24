const { ethers } = require("ethers");
const { bridgeAbi } = require("./abi");

const STATUS = {
  SENT: "sent",
  RECEIVED: "received",
  ACKNOWLEDGED: "acknowledged",
  FAILED: "failed",
  REFUNDED: "refunded",
};

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

class Relayer {
  constructor(config, store, log = console.log) {
    this.config = config;
    this.store = store;
    this.log = (msg) => log(`[relayer ${now()}] ${msg}`);
    this.providers = {};
    this.bridges = {};
    this.lock = false;
    this.stats = { lastTickAt: null, lastError: null, relayed: 0, refunded: 0, running: false, startedAt: new Date().toISOString() };
  }

  init() {
    for (const [key, chain] of Object.entries(this.config.chains)) {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
      this.providers[key] = provider;
      this.bridges[key] = new ethers.Contract(chain.bridge, bridgeAbi, provider);
    }
    this.attestorWallet = new ethers.Wallet(this.config.keys.attestor);
    this.relayerWallets = {};
    for (const key of Object.keys(this.config.chains)) {
      const wallet = new ethers.Wallet(this.config.keys.relayer, this.providers[key]);
      this.relayerWallets[key] = new ethers.NonceManager(wallet);
    }
    this.relayerAddress = new ethers.Wallet(this.config.keys.relayer).address;
    this.log(`attestor ${this.attestorWallet.address}`);
    this.log(`relayer  ${this.relayerAddress}`);
  }

  start() {
    if (this.stats.running) return;
    this.stats.running = true;
    this.log("indexer started");
    this.tick().catch((err) => this.fail(err));
    this.timer = setInterval(() => this.tick().catch((err) => this.fail(err)), this.config.pollMs);
    this.keepAlive();
  }

  fail(err) {
    this.stats.lastError = err?.shortMessage || err?.message || String(err);
    this.log(`tick error: ${this.stats.lastError}`);
  }

  /** Keeps hosts that idle-sleep on a schedule from doing so. */
  keepAlive() {
    if (!/^https:\/\//.test(this.config.publicUrl)) return;
    const ping = async () => {
      try {
        const res = await fetch(`${this.config.publicUrl}/health`);
        this.log(`keepalive ${res.status}`);
      } catch {
        /* host unreachable; the workflow ping is the backup */
      }
    };
    ping();
    setInterval(ping, 10 * 60 * 1000);
  }

  async tick() {
    if (this.lock) return;
    this.lock = true;
    try {
      for (const key of Object.keys(this.config.chains)) {
        await this.scanChain(key).catch((err) => {
          this.stats.lastError = `${key} scan: ${err.shortMessage || err.message}`;
        });
      }
      await this.processPending();
      this.store.save();
      this.stats.lastTickAt = new Date().toISOString();
    } finally {
      this.lock = false;
    }
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  async scanChain(key) {
    const chain = this.config.chains[key];
    const provider = this.providers[key];
    const bridge = this.bridges[key];
    const latest = await provider.getBlockNumber();
    const cursor = this.store.getCursor(key);
    let from = cursor ? cursor + 1 : Math.max(0, latest - this.config.startBlockOffset);
    if (from > latest) return;

    const span = 2000;
    while (from <= latest) {
      const to = Math.min(from + span - 1, latest);
      let events = [];
      try {
        events = await bridge.queryFilter(bridge.filters.PacketSent(), from, to);
      } catch (err) {
        // Public RPCs sometimes cap log ranges. Move forward; the manual
        // relay endpoint still accepts a transaction hash for any packet.
        this.log(`${key}: log query ${from}-${to} failed (${err.shortMessage || err.code}); skipping window`);
        from = to + 1;
        continue;
      }
      for (const event of events) {
        const packet = {
          id: event.args.packetId,
          srcDomain: chain.domain,
          dstDomain: Number(event.args.dstDomain),
          srcBridge: event.address,
          sender: event.args.sender,
          recipient: event.args.recipient,
          tokenId: event.args.tokenId,
          amount: event.args.amount,
          timeout: Number(event.args.timeout),
          sequence: Number(event.args.sequence),
        };
        const dstKey = this.keyForDomain(packet.dstDomain);
        if (!dstKey) continue;
        const id = this.store.transferId(key, packet.id);
        if (this.store.getTransfer(id)) continue;
        const transfer = this.store.upsertTransfer(id, {
          packetId: packet.id,
          srcChain: key,
          dstChain: dstKey,
          sender: packet.sender,
          recipient: packet.recipient,
          amount: packet.amount.toString(),
          tokenId: packet.tokenId,
          timeout: packet.timeout,
          sequence: packet.sequence,
          sendTx: event.transactionHash,
          srcDomain: packet.srcDomain,
          dstDomain: packet.dstDomain,
          status: STATUS.SENT,
          packet,
        });
        this.log(`discovered ${id} (${ethers.formatUnits(packet.amount, this.config.decimals)} ${this.config.symbol})`);
        void transfer;
      }
      from = to + 1;
      this.store.setCursor(key, to);
      this.store.save();
    }
  }

  keyForDomain(domain) {
    for (const [key, chain] of Object.entries(this.config.chains)) {
      if (Number(chain.domain) === Number(domain)) return key;
    }
    return null;
  }

  async enqueueFromTx(chainKey, txHash) {
    const chain = this.config.chains[chainKey];
    if (!chain) throw new Error(`unknown chain ${chainKey}`);
    const bridge = this.bridges[chainKey];
    const receipt = await this.providers[chainKey].getTransactionReceipt(txHash);
    if (!receipt) throw new Error("transaction not found or not mined yet");

    const parsed = receipt.logs
      .map((log) => {
        try {
          return bridge.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((log) => log && log.name === "PacketSent");

    if (!parsed.length) throw new Error("no PacketSent event in this transaction");
    const event = parsed[0];
    const packet = {
      id: event.args.packetId,
      srcDomain: chain.domain,
      dstDomain: Number(event.args.dstDomain),
      srcBridge: receipt.to,
      sender: event.args.sender,
      recipient: event.args.recipient,
      tokenId: event.args.tokenId,
      amount: event.args.amount,
      timeout: Number(event.args.timeout),
      sequence: Number(event.args.sequence),
    };
    const dstKey = this.keyForDomain(packet.dstDomain);
    const id = this.store.transferId(chainKey, packet.id);
    const transfer = this.store.upsertTransfer(id, {
      packetId: packet.id,
      srcChain: chainKey,
      dstChain: dstKey,
      sender: packet.sender,
      recipient: packet.recipient,
      amount: packet.amount.toString(),
      tokenId: packet.tokenId,
      timeout: packet.timeout,
      sequence: packet.sequence,
      sendTx: txHash,
      srcDomain: packet.srcDomain,
      dstDomain: packet.dstDomain,
      status: STATUS.SENT,
      packet,
    });
    this.store.save(true);
    await this.processTransfer(transfer, true);
    return this.store.getTransfer(id);
  }

  // ---------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------

  async processPending() {
    const pending = this.store.pendingTransfers();
    for (const transfer of pending) {
      await this.processTransfer(transfer).catch((err) => {
        this.stats.lastError = err.shortMessage || err.message;
        this.log(`${transfer.id}: ${this.stats.lastError}`);
      });
    }
  }

  async processTransfer(transfer, immediate = false) {
    const state = this.store.getTransfer(transfer.id);
    if (!state) return;
    if ([STATUS.ACKNOWLEDGED, STATUS.REFUNDED].includes(state.status)) return;
    if (!state.packet) return;

    const src = this.config.chains[state.srcChain];
    const dst = this.config.chains[state.dstChain];
    const dstBridge = this.bridges[state.dstChain];
    const srcBridge = this.bridges[state.srcChain];
    const packet = this.normalizePacket(state.packet);

    // Destination already credited (for example after a crash): finish the ack.
    if (state.status === STATUS.RECEIVED) {
      await this.sendAck(state, true, "0x");
      return;
    }

    if (state.status === STATUS.FAILED) {
      await this.refund(state);
      return;
    }

    if (Number(state.timeout) < Math.floor(Date.now() / 1000)) {
      await this.refund(state);
      return;
    }

    try {
      const processed = await dstBridge.processed(state.packetId);
      if (processed) {
        await this.sendAck(state, true, "0x");
        return;
      }

      const digest = await dstBridge.attestationDigest(packet);
      const signature = this.attestorWallet.signingKey.sign(digest).serialized;
      await dstBridge.receivePacket.staticCall(packet, [signature]);

      const tx = await dstBridge
        .connect(this.relayerWallets[state.dstChain])
        .receivePacket(packet, [signature], { gasLimit: 900000 });
      this.log(`${state.id}: receive submitted ${tx.hash}`);
      const receipt = await tx.wait(dst.confirmations);
      if (!receipt || receipt.status !== 1) throw new Error("receive transaction reverted");

      this.store.upsertTransfer(state.id, {
        status: STATUS.RECEIVED,
        receivedAt: new Date().toISOString(),
        txs: { receive: tx.hash },
      });
      this.store.save();
      this.log(`${state.id}: received on ${state.dstChain}`);
      this.stats.relayed += 1;

      await this.sendAck(this.store.getTransfer(state.id), true, "0x");
    } catch (err) {
      const reason = err.shortMessage || err.reason || err.message || "receive failed";
      const attempts = (state.attempts || 0) + 1;
      this.store.upsertTransfer(state.id, { attempts, error: reason });

      const fatal = /revert|insufficient|invalid|not allowed|unknown peer|cap/i.test(reason);
      if (fatal || attempts >= this.config.maxRetries) {
        this.log(`${state.id}: marking failed (${reason})`);
        this.store.upsertTransfer(state.id, { status: STATUS.FAILED, error: reason });
        await this.sendAck(this.store.getTransfer(state.id), false, ethers.toUtf8Bytes(reason.slice(0, 120)));
        await this.refund(this.store.getTransfer(state.id));
      } else {
        this.log(`${state.id}: attempt ${attempts} failed, will retry (${reason})`);
      }
      if (immediate) throw err;
    }
  }

  normalizePacket(packet) {
    return {
      id: packet.id,
      srcDomain: Number(packet.srcDomain),
      dstDomain: Number(packet.dstDomain),
      srcBridge: ethers.getAddress(packet.srcBridge),
      sender: ethers.getAddress(packet.sender),
      recipient: ethers.getAddress(packet.recipient),
      tokenId: packet.tokenId,
      amount: BigInt(packet.amount),
      timeout: Number(packet.timeout),
      sequence: Number(packet.sequence),
    };
  }

  async sendAck(state, success, reason) {
    if (!state) return;
    if (state.txs?.ack) return;
    const srcBridge = this.bridges[state.srcChain];
    try {
      this.log(`${state.id}: ack submitting on ${state.srcChain}`);
      const tx = await srcBridge
        .connect(this.relayerWallets[state.srcChain])
        .acknowledge(state.packetId, success, reason, { gasLimit: 300000 });
      const receipt = await tx.wait(this.config.chains[state.srcChain].confirmations);
      if (!receipt || receipt.status !== 1) throw new Error("ack transaction reverted");
      this.store.upsertTransfer(state.id, {
        status: success ? STATUS.ACKNOWLEDGED : STATUS.FAILED,
        acknowledgedAt: new Date().toISOString(),
        txs: { ack: tx.hash },
      });
      this.store.save();
      this.log(`${state.id}: ack ${success ? "success" : "failure"} ${tx.hash}`);
    } catch (err) {
      const reason2 = err.shortMessage || err.message;
      this.log(`${state.id}: ack failed (${reason2})`);
      this.store.upsertTransfer(state.id, { ackError: reason2 });
    }
  }

  async refund(state) {
    if (!state) return;
    if (state.status === STATUS.REFUNDED || state.txs?.refund) return;
    const srcBridge = this.bridges[state.srcChain];
    try {
      await srcBridge.refund.staticCall(state.packetId);
      const tx = await srcBridge.connect(this.relayerWallets[state.srcChain]).refund(state.packetId, { gasLimit: 300000 });
      const receipt = await tx.wait(this.config.chains[state.srcChain].confirmations);
      if (!receipt || receipt.status !== 1) throw new Error("refund transaction reverted");
      this.store.upsertTransfer(state.id, {
        status: STATUS.REFUNDED,
        refundedAt: new Date().toISOString(),
        txs: { refund: tx.hash },
      });
      this.store.save();
      this.stats.refunded += 1;
      this.log(`${state.id}: refunded ${tx.hash}`);
    } catch (err) {
      this.store.upsertTransfer(state.id, { refundError: err.shortMessage || err.message });
      this.log(`${state.id}: refund pending (${err.shortMessage || err.message})`);
    }
  }

  health() {
    return {
      ok: true,
      service: "roundtrip-relayer",
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: this.stats.startedAt,
      lastTickAt: this.stats.lastTickAt,
      lastError: this.stats.lastError,
      relayed: this.stats.relayed,
      refunded: this.stats.refunded,
      pending: this.store.pendingTransfers().length,
      chains: Object.fromEntries(
        Object.entries(this.config.chains).map(([key, chain]) => [
          key,
          { chainId: chain.chainId, bridge: chain.bridge, cursor: this.store.getCursor(key) },
        ])
      ),
    };
  }
}

module.exports = { Relayer, STATUS };
