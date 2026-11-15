#!/usr/bin/env bash
# Definition-of-done run on live Hemi testnet:
#   docker compose up → attest three fresh manifests → one BatchAttested tx → hemi-confirmed
#   → stop the service → verify each receipt with only an RPC and the registry address.
#
#   scripts/testnet-demo.sh            (needs .env from scripts/testnet-deploy.sh and .secrets/testnet-agent.json)
#
# Costs one attestBatch on testnet (~0.0000002 ETH from the relayer). Writes everything to
# demo/testnet-<timestamp>/.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env: run scripts/testnet-deploy.sh first" >&2; exit 2; }
[ -f .secrets/testnet-agent.json ] || { echo "missing .secrets/testnet-agent.json (cast wallet new --json)" >&2; exit 2; }
[ -f cli/dist/index.js ] || { echo "run npm run build first" >&2; exit 2; }
field() { jq -r ".data | if type==\"array\" then .[0].$2 else .$2 end" ".secrets/$1.json"; }
AGENT=$(field testnet-agent address)
export AGENT_PRIVATE_KEY=$(field testnet-agent private_key)
REGISTRY=$(grep '^REGISTRY_ADDRESS=' .env | cut -d= -f2)
RPC=https://testnet.rpc.hemi.network/rpc
SERVICE=http://127.0.0.1:8787
OUT=demo/testnet-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
exec > >(tee "$OUT/run.log") 2>&1   # everything printed below is also kept in $OUT/run.log
receipts() { node cli/dist/index.js "$@"; }
log() { printf '\n[demo] %s\n' "$*" >&2; }

log "1. docker compose up (service against registry $REGISTRY on Hemi testnet)"
# Uses the existing image (compose builds it if it is missing). After changing service code,
# run `docker compose build` first, or set BUILD=1.
if [ "${BUILD:-0}" = 1 ]; then docker compose build receipts; fi
trap 'docker compose stop receipts >/dev/null 2>&1 || true' EXIT   # a failed run must not leave the service up
docker compose up -d receipts
for _ in $(seq 1 60); do curl -sf $SERVICE/health >/dev/null 2>&1 && break; sleep 2; done
curl -sf $SERVICE/health | jq -c '{ok, chainId, registry, serviceSigner, relayer, devFree}'

log "2. three fresh manifests from examples/trace.jsonl (agent $AGENT)"
for n in 1 2 3; do
  receipts from-trace examples/trace.jsonl --agent "$AGENT" --run-id "0x$(openssl rand -hex 32)" -o "$OUT/manifest-$n.json"
done

log "3. receipts attest (waits for the batch to be mined; batches close after 60 s)"
receipts attest "$OUT"/manifest-{1,2,3}.json --service $SERVICE --wait=hemi-included --timeout 600 --out "$OUT/receipts" --json | tee "$OUT/attest.json"
jq -r '.[].runId' "$OUT/attest.json" > "$OUT/run-ids.txt"
[ "$(wc -l < "$OUT/run-ids.txt" | tr -d ' ')" = 3 ] || { echo "expected three receipt ids" >&2; exit 1; }

