#!/usr/bin/env bash
# Pays for one receipt with x402 and settles it through x402facilitator, entirely on
# local anvil forks of Hemi. Nothing touches a live network, and only anvil's public dev keys
# are used: owner #0, service #1, relayer #2, agent and buyer #3 (funded by the facilitator
# project's fork script), payTo #5.
#
#   scripts/x402-fork-demo.sh
#
# Needs https://github.com/dimitryB/x402facilitator cloned at ${X402_FACILITATOR_DIR:-../x402facilitator}, its facilitator
# image built (docker compose build there), Foundry, jq and a built repo (npm run build).
# If port 8080 is taken, set FACILITATOR_PORT: the facilitator's compose file and this script both use it.
# Its scratch state is deleted on success; set KEEP_STATE=1 to keep it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
FAC=${X402_FACILITATOR_DIR:-$ROOT/../x402facilitator}
STATE=$(mktemp -d -t receipts-x402-demo)
export FORK_STATE_DIR=$STATE/fork          # keeps the facilitator project's own folder clean
mkdir -p "$FORK_STATE_DIR"
RPC=http://127.0.0.1:${FORK_TESTNET_PORT:-8545}
PORT=${DEMO_SERVICE_PORT:-8788}
SERVICE_URL=http://127.0.0.1:$PORT
FAC_URL=http://127.0.0.1:${FACILITATOR_PORT:-8080}   # the facilitator compose file reads the same variable
USDC=0xD47971C7F5B1067d25cd45d30b2c9eb60de96443
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # anvil #1 (service)
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # anvil #2 (relayer)
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6   # anvil #3 (agent, buyer)
AGENT=0x90F79bf6EB2c4f870365E785982E1f101E93b906
PAY_TO=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc                        # anvil #5
SERVICE_PID=""
OK=0

log() { printf '[demo] %s\n' "$*" >&2; }
cleanup() {
  [ -n "$SERVICE_PID" ] && kill "$SERVICE_PID" 2>/dev/null || true
  (cd "$FAC" && docker compose -f docker-compose.yml -f docker-compose.fork.yml down >/dev/null 2>&1) || true
  (cd "$FAC" && scripts/fork.sh down >/dev/null 2>&1) || true
  # Keep the scratch state (service log, receipts) after a failure or with KEEP_STATE=1.
  if [ "$OK" = 1 ] && [ "${KEEP_STATE:-0}" != 1 ]; then
    case "$STATE" in */receipts-x402-demo.*) rm -rf "$STATE" ;; esac
  else
    log "state kept in $STATE"
  fi
}
trap cleanup EXIT

[ -d "$FAC" ] || { log "facilitator project not found at $FAC (set X402_FACILITATOR_DIR)"; exit 2; }
[ -f service/dist/index.js ] && [ -f cli/dist/index.js ] || { log "run npm run build first"; exit 2; }

log "1/6 forking Hemi testnet and mainnet (the facilitator project's scripts/fork.sh)"
(cd "$FAC" && scripts/fork.sh up)

log "2/6 starting x402facilitator against the forks"
(cd "$FAC" && docker compose -f docker-compose.yml -f docker-compose.fork.yml up -d)
for _ in $(seq 1 60); do
  curl -sf "$FAC_URL/supported" | jq -e '.kinds[] | select(.network=="eip155:743111")' >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$FAC_URL/supported" | jq -c '[.kinds[] | {scheme, network}]'

log "3/6 deploying ReceiptRegistry on the testnet fork"
read -r REGISTRY DEPLOY_BLOCK < <(npx tsx scripts/deploy-local.ts "$RPC")
log "registry $REGISTRY (block $DEPLOY_BLOCK)"

log "4/6 starting the receipts service with x402 on (DEV_FREE unset)"
env -u DEV_FREE CHAIN_ID=743111 HEMI_RPC_URLS="$RPC" REGISTRY_ADDRESS="$REGISTRY" REGISTRY_DEPLOY_BLOCK="$DEPLOY_BLOCK" \
  SERVICE_PRIVATE_KEY=$K1 RELAYER_PRIVATE_KEY=$K2 DB_PATH="$STATE/receipts.sqlite" PORT=$PORT \
  PAY_TO=$PAY_TO FACILITATOR_URL=$FAC_URL BATCH_MAX_WAIT_SECONDS=5 POLL_INTERVAL_SECONDS=2 FINALITY=off \
  node service/dist/index.js > "$STATE/service.log" 2>&1 &
SERVICE_PID=$!
for _ in $(seq 1 60); do curl -sf "$SERVICE_URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$SERVICE_URL/health" | jq -c '{ok, chainId, registry, devFree}'

log "5/6 attesting a fresh manifest; the CLI pays the 402 with x402 (Permit2, USDC.e)"
RUN_ID=0x$(openssl rand -hex 32)
node cli/dist/index.js from-trace examples/trace.jsonl --agent $AGENT --run-id "$RUN_ID" -o "$STATE/manifest.json"
BEFORE=$(cast call $USDC 'balanceOf(address)(uint256)' $PAY_TO --rpc-url "$RPC" | awk '{print $1}')
AGENT_PRIVATE_KEY=$K3 X402_PRIVATE_KEY=$K3 X402_RPC_URL="$RPC" \
  node cli/dist/index.js attest "$STATE/manifest.json" --service "$SERVICE_URL" --approve-permit2 \
  --wait=hemi-included --timeout 180 --out "$STATE/receipts"
AFTER=$(cast call $USDC 'balanceOf(address)(uint256)' $PAY_TO --rpc-url "$RPC" | awk '{print $1}')

log "6/6 results"
echo "payTo USDC.e base units: $BEFORE -> $AFTER (price 1000)"
grep -E "payment settled|settlement failed" "$STATE/service.log" | tail -3
jq -c '{runId: .receipt.runId, anchor: {batchId: .anchor.batchId, txHash: .anchor.txHash}}' "$STATE/receipts/$RUN_ID.receipt.json"
[ "$((AFTER - BEFORE))" -eq 1000 ] || { log "payTo did not receive exactly 1000"; exit 1; }
OK=1
log "settled through x402facilitator and anchored"
