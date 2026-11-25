const fs = require("fs");
const path = require("path");

/**
 * Small JSON store. One relayer process owns the file, writes are atomic
 * (write temp file, rename) so a restart never leaves a half-written state.
 */
class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "state.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this.load();
    this.dirty = false;
  }

  load() {
    const empty = { transfers: {}, cursors: {}, faucet: { claims: {}, nonces: {} } };
    if (!fs.existsSync(this.file)) return empty;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { ...empty, ...parsed, faucet: { ...empty.faucet, ...(parsed.faucet || {}) } };
    } catch {
      return empty;
    }
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  // transfers -----------------------------------------------------------
  transferId(srcChain, packetId) {
    return `${srcChain}:${packetId}`;
  }

  upsertTransfer(id, patch) {
    const existing = this.state.transfers[id] || { id, createdAt: new Date().toISOString(), attempts: 0, txs: {} };
    this.state.transfers[id] = {
      ...existing,
      ...patch,
      txs: { ...existing.txs, ...(patch.txs || {}) },
      updatedAt: new Date().toISOString(),
    };
    this.dirty = true;
    return this.state.transfers[id];
  }

  getTransfer(id) {
    return this.state.transfers[id] || null;
  }

  listTransfers({ address, limit = 25 } = {}) {
    const all = Object.values(this.state.transfers);
    const filtered = address
      ? all.filter(
          (t) =>
            t.sender?.toLowerCase() === address.toLowerCase() ||
            t.recipient?.toLowerCase() === address.toLowerCase()
        )
      : all;
    return filtered
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.min(Number(limit) || 25, 100));
  }

  pendingTransfers() {
    return Object.values(this.state.transfers).filter((t) =>
      ["sent", "received", "failed"].includes(t.status)
    );
  }

  // cursors -------------------------------------------------------------
  getCursor(chain) {
    return this.state.cursors[chain] ?? null;
  }

  setCursor(chain, block) {
    if (this.state.cursors[chain] === block) return;
    this.state.cursors[chain] = block;
    this.dirty = true;
  }

  // faucet --------------------------------------------------------------
  lastClaim(address) {
    return this.state.faucet.claims[address.toLowerCase()] || null;
  }

  recordClaim(address, claim) {
    this.state.faucet.claims[address.toLowerCase()] = claim;
    this.dirty = true;
  }

  /** Reuses a still-fresh nonce so polling status twice cannot invalidate the first message. */
  issueNonce(address, ttlMs = 10 * 60 * 1000) {
    const key = address.toLowerCase();
    const existing = this.state.faucet.nonces[key];
    const now = Date.now();
    if (existing && typeof existing === "object" && now - Number(existing.issuedAt) < ttlMs) {
      return existing;
    }
    const record = { nonce: require("crypto").randomBytes(16).toString("hex"), issuedAt: now };
    this.state.faucet.nonces[key] = record;
    this.dirty = true;
    this.save();
    return record;
  }

  peekNonce(address) {
    return this.state.faucet.nonces[address.toLowerCase()] || null;
  }

  consumeNonce(address) {
    delete this.state.faucet.nonces[address.toLowerCase()];
    this.dirty = true;
  }
}

module.exports = { Store };