log "4. one BatchAttested tx contains all three"
TXS=$(for f in "$OUT"/receipts/*.receipt.json; do jq -r .anchor.txHash "$f"; done | sort -u)
BATCHES=$(for f in "$OUT"/receipts/*.receipt.json; do jq -r .anchor.batchId "$f"; done | sort -u)
[ "$(echo "$TXS" | wc -l | tr -d ' ')" = 1 ] || { echo "receipts are in more than one tx: $TXS" >&2; exit 1; }
[ "$(echo "$BATCHES" | wc -l | tr -d ' ')" = 1 ] || { echo "receipts are in more than one batch: $BATCHES" >&2; exit 1; }
BATCH=$BATCHES
GETBATCH='getBatch(uint256)((bytes32,uint32,uint16,bool,address,uint64,uint64))'
echo "tx      $TXS"
echo "explorer https://testnet.explorer.hemi.xyz/tx/$TXS"
echo "batch   $BATCH: $(cast call "$REGISTRY" "$GETBATCH" "$BATCH" --rpc-url $RPC)"
# The anchoring tx must carry exactly one BatchAttested(batchId, root, signer, count, schemaVersion), with count 3.
TOPIC=$(cast keccak 'BatchAttested(uint256,bytes32,address,uint32,uint16)')
cast receipt "$TXS" --rpc-url $RPC --json > "$OUT/anchor-tx-receipt.json"
jq -c '{status, blockNumber, gasUsed, logs: (.logs | length)}' "$OUT/anchor-tx-receipt.json"
EVENTS=$(jq --arg r "$(echo "$REGISTRY" | tr 'A-F' 'a-f')" --arg t "$TOPIC" '[.logs[] | select((.address | ascii_downcase) == $r and .topics[0] == $t)]' "$OUT/anchor-tx-receipt.json")
[ "$(echo "$EVENTS" | jq length)" = 1 ] || { echo "expected exactly one BatchAttested log in $TXS" >&2; exit 1; }
COUNT=$(cast abi-decode --input 'f(uint32,uint16)' "$(echo "$EVENTS" | jq -r '.[0].data')" | head -1)
EVENT_BATCH=$(cast to-dec "$(echo "$EVENTS" | jq -r '.[0].topics[1]')")
echo "BatchAttested: batchId $EVENT_BATCH, count $COUNT"
[ "$COUNT" = 3 ] && [ "$EVENT_BATCH" = "$BATCH" ] || { echo "BatchAttested says batch $EVENT_BATCH count $COUNT; expected batch $BATCH count 3" >&2; exit 1; }

log "5. receipts status, until the SERVICE reports each as at least hemi-confirmed"
# --no-btc shows the service's own status (its poller), not a local re-check by the CLI.
for id in $(cat "$OUT/run-ids.txt"); do
  for _ in $(seq 1 90); do
    STAGE=$(receipts status "$id" --service $SERVICE --no-btc --json | jq -r .stage)
    case "$STAGE" in hemi-confirmed|btc-published|btc-final) break ;; esac
    sleep 10
  done
  receipts status "$id" --service $SERVICE | tee "$OUT/status-$id.txt"
  case "$STAGE" in hemi-confirmed|btc-published|btc-final) ;; *) echo "$id stuck at $STAGE" >&2; exit 1 ;; esac
done

log "6. stop the service, then verify with only an RPC and the registry address"
docker compose stop receipts
if curl -sf --max-time 5 $SERVICE/health >/dev/null 2>&1; then echo "the service still answers after docker compose stop" >&2; exit 1; fi
echo "service stopped: $SERVICE/health no longer answers"
for f in "$OUT"/receipts/*.receipt.json; do
  receipts verify "$f" --rpc $RPC --registry "$REGISTRY" | tee "$OUT/verify-$(basename "$f" .receipt.json).txt"
done
log "7. tampered copies must fail verification, each with a reason (service still stopped)"
F=$(ls "$OUT"/receipts/*.receipt.json | head -1)
jq '.manifest.model |= .[:-1] + "X"' "$F" > "$OUT/tamper-one-byte.receipt.json"
FORGED=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signReceipt, registryDomain } from '@hemi-receipts/sdk';
const f = JSON.parse(readFileSync(process.argv[1], 'utf8'));
console.log(await signReceipt(privateKeyToAccount(generatePrivateKey()), f.receipt, registryDomain(f.chainId, f.registry)));
" "$F")
jq --arg s "$FORGED" '.agentSignature = $s' "$F" > "$OUT/tamper-forged-signature.receipt.json"
CASES="one-byte forged-signature"
if [ "$BATCH" -gt 1 ]; then
  # Point the receipt at the previous batch (its real root, tx and block), keeping this batch's proof.
  PREV=$((BATCH - 1))
  PREV_ROOT=$(cast call "$REGISTRY" "$GETBATCH" "$PREV" --rpc-url $RPC | sed 's/^(//' | cut -d, -f1)
  PREV_BLOCK=$(cast call "$REGISTRY" "$GETBATCH" "$PREV" --rpc-url $RPC | awk -F', ' '{print $7}' | awk '{print $1}' | tr -d ')')
  PREV_TX=$(cast logs --from-block "$PREV_BLOCK" --to-block "$PREV_BLOCK" --address "$REGISTRY" "$TOPIC" --rpc-url $RPC --json | jq -r '.[0].transactionHash')
  jq --argjson b "$PREV" --arg r "$PREV_ROOT" --arg t "$PREV_TX" --argjson n "$PREV_BLOCK" \
    '.anchor.batchId = $b | .anchor.root = $r | .anchor.txHash = $t | .anchor.blockNumber = $n' "$F" > "$OUT/tamper-wrong-batch.receipt.json"
  CASES="$CASES wrong-batch"
fi
for c in $CASES; do
  set +e
  receipts verify "$OUT/tamper-$c.receipt.json" --rpc $RPC --registry "$REGISTRY" > "$OUT/verify-tamper-$c.txt" 2>&1
  CODE=$?
  set -e
  echo "tamper $c: exit $CODE; $(sed -n '/^INVALID/{n;p;}' "$OUT/verify-tamper-$c.txt" | head -1)"
  [ "$CODE" = 1 ] || { echo "tampered receipt ($c) did not fail with exit 1" >&2; exit 1; }
done
log "done: $OUT"
