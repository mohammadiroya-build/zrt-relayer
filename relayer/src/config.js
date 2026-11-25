const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../.env")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
    return file;
  }
  return null;
}

loadDotEnv();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findConfigFile() {
  const candidates = [
    process.env.CONFIG_PATH,
    path.resolve(process.cwd(), "config/config.json"),
    path.resolve(__dirname, "../../config/config.json"),
    path.resolve(__dirname, "../../web/config.json"),
    path.resolve(__dirname, "../config.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error("config.json not found. Run the deployment script or set CONFIG_PATH.");
}

const configFile = findConfigFile();
const app = readJson(configFile);

const chains = {};
for (const [key, chain] of Object.entries(app.chains)) {
  chains[key] = {
    ...chain,
    rpcUrl: process.env[`${key.toUpperCase()}_RPC_URL`] || chain.rpcUrl,
    confirmations: Number(process.env.CONFIRMATIONS || chain.confirmations || 1),
  };
}
if (Object.keys(chains).length !== 2 || Object.values(chains).some((c) =>
  !Number.isSafeInteger(c.confirmations) || c.confirmations < 1)) {
  throw new Error("Exactly two chains with positive confirmation counts are required");
}

const port = Number(process.env.PORT || 8787);

module.exports = {
  port,
  configFile,
  bridgeEnabled: app.version === 2 && app.bridgeEnabled === true,
  tokenId: app.route.tokenId,
  symbol: app.route.symbol,
  decimals: app.route.decimals,
  chains,
  expectedRoles: { attestor: app.relayer && app.relayer.attestorAddress, relayer: app.relayer && app.relayer.address },
  defaultRoute: app.defaultRoute,
  faucet: {
    enabled: process.env.FAUCET_ENABLED !== "false" && app.faucet.enabled !== false,
    amount: process.env.FAUCET_AMOUNT || app.faucet.amount || "1",
    cooldownHours: Number(process.env.FAUCET_COOLDOWN_HOURS || app.faucet.cooldownHours || 24),
    chain: process.env.FAUCET_CHAIN || app.defaultRoute.from,
  },
  keys: {
    attestor: process.env.ATTESTOR_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || "",
    relayer: process.env.RELAYER_PRIVATE_KEY || process.env.ATTESTOR_PRIVATE_KEY || "",
    treasury: process.env.TREASURY_PRIVATE_KEY || "",
  },
  pollMs: Number(process.env.POLL_MS || 30000),
  startBlockOffset: Number(process.env.START_BLOCK_OFFSET || 5000),
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, "../data"),
  cors: process.env.CORS_ORIGIN || "*",
};
