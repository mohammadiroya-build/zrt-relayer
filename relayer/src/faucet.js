const { ethers } = require("ethers");
const { bridgeAbi, tokenAbi } = require("./abi");

const MAX_SIGNATURE_AGE_MS = 15 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const MIN_TREASURY_GAS = ethers.parseEther("0.0003");

class Faucet {
  constructor(config, store, chainProviders, log = console.log, queue = null) {
    this.config = config;
    this.store = store;
    this.providers = chainProviders;
    this.log = (msg) => log(`[faucet] ${msg}`);
    this.queue = queue || ((key, fn) => fn());
    this.chainKey = config.faucet.chain;
    this.chain = config.chains[this.chainKey];
    this.wallet = config.keys.treasury ? new ethers.Wallet(config.keys.treasury, this.providers[this.chainKey]) : null;
    this.sharedKey = false;
    if (this.wallet && config.keys.relayer) {
      // Sharing one key is acceptable on a testnet only because every write is serialized.
      this.sharedKey = this.wallet.address === new ethers.Wallet(config.keys.relayer).address;
      if (this.sharedKey) this.log("treasury and relayer share a key; faucet writes are queued");
    }
    this.token = this.wallet
      ? new ethers.Contract(this.chain.token.address, tokenAbi, this.wallet)
      : null;

    // The relayer also holds the attestor key, so the bridge on this chain will
    // accept a packet it signs. That lets an unfunded deployment hand out the
    // faucet amount instead of stalling on an empty treasury.
    this.mintable = false;
    this.bridge = null;
    if (config.faucet.mintFallback && this.wallet && config.keys.attestor) {
      const bridgeAddress = this.chain.bridge;
      const peer = Object.values(config.chains).find((c) => c.key !== this.chainKey && c.bridge);
      if (bridgeAddress && peer) {
        this.bridge = new ethers.Contract(bridgeAddress, bridgeAbi, this.wallet);
        this.peerChain = peer;
        this.mintable = true;
      }
    }
    this.attestorWallet = config.keys.attestor ? new ethers.Wallet(config.keys.attestor) : null;
    this.inflight = false;
  }

  message({ address, nonce, issued }) {
    return `Zenith RoundTrip faucet\naddress: ${address.toLowerCase()}\nnonce: ${nonce}\nissued: ${issued}`;
  }

  async treasuryBalance() {
    if (!this.token) return null;
    const balance = await this.token.balanceOf(this.wallet.address);
    return ethers.formatUnits(balance, this.config.decimals);
  }

  async treasuryGas() {
    if (!this.wallet) return null;
    return this.providers[this.chainKey].getBalance(this.wallet.address);
  }

  async mint(recipient, amount) {
    const now = Math.floor(Date.now() / 1000);
    const packet = {
      id: ethers.hexlify(ethers.randomBytes(32)),
      srcDomain: BigInt(this.peerChain.domain),
      dstDomain: BigInt(this.chain.domain),
      srcBridge: this.peerChain.bridge,
      sender: this.wallet.address,
      recipient,
      tokenId: this.config.tokenId,
      amount,
      timeout: BigInt(now + this.config.routeTimeout),
      sequence: 0n,
    };
    const digest = await this.bridge.attestationDigest(packet);
    const signature = this.attestorWallet.signingKey.sign(digest).serialized;
    this.log(`issuing ${this.config.faucet.amount} ${this.config.symbol} for ${recipient}`);
    return this.bridge.receivePacket(packet, [signature], { gasLimit: 260000 });
  }

