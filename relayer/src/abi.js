// Minimal ABI fragments used by the relayer and the faucet.
const PACKET_COMPONENTS = [
  { name: "id", type: "bytes32" },
  { name: "srcDomain", type: "uint64" },
  { name: "dstDomain", type: "uint64" },
  { name: "srcBridge", type: "address" },
  { name: "sender", type: "address" },
  { name: "recipient", type: "address" },
  { name: "tokenId", type: "bytes32" },
  { name: "amount", type: "uint256" },
  { name: "timeout", type: "uint64" },
  { name: "sequence", type: "uint64" },
];

const bridgeAbi = [
  "event PacketSent(bytes32 indexed packetId, uint64 indexed dstDomain, address indexed sender, address recipient, bytes32 tokenId, uint256 amount, uint64 timeout, uint64 sequence)",
  "event PacketReceived(bytes32 indexed packetId, uint64 indexed srcDomain, address indexed recipient, address token, uint256 amount)",
  "event Acknowledgement(bytes32 indexed packetId, bool success, bytes reason)",
  "event Refunded(bytes32 indexed packetId, address indexed sender, uint256 amount, bool timedOut)",
  "function send(uint64 dstDomain, address recipient, bytes32 tokenId, uint256 amount, uint64 timeoutSeconds) returns (bytes32)",
  "function receivePacket(tuple(bytes32 id,uint64 srcDomain,uint64 dstDomain,address srcBridge,address sender,address recipient,bytes32 tokenId,uint256 amount,uint64 timeout,uint64 sequence) packet, bytes[] signatures)",
  "function acknowledge(bytes32 packetId, bool success, bytes reason)",
  "function refund(bytes32 packetId)",
  "function attestationDigest(tuple(bytes32 id,uint64 srcDomain,uint64 dstDomain,address srcBridge,address sender,address recipient,bytes32 tokenId,uint256 amount,uint64 timeout,uint64 sequence) packet) view returns (bytes32)",
  "function getPacket(bytes32 packetId) view returns (tuple(bytes32 id,uint64 srcDomain,uint64 dstDomain,address srcBridge,address sender,address recipient,bytes32 tokenId,uint256 amount,uint64 timeout,uint64 sequence))",
  "function processed(bytes32 packetId) view returns (bool)",
  "function refunded(bytes32 packetId) view returns (bool)",
  "function status(bytes32 packetId) view returns (uint8)",
  "function tokens(bytes32 tokenId) view returns (address)",
  "function peers(uint64 domain) view returns (address)",
  "function sendsPaused() view returns (bool)",
  "function threshold() view returns (uint256)",
  "function isAttestor(address account) view returns (bool)",
];

const tokenAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

module.exports = { bridgeAbi, tokenAbi, PACKET_COMPONENTS };
