# RoundTrip relayer

Packet relayer, attestation signer and faucet for the RoundTrip bridge between
Zenith EVM Testnet (936485) and Ethereum Sepolia (11155111).

Endpoints:

- `GET /health`
- `GET /api/transfers`
- `GET /api/transfers/:id`
- `POST /api/relay` with `{ chainId, txHash }`
- `GET /api/faucet/status?address=`
- `POST /api/faucet/claim`

Environment: `ATTESTOR_PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `TREASURY_PRIVATE_KEY`,
`ZENITH_RPC_URL`, `SEPOLIA_RPC_URL`, `PUBLIC_URL`, `DATA_DIR`, `CONFIG_PATH`, `PORT`.

`render.yaml` describes the free web service; `Dockerfile` builds the same thing for
any container host.
