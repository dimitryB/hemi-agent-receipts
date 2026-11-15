#!/usr/bin/env bash
# The direct path on live Hemi testnet: the service countersigns a receipt, the caller sends the
# transaction itself, the service detects it, and the receipt verifies with the service stopped.
#
#   scripts/testnet-direct-demo.sh     (needs .env, .secrets/testnet-agent.json and .secrets/testnet-relayer.json)
#
# The registry takes attest() from any wallet. The relayer sends it here only because it is the one
# funded demo wallet; its key is read inside the node process and never reaches a command line.
# Costs one attest on testnet. Writes everything to demo/testnet-direct-<timestamp>/.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env: run scripts/testnet-deploy.sh first" >&2; exit 2; }
[ -f .secrets/testnet-agent.json ] || { echo "missing .secrets/testnet-agent.json (cast wallet new --json)" >&2; exit 2; }
[ -f .secrets/testnet-relayer.json ] || { echo "missing .secrets/testnet-relayer.json" >&2; exit 2; }
[ -f cli/dist/index.js ] || { echo "run npm run build first" >&2; exit 2; }
field() { jq -r ".data | if type==\"array\" then .[0].$2 else .$2 end" ".secrets/$1.json"; }
AGENT=$(field testnet-agent address)
export AGENT_PRIVATE_KEY=$(field testnet-agent private_key)
REGISTRY=$(grep '^REGISTRY_ADDRESS=' .env | cut -d= -f2)
RPC=https://testnet.rpc.hemi.network/rpc
SERVICE=http://127.0.0.1:8787
OUT=demo/testnet-direct-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT/receipts"
exec > >(tee "$OUT/run.log") 2>&1   # everything printed below is also kept in $OUT/run.log
receipts() { node cli/dist/index.js "$@"; }
log() { printf '\n[demo] %s\n' "$*" >&2; }

log "1. docker compose up (service against registry $REGISTRY on Hemi testnet)"
if [ "${BUILD:-0}" = 1 ]; then docker compose build receipts; fi
trap 'docker compose stop receipts >/dev/null 2>&1 || true' EXIT   # a failed run must not leave the service up
docker compose up -d receipts
for _ in $(seq 1 60); do curl -sf $SERVICE/health >/dev/null 2>&1 && break; sleep 2; done
curl -sf $SERVICE/health | jq -c '{ok, chainId, registry, serviceSigner, relayer, devFree}'

log "2. one fresh manifest from examples/trace.jsonl (agent $AGENT)"
ID=0x$(openssl rand -hex 32)
receipts from-trace examples/trace.jsonl --agent "$AGENT" --run-id "$ID" -o "$OUT/manifest.json"

log "3. receipts attest --direct: the service countersigns, the CLI writes the calldata"
receipts attest "$OUT/manifest.json" --direct --service $SERVICE --out "$OUT/receipts" --json | tee "$OUT/attest.json"
ATTEST=$OUT/receipts/$ID.attest.json
[ -f "$ATTEST" ] || { echo "no $ATTEST: the direct answer carried no calldata" >&2; exit 1; }
[ "$(jq -r .to "$ATTEST" | tr 'A-F' 'a-f')" = "$(echo "$REGISTRY" | tr 'A-F' 'a-f')" ] || { echo "calldata is not addressed to the registry" >&2; exit 1; }

log "4. send the calldata as the caller's own transaction"
TX=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const [file, rpc] = process.argv.slice(1);
const { to, data } = JSON.parse(readFileSync(file, 'utf8'));
const secret = JSON.parse(readFileSync('.secrets/testnet-relayer.json', 'utf8')).data;
const account = privateKeyToAccount((Array.isArray(secret) ? secret[0] : secret).private_key);
const hash = await createWalletClient({ account, transport: http(rpc) }).sendTransaction({ to, data, chain: null });
const receipt = await createPublicClient({ transport: http(rpc) }).waitForTransactionReceipt({ hash, timeout: 300_000 });
if (receipt.status !== 'success') throw new Error('attest reverted in ' + hash);
console.log(hash);
" "$ATTEST" "$RPC")
echo "tx      $TX"
echo "explorer https://testnet.explorer.hemi.xyz/tx/$TX"

log "5. receipts status, until the SERVICE has detected the tx and reports at least hemi-confirmed"
for _ in $(seq 1 90); do
  STAGE=$(receipts status "$ID" --service $SERVICE --no-btc --json | jq -r .stage)
  case "$STAGE" in hemi-confirmed|btc-published|btc-final) break ;; esac
  sleep 10
done
receipts status "$ID" --service $SERVICE | tee "$OUT/status-$ID.txt"
case "$STAGE" in hemi-confirmed|btc-published|btc-final) ;; *) echo "$ID stuck at $STAGE" >&2; exit 1 ;; esac
F=$OUT/receipts/$ID.receipt.json
receipts fetch "$ID" --service $SERVICE -o "$F" --manifest "$OUT/manifest.json"
jq -c '.anchor | {mode, batchId, txHash, blockNumber}' "$F"
[ "$(jq -r .anchor.mode "$F")" = direct ] || { echo "the receipt was not anchored directly" >&2; exit 1; }
[ "$(jq -r .anchor.txHash "$F")" = "$TX" ] || { echo "the receipt names another transaction than $TX" >&2; exit 1; }

log "6. stop the service, then verify with only an RPC and the registry address"
docker compose stop receipts
if curl -sf --max-time 5 $SERVICE/health >/dev/null 2>&1; then echo "the service still answers after docker compose stop" >&2; exit 1; fi
echo "service stopped: $SERVICE/health no longer answers"
receipts verify "$F" --rpc $RPC --registry "$REGISTRY" | tee "$OUT/verify-$ID.txt"
log "done: $OUT"