  async status(address) {
    const normalized = ethers.getAddress(address);
    const last = this.store.lastClaim(normalized);
    const cooldownMs = this.config.faucet.cooldownHours * 3600 * 1000;
    const nextAt = last ? new Date(new Date(last.at).getTime() + cooldownMs) : null;
    const amount = ethers.parseUnits(this.config.faucet.amount, this.config.decimals);

    let balance = null;
    let balanceError = null;
    let gas = null;
    let gasError = null;
    if (this.token) {
      balance = await this.token.balanceOf(this.wallet.address).catch((err) => {
        balanceError = err.shortMessage || err.message;
        return null;
      });
      gas = await this.treasuryGas().catch((err) => {
        gasError = err.shortMessage || err.message;
        return null;
      });
    }

    const source = balance !== null && balance >= amount ? "treasury" : this.mintable ? "mint" : null;

    let reason = null;
    if (!this.config.faucet.enabled) reason = "faucet is disabled for this deployment";
    else if (!this.token) reason = "faucet treasury key is not configured";
    else if (balanceError || gasError) reason = "faucet treasury is unreachable";
    else if (!source) reason = "faucet treasury is empty";
    else if (gas === null || gas < MIN_TREASURY_GAS) reason = `faucet treasury needs ${this.chain.nativeSymbol} for gas`;
    else if (nextAt && nextAt > new Date()) reason = `next claim available at ${nextAt.toISOString()}`;

    const eligible = !reason;
    const nonceRecord = eligible ? this.store.issueNonce(normalized, NONCE_TTL_MS) : null;
    const issued = nonceRecord ? new Date(nonceRecord.issuedAt).toISOString() : new Date().toISOString();

    return {
      enabled: this.config.faucet.enabled,
      eligible,
      reason,
      amount: this.config.faucet.amount,
      symbol: this.config.symbol,
      chain: this.chainKey,
      cooldownHours: this.config.faucet.cooldownHours,
      nextEligibleAt: nextAt ? nextAt.toISOString() : null,
      lastClaimAt: last ? last.at : null,
      lastTx: last ? last.tx : null,
      nonce: nonceRecord ? nonceRecord.nonce : null,
      issued,
      message: nonceRecord ? this.message({ address: normalized, nonce: nonceRecord.nonce, issued }) : null,
      treasuryBalance: balance === null ? null : ethers.formatUnits(balance, this.config.decimals),
      source: source || null,
    };
  }

  async claim({ address, signature, nonce, issued }) {
    if (!this.config.faucet.enabled) throw httpError(503, "faucet is disabled");
    if (!this.token) throw httpError(503, "faucet treasury key is not configured");
    let normalized;
    try {
      normalized = ethers.getAddress(address);
    } catch {
      throw httpError(400, "invalid address");
    }
    if (!signature || !nonce || !issued) throw httpError(400, "signature, nonce and issued are required");

    const issuedAt = new Date(issued).getTime();
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > MAX_SIGNATURE_AGE_MS) {
      throw httpError(400, "signature expired, request a new one");
    }
    const expected = this.store.peekNonce(normalized);
    if (!expected || expected.nonce !== nonce) throw httpError(400, "nonce mismatch, request a new one");
    if (Date.now() - Number(expected.issuedAt) > NONCE_TTL_MS) throw httpError(400, "nonce expired, request a new one");

    const message = this.message({ address: normalized, nonce, issued });
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      throw httpError(400, "invalid signature");
    }
    if (recovered !== normalized) throw httpError(403, "signature does not match the wallet");

    if (this.inflight) throw httpError(429, "another claim is in progress; try again shortly");
    this.inflight = true;
    try {
      const last = this.store.lastClaim(normalized);
      if (last && Date.now() - Date.parse(last.at) < this.config.faucet.cooldownHours * 3600000) {
        throw httpError(429, "faucet cooldown active");
      }
      const balance = await this.token.balanceOf(this.wallet.address);
      const amount = ethers.parseUnits(this.config.faucet.amount, this.config.decimals);
      const fromTreasury = balance >= amount;
      if (!fromTreasury && !this.mintable) throw httpError(503, "treasury is empty");
      const gas = await this.treasuryGas();
      if (gas < MIN_TREASURY_GAS) throw httpError(503, `treasury needs ${this.chain.nativeSymbol} for gas`);
      this.store.consumeNonce(normalized);
      this.store.save();

      const tx = await this.queue(this.chainKey, async () => {
        const sent = fromTreasury
          ? await this.token.transfer(normalized, amount, { gasLimit: 120000 })
          : await this.mint(normalized, amount);
        const receipt = await sent.wait(this.chain.confirmations, 90000);
        if (!receipt || receipt.status !== 1) throw new Error(fromTreasury ? "transfer reverted" : "issue reverted");
        return sent;
      });

      this.store.recordClaim(normalized, {
        at: new Date().toISOString(),
        tx: tx.hash,
        amount: this.config.faucet.amount,
        chain: this.chainKey,
      });
      this.store.save();
      this.log(`${this.config.faucet.amount} ${this.config.symbol} -> ${normalized} (${tx.hash})`);

      return {
        ok: true,
        txHash: tx.hash,
        explorerUrl: `${this.chain.explorer}/tx/${tx.hash}`,
        amount: this.config.faucet.amount,
        symbol: this.config.symbol,
        chain: this.chainKey,
        nextEligibleAt: new Date(Date.now() + this.config.faucet.cooldownHours * 3600 * 1000).toISOString(),
      };
    } finally {
      this.inflight = false;
    }
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { Faucet, httpError };
