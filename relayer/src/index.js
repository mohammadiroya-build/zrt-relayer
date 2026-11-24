const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
/* BigInt values are stored in transfer records; serialize them as strings. */
BigInt.prototype.toJSON = function () {
  return this.toString();
};

const config = require("./config");
const { Store } = require("./store");
const { Relayer } = require("./relay");
const { Faucet } = require("./faucet");

const store = new Store(config.dataDir);
const relayer = new Relayer(config, store);
relayer.init();

const faucet = new Faucet(config, store, relayer.providers, console.log);
const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: config.cors }));
app.use(express.json({ limit: "64kb" }));

const startedAt = Date.now();

function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message || "internal error" });
    });
  };
}

app.get("/", (req, res) => {
  res.json({ service: "roundtrip-relayer", status: "ok", endpoints: ["/health", "/api/transfers", "/api/relay", "/api/faucet/status", "/api/faucet/claim"] });
});

app.get("/health", (req, res) => res.json({ ...relayer.health(), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
app.get("/api/health", (req, res) => res.redirect(307, "/health"));

app.get(
  "/api/config",
  asyncRoute(async (req, res) => {
    res.json({
      route: { tokenId: config.tokenId, symbol: config.symbol, decimals: config.decimals },
      chains: Object.fromEntries(
        Object.entries(config.chains).map(([key, chain]) => [
          key,
          { key, name: chain.name, chainId: chain.chainId, domain: chain.domain, bridge: chain.bridge, token: chain.token, explorer: chain.explorer },
        ])
      ),
      faucet: { enabled: config.faucet.enabled, amount: config.faucet.amount, cooldownHours: config.faucet.cooldownHours, chain: config.faucet.chain },
    });
  })
);

app.get(
  "/api/transfers",
  asyncRoute(async (req, res) => {
    const { address, limit } = req.query;
    if (address && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw Object.assign(new Error("invalid address"), { status: 400 });
    res.json({ transfers: store.listTransfers({ address, limit }) });
  })
);

app.get(
  "/api/transfers/:id",
  asyncRoute(async (req, res) => {
    const transfer = store.getTransfer(req.params.id);
    if (!transfer) throw Object.assign(new Error("transfer not found"), { status: 404 });
    res.json(transfer);
  })
);

app.post(
  "/api/relay",
  asyncRoute(async (req, res) => {
    const { chainId, txHash } = req.body || {};
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw Object.assign(new Error("valid txHash required"), { status: 400 });
    const chainKey =
      Object.keys(config.chains).find((key) => Number(config.chains[key].chainId) === Number(chainId)) || null;
    if (!chainKey) throw Object.assign(new Error("unknown chainId"), { status: 400 });

    const transfer = await relayer.enqueueFromTx(chainKey, txHash);
    res.json({ transfer });
  })
);

app.get(
  "/api/faucet/status",
  asyncRoute(async (req, res) => {
    const { address } = req.query;
    if (!address || !ethers.isAddress(address)) throw Object.assign(new Error("valid address required"), { status: 400 });
    res.json(await faucet.status(address));
  })
);

app.post(
  "/api/faucet/claim",
  asyncRoute(async (req, res) => {
    const { address, signature, nonce, issued } = req.body || {};
    const result = await faucet.claim({ address, signature, nonce, issued });
    res.json(result);
  })
);

app.use((req, res) => res.status(404).json({ error: "not found" }));

const server = app.listen(config.port, () => {
  console.log(`roundtrip relayer listening on ${config.port}`);
  console.log(`config: ${config.configFile}`);
  if (!config.keys.attestor || !config.keys.relayer) {
    console.error("ATTESTOR_PRIVATE_KEY / RELAYER_PRIVATE_KEY missing: relaying is disabled");
  } else {
    relayer.start();
  }
});

function shutdown(signal) {
  console.log(`${signal} received, saving state`);
  store.save(true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.parent === null;
