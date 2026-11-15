// Minimal Hemi BFG v1 public-websocket client (no dependencies, Node >= 22).
// Usage: node bfg-v1-probe.mjs wss://pop.hemi.network/v1/ws/public [cmd ...]
// Protocol (heminetwork v1.6.3 api/protocol + api/auth/secp256k1.go):
//   every frame is JSON {"header":{"command":<string>,"id":<string>},"payload":<object>}
//   1. client -> secp256k1-hello {publickey: <33-byte compressed hex>, userAgent}
//   2. server -> secp256k1-hello-challenge {message: hex(nonce16 || "Hello: <pub>\nMessage: I am not a robot!\n")}
//   3. client -> secp256k1-hello-challenge-accepted {signature: hex(compact65(sha256(message bytes)))}
//   4. server -> bfgapi-ping-request; then client may send public commands.
import { createHash, randomBytes } from 'node:crypto';

// ---- tiny secp256k1 (BigInt) ----
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
           0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
const inv = (a, m = P) => { let [x, y, u, v] = [mod(a, m), m, 1n, 0n]; while (x) { const q = y / x; [x, y, u, v] = [y - q * x, x, v - q * u, u]; } return mod(v, m); };
const add = (A, B) => { if (!A) return B; if (!B) return A;
  if (A[0] === B[0]) { if (mod(A[1] + B[1]) === 0n) return null; const l = mod(3n * A[0] * A[0] * inv(2n * A[1])); const x = mod(l * l - 2n * A[0]); return [x, mod(l * (A[0] - x) - A[1])]; }
  const l = mod((B[1] - A[1]) * inv(B[0] - A[0])); const x = mod(l * l - A[0] - B[0]); return [x, mod(l * (A[0] - x) - A[1])]; };
const mul = (k, Pt = G) => { let R = null; while (k > 0n) { if (k & 1n) R = add(R, Pt); Pt = add(Pt, Pt); k >>= 1n; } return R; };
const big = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const hex32 = (n) => n.toString(16).padStart(64, '0');
const priv = mod(big(randomBytes(32)), N - 1n) + 1n;           // throwaway identity
const pubPt = mul(priv);
const pubHex = (pubPt[1] & 1n ? '03' : '02') + hex32(pubPt[0]);
function signCompact(hash) {                                       // dcrecdsa.SignCompact(..., compressed=true)
  const z = big(hash);
  for (;;) {
    const k = mod(big(randomBytes(32)), N - 1n) + 1n; const R = mul(k);
    const r = mod(R[0], N); if (!r) continue;
    let s = mod(inv(k, N) * (z + r * priv), N); if (!s) continue;
    let recid = Number(R[1] & 1n);
    if (s > N / 2n) { s = N - s; recid ^= 1; }
    return (27 + recid + 4).toString(16) + hex32(r) + hex32(s);
  }
}

// ---- protocol ----
const url = process.argv[2] ?? 'wss://pop.hemi.network/v1/ws/public';
const extra = process.argv.slice(3);
const ws = new WebSocket(url);
const send = (command, id, payload) => { const m = JSON.stringify({ header: { command, id }, payload }); console.log('>>', m); ws.send(m); };
let reqId = 0;
const queue = [
  ['bfgapi-bitcoin-info-request', {}],
  ['bfgapi-l2-keystones-request', { num_l2_keystones: 3 }],
  ...extra.map((c) => [c.split('=')[0], JSON.parse(c.split('=').slice(1).join('=') || '{}')]),
];
const next = () => { const q = queue.shift(); if (!q) { setTimeout(() => ws.close(), 500); return; } send(q[0], String(++reqId), q[1]); };
ws.onopen = () => send('secp256k1-hello', 'Hello:' + pubHex, { userAgent: 'hemi-agent-receipts-research/0.1', publickey: pubHex });
ws.onmessage = async (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString();
  console.log('<<', text.length > 2000 ? text.slice(0, 2000) + '...[' + text.length + ' bytes]' : text);
  const m = JSON.parse(text);
  switch (m.header.command) {
    case 'secp256k1-hello-challenge': {
      const msg = Buffer.from(m.payload.message, 'hex');
      const sig = signCompact(createHash('sha256').update(msg).digest());
      send('secp256k1-hello-challenge-accepted', 'HelloChallengeAccepted:' + pubHex, { signature: sig });
      break;
    }
    case 'bfgapi-ping-request':
      // NOTE: do NOT answer the server ping: the v1 public read loop treats
      // bfgapi-ping-response as an unknown command and closes the socket.
      if (reqId === 0) next();
      break;
    default:
      if (m.header.command.endsWith('-response')) next();
  }
};
ws.onclose = (ev) => console.log('closed', ev.code, ev.reason);
ws.onerror = (ev) => console.log('error', ev.message ?? ev);
setTimeout(() => { console.log('timeout'); process.exit(0); }, 30000).unref();
