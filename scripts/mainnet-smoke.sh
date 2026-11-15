#!/usr/bin/env bash
# Mainnet smoke test (docs/RUNBOOK.md §7): three paid receipts in one BatchAttested transaction,
# hemi-confirmed, then verified with the service stopped.
#
#   scripts/mainnet-smoke.sh                             preflight only: reads the chain, sends nothing
#   CONFIRM_MAINNET_SMOKE=yes scripts/mainnet-smoke.sh   the paid run: real mainnet transactions
#
# Needs .secrets/mainnet.env (the service's settings), .secrets/mainnet-agent.json (the buyer),
# `npm run build`, and the x402 facilitator on FACILITATOR_URL with its mainnet signer
# (in ../x402facilitator: FACILITATOR_CONFIG=config.mainnet.json docker compose up -d).
# The run costs the buyer 3 × PRICE_BATCH (0.003 USDC.e, paid to PAY_TO), the facilitator three
# settlements and the relayer one attestBatch. The service runs from service/dist on loopback
# with its own database (DB_PATH), apart from the testnet container. Keys are read in-process or
# from files and never reach a command line or the log. Writes everything to
# demo/mainnet-smoke-<timestamp>/.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=.secrets/mainnet.env
AGENT_FILE=.secrets/mainnet-agent.json
[ -f "$ENV" ] || { echo "missing $ENV" >&2; exit 2; }
[ -f "$AGENT_FILE" ] || { echo "missing $AGENT_FILE (cast wallet new --json)" >&2; exit 2; }
[ -f cli/dist/index.js ] && [ -f service/dist/index.js ] || { echo "run npm run build first" >&2; exit 2; }
setting() { grep "^$1=" "$ENV" | cut -d= -f2-; }
REGISTRY=$(setting REGISTRY_ADDRESS)
PAY_TO=$(setting PAY_TO)
PORT=$(setting PORT)
DB_PATH=$(setting DB_PATH)
RPC=$(setting HEMI_RPC_URLS | cut -d, -f1)
SERVICE=http://127.0.0.1:$PORT
EXPLORER=https://explorer.hemi.xyz
USDC=0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA
receipts() { node cli/dist/index.js "$@"; }
log() { printf '\n[smoke] %s\n' "$*" >&2; }
# The public RPC drops a request now and then; retry reads with a short backoff.
retry() { local i; for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 2)); done; return 1; }
usdc() { retry cast call $USDC 'balanceOf(address)(uint256)' "$1" --rpc-url "$RPC" | awk '{print $1}'; }

log "preflight (reads only)"
node scripts/mainnet-smoke-check.mjs "$ENV" "$AGENT_FILE"
if curl -sf --max-time 3 "$SERVICE/health" >/dev/null 2>&1; then echo "something already answers on $SERVICE; stop it first" >&2; exit 2; fi
if [ "${CONFIRM_MAINNET_SMOKE:-}" != yes ]; then
  log "nothing was sent. The paid run: CONFIRM_MAINNET_SMOKE=yes scripts/mainnet-smoke.sh"
  exit 0
fi

OUT=demo/mainnet-smoke-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT" "$(dirname "$DB_PATH")"
exec > >(tee "$OUT/run.log") 2>&1   # everything printed below is also kept in $OUT/run.log
field() { jq -r ".data | if type==\"array\" then .[0].$1 else .$1 end" "$AGENT_FILE"; }
AGENT=$(field address)
AGENT_PRIVATE_KEY=$(field private_key)
export AGENT_PRIVATE_KEY X402_PRIVATE_KEY=$AGENT_PRIVATE_KEY

log "1. start the service on $SERVICE against registry $REGISTRY (DEV_FREE unset: every receipt is paid)"
node --env-file="$ENV" service/dist/index.js > "$OUT/service.log" 2>&1 &
SVC=$!
# A failed run must not leave the service up. SIGTERM lets it finish any paid request (up to 185 s).
trap 'kill $SVC 2>/dev/null || true; wait $SVC 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -sf "$SERVICE/health" >/dev/null 2>&1 && break
  kill -0 $SVC 2>/dev/null || { echo "the service exited:" >&2; tail -20 "$OUT/service.log" >&2; exit 1; }
  sleep 1
done
HEALTH=$(curl -sf "$SERVICE/health")
echo "$HEALTH" | jq -c '{ok, chainId, registry, serviceSigner, relayer, devFree}'
[ "$(echo "$HEALTH" | jq -r .chainId)" = 43111 ] || { echo "the service is not on chain 43111" >&2; exit 1; }
[ "$(echo "$HEALTH" | jq -r .devFree)" = false ] || { echo "the service runs with DEV_FREE: receipts would not be paid" >&2; exit 1; }
[ "$(echo "$HEALTH" | jq -r .registry | tr 'A-F' 'a-f')" = "$(echo "$REGISTRY" | tr 'A-F' 'a-f')" ] || { echo "the service names another registry" >&2; exit 1; }

