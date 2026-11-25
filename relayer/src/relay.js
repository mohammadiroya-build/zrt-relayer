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
    this.queues = {};
    this.gas = {};
    this.lock = false;
    this.ready = false;
    this.minGas = ethers.parseEther(String(config.minGasNative || "0.0005"));
    this.stats = { lastTickAt: null, lastError: null, relayed: 0, refunded: 0, running: false, startedAt: new Date().toISOString() };
  }

  init() {
    for (const [key, chain] of Object.entries(this.config.chains)) {
      const request = new ethers.FetchRequest(chain.rpcUrl);
      request.timeout = 12000;
      const provider = new ethers.JsonRpcProvider(request, chain.chainId, { staticNetwork: true });
      this.providers[key] = provider;
      this.bridges[key] = new ethers.Contract(chain.bridge, bridgeAbi, provider);
    }
    if (!this.config.keys.attestor || !this.config.keys.relayer) return;
    this.attestorWallet = new ethers.Wallet(this.config.keys.attestor);
    this.relayerWallets = {};
    for (const key of Object.keys(this.config.chains)) {
      const wallet = new ethers.Wallet(this.config.keys.relayer, this.providers[key]);
      this.relayerWallets[key] = wallet;
      this.queues[key] = Promise.resolve();
    }
    this.relayerAddress = new ethers.Wallet(this.config.keys.relayer).address;
    this.log(`attestor ${this.attestorWallet.address}`);
    this.log(`relayer  ${this.relayerAddress}`);
    const cfg = this.config.expectedRoles || {};
    if (cfg.attestor && cfg.attestor.toLowerCase() !== this.attestorWallet.address.toLowerCase()) {
      this.log(`WARNING: ATTESTOR_PRIVATE_KEY gives ${this.attestorWallet.address} but config expects ${cfg.attestor}`);
    }
    if (cfg.relayer && cfg.relayer.toLowerCase() !== this.relayerAddress.toLowerCase()) {
      this.log(`WARNING: RELAYER_PRIVATE_KEY gives ${this.relayerAddress} but config expects ${cfg.relayer}`);
    }
  }

  start() {
    if (this.stats.running) return;
    this.stats.running = true;
    this.log("indexer started");
    this.tick().catch((err) => this.fail(err));
    this.timer = setInterval(() => this.tick().catch((err) => this.fail(err)), this.config.pollMs);
  }

  fail(err) {
    this.stats.lastError = err?.shortMessage || err?.message || String(err);
    this.log(`tick error: ${this.stats.lastError}`);
  }

  /** Serializes transactions per chain so the relayer and the faucet can share a key. */
  run(chainKey, fn) {
    const previous = this.queues[chainKey] || Promise.resolve();
    const next = previous.then(fn, fn);
    this.queues[chainKey] = next.then(() => undefined, () => undefined);
    return next;
  }

  isFunded(chainKey) {
    const entry = this.gas[chainKey];
    return !entry || entry.funded !== false;
  }

  async refreshGas() {
    if (!this.relayerAddress) return;
    const entries = await Promise.all(
      Object.keys(this.config.chains).map(async (key) => {
        try {
          const balance = await this.providers[key].getBalance(this.relayerAddress);
          return [key, { balance: ethers.formatEther(balance), funded: balance >= this.minGas }];
        } catch {
          return [key, { balance: null, funded: null }];
        }
      })
    );
    this.gas = Object.fromEntries(entries);
  }

  fundingError(chainKey) {
    const chain = this.config.chains[chainKey];
    const entry = this.gas[chainKey] || {};
    const balance = entry.balance !== null && entry.balance !== undefined ? `${entry.balance} ${chain.nativeSymbol}` : "no balance";
    return `relayer wallet needs ${chain.nativeSymbol} for gas on ${chain.name} (holds ${balance})`;
  }

  async tick() {
    if (this.lock) return;
    this.lock = true;
    try {
      this.stats.lastError = null;
      if (!this.config.bridgeEnabled) throw new Error("Bridge disabled in runtime config");
      await this.checkRoute();
      this.ready = true;
      await this.refreshGas().catch(() => {});
      for (const key of Object.keys(this.config.chains)) {
        await this.scanChain(key).catch((err) => {
          this.stats.lastError = `${key} scan: ${err.shortMessage || err.message}`;
        });
      }
      await this.processPending();
      this.store.save();
      this.stats.lastTickAt = new Date().toISOString();
    } catch (err) {
      this.ready = false;
      throw err;
    } finally {
      this.lock = false;
    }
  }

  async checkRoute() {
    await Promise.all(Object.entries(this.config.chains).map(async ([key, chain]) => {
      const bridge = this.bridges[key];
      const peer = Object.entries(this.config.chains).find(([other]) => other !== key)[1];
      const [network, version, relayer, attestor, threshold, count, peerAddress, token] = await Promise.all([
        this.providers[key].send("eth_chainId", []), bridge.protocolVersion(), bridge.relayer(),
        bridge.isAttestor(this.attestorWallet.address), bridge.threshold(), bridge.attestorCount(), bridge.peers(peer.domain),
        bridge.tokens(this.config.tokenId),
      ]);
      if (Number(network) !== Number(chain.chainId) || version !== 2n ||
          !attestor || threshold !== 1n || count !== 1n || relayer.toLowerCase() !== this.relayerAddress.toLowerCase() ||
          peerAddress.toLowerCase() !== peer.bridge.toLowerCase() ||
          token.toLowerCase() !== (chain.token.address || chain.token).toLowerCase()) {
        throw new Error(`${key}: bridge wiring does not match configured keys and route`);
      }
    }));
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  async scanChain(key) {
    const chain = this.config.chains[key];
    const provider = this.providers[key];
    const bridge = this.bridges[key];
    const latest = (await provider.getBlockNumber()) - chain.confirmations + 1;
    const cursor = this.store.getCursor(key);
    const lookback = Number(this.config.lookbackBlocks || 20000);
    // The store lives on an ephemeral disk, so a cold start rescans a bounded
    // window instead of trusting a cursor that may have moved much further.
    const floor = Math.max(chain.startBlock || 0, latest - lookback);
    let from = Math.max(cursor !== null ? cursor + 1 : 0, floor);
    if (from > latest) return;

    let span = 800;
    for (let pages = 0; pages < 40 && from <= latest; pages += 1) {
      const to = Math.min(from + span - 1, latest);
      let events = [];
      try {
        events = await bridge.queryFilter(bridge.filters.PacketSent(), from, to);
      } catch (err) {
        if (span > 200) {
          span = 200;
          pages -= 1;
          continue;
        }
        throw new Error(`log query ${from}-${to} failed; cursor not advanced (${err.shortMessage || err.code || "RPC error"})`);
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
        if (!dstKey || dstKey === key || packet.tokenId !== this.config.tokenId) continue;
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
    const reject = (message, status = 400) => Object.assign(new Error(message), { status });
    if (!this.ready) throw reject("route not ready", 503);
    const chain = this.config.chains[chainKey];
    if (!chain) throw new Error(`unknown chain ${chainKey}`);
    const bridge = this.bridges[chainKey];
    const receipt = await this.providers[chainKey].getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) throw reject("confirmed successful transaction required", 404);
    if (await receipt.confirmations() < chain.confirmations) throw reject("waiting for source confirmations", 409);

    const parsed = receipt.logs
      .filter((log) => log.address.toLowerCase() === chain.bridge.toLowerCase())
      .map((log) => {
        try {
          return bridge.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((log) => log && log.name === "PacketSent");

    if (!parsed.length) throw reject("no PacketSent event from the configured source bridge");
    const event = parsed[0];
    const packet = {
      id: event.args.packetId,
      srcDomain: chain.domain,
      dstDomain: Number(event.args.dstDomain),
      srcBridge: chain.bridge,
      sender: event.args.sender,
      recipient: event.args.recipient,
      tokenId: event.args.tokenId,
      amount: event.args.amount,
      timeout: Number(event.args.timeout),
      sequence: Number(event.args.sequence),
    };
    const dstKey = this.keyForDomain(packet.dstDomain);
    if (!dstKey || dstKey === chainKey || packet.tokenId !== this.config.tokenId) throw reject("unsupported packet route");
    const id = this.store.transferId(chainKey, packet.id);
    const existing = this.store.getTransfer(id);
    if (existing) return existing;
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
    return transfer;
  }

  // ---------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------

  async processPending() {
    const pending = this.store.pendingTransfers().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 32);
    for (const transfer of pending) {
      await this.processTransfer(transfer).catch((err) => {
        const reason = err.shortMessage || err.reason || err.message || String(err);
        this.stats.lastError = reason;
        this.log(`${transfer.id}: ${reason}`);
        const current = this.store.getTransfer(transfer.id) || transfer;
        this.store.upsertTransfer(transfer.id, {
          error: reason.length > 180 ? `${reason.slice(0, 180)}…` : reason,
          attempts: Number(current.attempts || 0) + 1,
        });
      });
    }
  }

  async processTransfer(transfer) {
    const state = this.store.getTransfer(transfer.id);
    if (!state) return;
    if ([STATUS.ACKNOWLEDGED, STATUS.REFUNDED].includes(state.status)) return;
    if (!state.packet) return;

    const src = this.config.chains[state.srcChain];
    const dst = this.config.chains[state.dstChain];
    const dstBridge = this.bridges[state.dstChain];
    const srcBridge = this.bridges[state.srcChain];
    const packet = this.normalizePacket(state.packet);

    if (!this.isFunded(state.srcChain)) throw new Error(this.fundingError(state.srcChain));
    if (!this.isFunded(state.dstChain)) throw new Error(this.fundingError(state.dstChain));

    const confirmed = async (key, chain) => {
      const provider = this.providers[key];
      const height = Number(await provider.send("eth_blockNumber", [])) - chain.confirmations + 1;
      const block = await provider.getBlock(height);
      if (!block) throw new Error(`confirmed block unavailable: ${key}`);
      return block;
    };
    const srcBlock = await confirmed(state.srcChain, src);
    const srcAt = { blockTag: srcBlock.number };
    const status = await srcBridge.status(state.packetId, srcAt);
    if (status === 4n || status === 3n) {
      this.store.upsertTransfer(state.id, { status: status === 4n ? STATUS.REFUNDED : STATUS.ACKNOWLEDGED });
      return;
    }
    if (status !== 1n) throw new Error("source packet not confirmed");
    const dstBlock = await confirmed(state.dstChain, dst);
    const dstAt = { blockTag: dstBlock.number };
    const [begun, delivered, cancelled] = await Promise.all([
      srcBridge.deliveryStarted(state.packetId, srcAt),
      dstBridge.processed(state.packetId, dstAt), dstBridge.cancelled(state.packetId, dstAt),
    ]);
    if (delivered && !begun) throw new Error("inconsistent source reservation");
    if (delivered) {
      this.store.upsertTransfer(state.id, { status: STATUS.RECEIVED, error: null });
      return this.sendAck(this.store.getTransfer(state.id), true, "0x");
    }
    if (cancelled) {
      if (!begun) throw new Error("inconsistent destination cancellation");
      if (!(await srcBridge.ackFailed(state.packetId, srcAt))) {
        await this.sendAck(state, false, ethers.toUtf8Bytes("confirmed destination cancellation"));
      }
      return this.refund(this.store.getTransfer(state.id));
    }
    if (!begun && srcBlock.timestamp > packet.timeout) return this.refund(state);
    if (!begun && dstBlock.timestamp > packet.timeout) {
      this.store.upsertTransfer(state.id, { error: null });
      return;
    }
    const digest = await dstBridge.attestationDigest(packet);
    const signature = this.attestorWallet.signingKey.sign(digest).serialized;
    const sender = dstBridge.connect(this.relayerWallets[state.dstChain]);
    if (!begun) {
      // Do not reserve a packet that already fails destination simulation.
      await sender.receivePacket.staticCall(packet, [signature]);
      const tx = await this.run(state.srcChain, async () => {
        const sent = await srcBridge.connect(this.relayerWallets[state.srcChain]).beginDelivery(state.packetId);
        await this.wait(sent, src.confirmations);
        return sent;
      });
      this.store.upsertTransfer(state.id, { txs: { begin: tx.hash }, error: null });
    }
    if (dstBlock.timestamp > packet.timeout) {
      const tx = await this.run(state.dstChain, async () => {
        const sent = await sender.cancelPacket(packet, [signature]);
        await this.wait(sent, dst.confirmations);
        return sent;
      });
      this.store.upsertTransfer(state.id, { txs: { cancel: tx.hash }, error: null });
      return;
    }
    const tx = await this.run(state.dstChain, async () => {
      const sent = await sender.receivePacket(packet, [signature]);
      await this.wait(sent, dst.confirmations);
      return sent;
    });
    this.store.upsertTransfer(state.id, { status: STATUS.RECEIVED, error: null, receivedAt: new Date().toISOString(), txs: { receive: tx.hash } });
    this.store.save();
    this.stats.relayed += 1;
    await this.sendAck(this.store.getTransfer(state.id), true, "0x");
  }

  async wait(tx, confirmations) {
    const receipt = await tx.wait(confirmations, 90000);
    if (!receipt || receipt.status !== 1) throw new Error("transaction not confirmed");
    return receipt;
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
    const srcBridge = this.bridges[state.srcChain];
    try {
      this.log(`${state.id}: ack submitting on ${state.srcChain}`);
      const tx = await this.run(state.srcChain, async () => {
        const sent = await srcBridge
          .connect(this.relayerWallets[state.srcChain])
          .acknowledge(state.packetId, success, reason, { gasLimit: 300000 });
        await this.wait(sent, this.config.chains[state.srcChain].confirmations);
        return sent;
      });
      this.store.upsertTransfer(state.id, {
        status: success ? STATUS.ACKNOWLEDGED : STATUS.FAILED,
        acknowledgedAt: new Date().toISOString(),
        error: null,
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
      const tx = await this.run(state.srcChain, async () => {
        const sent = await srcBridge.connect(this.relayerWallets[state.srcChain]).refund(state.packetId, { gasLimit: 300000 });
        await this.wait(sent, this.config.chains[state.srcChain].confirmations);
        return sent;
      });
      this.store.upsertTransfer(state.id, {
        status: STATUS.REFUNDED,
        refundedAt: new Date().toISOString(),
        error: null,
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
    const fresh = !!this.stats.lastTickAt &&
      Date.now() - Date.parse(this.stats.lastTickAt) < Math.max(180000, this.config.pollMs * 3);
    const funded = Object.fromEntries(
      Object.entries(this.config.chains).map(([key]) => [key, this.isFunded(key)])
    );
    return {
      ok: this.ready && !this.stats.lastError && fresh,
      ready: this.ready,
      protocolVersion: 2,
      relayerAddress: this.relayerAddress || null,
      attestorAddress: this.attestorWallet?.address || null,
      service: "roundtrip-relayer",
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: this.stats.startedAt,
      lastTickAt: this.stats.lastTickAt,
      lastError: this.stats.lastError,
      relayed: this.stats.relayed,
      refunded: this.stats.refunded,
      pending: this.store.pendingTransfers().length,
      funded,
      gas: this.gas,
      chains: Object.fromEntries(
        Object.entries(this.config.chains).map(([key, chain]) => [
          key,
          { chainId: chain.chainId, bridge: chain.bridge, token: chain.token?.address || chain.token, cursor: this.store.getCursor(key) },
        ])
      ),
    };
  }
}

module.exports = { Relayer, STATUS };
