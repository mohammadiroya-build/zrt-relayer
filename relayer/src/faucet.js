const { ethers } = require("ethers");
const { tokenAbi } = require("./abi");

const MAX_SIGNATURE_AGE_MS = 15 * 60 * 1000;

class Faucet {
  constructor(config, store, chainProviders, log = console.log) {
    this.config = config;
    this.store = store;
    this.providers = chainProviders;
    this.log = log;
    this.chainKey = config.faucet.chain;
    this.chain = config.chains[this.chainKey];
    this.wallet = config.keys.treasury ? new ethers.Wallet(config.keys.treasury, this.providers[this.chainKey]) : null;
    if (this.wallet && config.keys.relayer && this.wallet.address === new ethers.Wallet(config.keys.relayer).address) {
      throw new Error("Treasury and transaction relayer must use different wallets");
    }
    this.token = this.wallet
      ? new ethers.Contract(this.chain.token.address, tokenAbi, this.wallet)
      : null;
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

  async status(address) {
    const normalized = ethers.getAddress(address);
    const last = this.store.lastClaim(normalized);
    const cooldownMs = this.config.faucet.cooldownHours * 3600 * 1000;
    const nextAt = last ? new Date(new Date(last.at).getTime() + cooldownMs) : null;
    const eligible = this.config.faucet.enabled && !!this.token && (!nextAt || nextAt <= new Date());
    const nonce = this.config.faucet.enabled && eligible ? this.store.issueNonce(normalized) : null;
    const issued = new Date().toISOString();

    return {
      enabled: this.config.faucet.enabled,
      eligible,
      amount: this.config.faucet.amount,
      symbol: this.config.symbol,
      chain: this.chainKey,
      cooldownHours: this.config.faucet.cooldownHours,
      nextEligibleAt: nextAt ? nextAt.toISOString() : null,
      lastClaimAt: last ? last.at : null,
      lastTx: last ? last.tx : null,
      nonce,
      issued,
      message: nonce ? this.message({ address: normalized, nonce, issued }) : null,
      treasuryBalance: await this.treasuryBalance().catch(() => null),
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
    const expectedNonce = this.store.peekNonce(normalized);
    if (!expectedNonce || expectedNonce !== nonce) throw httpError(400, "nonce mismatch, request a new one");

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
      if (balance < amount) throw httpError(503, "treasury is empty");
      this.store.consumeNonce(normalized);
      this.store.save();

      const tx = await this.token.transfer(normalized, amount, { gasLimit: 120000 });
      const receipt = await tx.wait(this.chain.confirmations, 90000);
      if (!receipt || receipt.status !== 1) throw new Error("transfer reverted");

      this.store.recordClaim(normalized, {
        at: new Date().toISOString(),
        tx: tx.hash,
        amount: this.config.faucet.amount,
        chain: this.chainKey,
      });
      this.store.save();
      this.log(`faucet: ${this.config.faucet.amount} ${this.config.symbol} -> ${normalized} (${tx.hash})`);

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