BUYER_BEFORE=$(usdc "$AGENT")
PAY_TO_BEFORE=$(usdc "$PAY_TO")
echo "USDC.e before: buyer $AGENT $BUYER_BEFORE, PAY_TO $PAY_TO $PAY_TO_BEFORE (base units)"

log "2. three fresh manifests from examples/trace.jsonl (agent $AGENT)"
for n in 1 2 3; do
  receipts from-trace examples/trace.jsonl --agent "$AGENT" --run-id "0x$(openssl rand -hex 32)" -o "$OUT/manifest-$n.json"
done

log "3. receipts attest: each 402 is paid with x402 (EIP-3009 USDC.e), then it waits for hemi-confirmed"
receipts attest "$OUT"/manifest-{1,2,3}.json --service "$SERVICE" --wait=hemi-confirmed --timeout 1500 --out "$OUT/receipts" --json | tee "$OUT/attest.json"
jq -r '.[].runId' "$OUT/attest.json" > "$OUT/run-ids.txt"
[ "$(wc -l < "$OUT/run-ids.txt" | tr -d ' ')" = 3 ] || { echo "expected three receipt ids" >&2; exit 1; }

log "4. one BatchAttested transaction holds all three"
TXS=$(for f in "$OUT"/receipts/*.receipt.json; do jq -r .anchor.txHash "$f"; done | sort -u)
BATCHES=$(for f in "$OUT"/receipts/*.receipt.json; do jq -r .anchor.batchId "$f"; done | sort -u)
[ "$(echo "$TXS" | wc -l | tr -d ' ')" = 1 ] || { echo "receipts are in more than one tx: $TXS" >&2; exit 1; }
[ "$(echo "$BATCHES" | wc -l | tr -d ' ')" = 1 ] || { echo "receipts are in more than one batch: $BATCHES" >&2; exit 1; }
BATCH=$BATCHES
echo "tx       $TXS"
echo "explorer $EXPLORER/tx/$TXS"
TOPIC=$(cast keccak 'BatchAttested(uint256,bytes32,address,uint32,uint16)')
retry cast receipt "$TXS" --rpc-url "$RPC" --json > "$OUT/anchor-tx-receipt.json"
jq -c '{status, blockNumber, gasUsed, from, logs: (.logs | length)}' "$OUT/anchor-tx-receipt.json"
EVENTS=$(jq --arg r "$(echo "$REGISTRY" | tr 'A-F' 'a-f')" --arg t "$TOPIC" '[.logs[] | select((.address | ascii_downcase) == $r and .topics[0] == $t)]' "$OUT/anchor-tx-receipt.json")
[ "$(echo "$EVENTS" | jq length)" = 1 ] || { echo "expected exactly one BatchAttested log in $TXS" >&2; exit 1; }
COUNT=$(cast abi-decode --input 'f(uint32,uint16)' "$(echo "$EVENTS" | jq -r '.[0].data')" | head -1)
EVENT_BATCH=$(cast to-dec "$(echo "$EVENTS" | jq -r '.[0].topics[1]')")
echo "BatchAttested: batchId $EVENT_BATCH, count $COUNT"
[ "$COUNT" = 3 ] && [ "$EVENT_BATCH" = "$BATCH" ] || { echo "BatchAttested says batch $EVENT_BATCH count $COUNT; expected batch $BATCH count 3" >&2; exit 1; }

log "5. the payments: the buyer paid 3 × the batch price to PAY_TO"
grep -E "payment settled" "$OUT/service.log" | sed -E 's/^.*(runId=0x[0-9a-f]{8})[0-9a-f]*.*(tx=0x[0-9a-f]{64}).*$/\1… \2/' || true
BUYER_AFTER=$(usdc "$AGENT")
PAY_TO_AFTER=$(usdc "$PAY_TO")
echo "USDC.e after:  buyer $BUYER_AFTER (−$((BUYER_BEFORE - BUYER_AFTER))), PAY_TO $PAY_TO_AFTER (+$((PAY_TO_AFTER - PAY_TO_BEFORE)))"
[ $((PAY_TO_AFTER - PAY_TO_BEFORE)) -ge 3000 ] || echo "note: PAY_TO grew by less than 3000 base units; check the settlements above" >&2

log "6. stop the service, then verify with only an RPC and the registry address"
kill $SVC; wait $SVC 2>/dev/null || true
if curl -sf --max-time 5 "$SERVICE/health" >/dev/null 2>&1; then echo "the service still answers after it was stopped" >&2; exit 1; fi
echo "service stopped: $SERVICE/health no longer answers"
for f in "$OUT"/receipts/*.receipt.json; do
  receipts verify "$f" --rpc "$RPC" --registry "$REGISTRY" | tee "$OUT/verify-$(basename "$f" .receipt.json).txt"
done
F=$(ls "$OUT"/receipts/*.receipt.json | head -1)
log "7. the SDK's known deployment: verify without --registry"
receipts verify "$F" --rpc "$RPC" | tee "$OUT/verify-known-deployment.txt"
log "done: $OUT"
