#!/usr/bin/env bash
# Deploys ReceiptRegistry to Hemi testnet, verifies its source on Blockscout, reads every
# privileged value back, and writes the service's .env.
#
#   scripts/testnet-deploy.sh --fork   rehearsal on an anvil fork of Hemi testnet (sends nothing live)
#   scripts/testnet-deploy.sh          live testnet deployment (needs a funded relayer, docs/DECISIONS.md D-9)
#
# Keys come from .secrets/testnet-{owner,service,relayer}.json (cast wallet new --json).
# The relayer pays for the deployment; owner and service signer are constructor arguments,
# so the paying account holds no authority over the contract.
#
# The committed deployment (Ignition id receipts-hemi-testnet, parameters hemi-testnet.json) is
# this project's own record, and is used only with its own owner and service signer. Any other
# keys get a deployment of their own: id ${DEPLOYMENT_ID:-receipts-hemi-testnet-<owner's first
# 8 hex digits>} and parameters/<id>.json (both gitignored), so Ignition never takes it for a
# change to the committed one.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=live
[[ "${1:-}" == "--fork" ]] && MODE=fork
LIVE_RPC="${HEMI_TESTNET_RPC_URL:-https://testnet.rpc.hemi.network/rpc}"
EXPLORER=https://testnet.explorer.hemi.xyz
MIN_BALANCE_WEI=500000000000000   # 0.0005 ETH

field() { jq -r ".data | if type==\"array\" then .[0].$2 else .$2 end" ".secrets/$1.json"; }
for role in owner service relayer; do
  [[ -f ".secrets/testnet-$role.json" ]] || { echo "missing .secrets/testnet-$role.json (cast wallet new --json > .secrets/testnet-$role.json)" >&2; exit 2; }
done
OWNER=$(field testnet-owner address)
SERVICE=$(field testnet-service address)
RELAYER=$(field testnet-relayer address)
RELAYER_KEY=$(field testnet-relayer private_key)
SERVICE_KEY=$(field testnet-service private_key)

lower() { echo "$1" | tr 'A-F' 'a-f'; }
OFFICIAL=contracts/ignition/parameters/hemi-testnet.json
if [[ "$(lower "$OWNER")" == "$(lower "$(jq -r .ReceiptRegistryModule.owner "$OFFICIAL")")" &&
      "$(lower "$SERVICE")" == "$(lower "$(jq -r .ReceiptRegistryModule.serviceSigner "$OFFICIAL")")" ]]; then
  LIVE_ID=receipts-hemi-testnet
else
  LIVE_ID=${DEPLOYMENT_ID:-receipts-hemi-testnet-$(lower "${OWNER:2:8}")}
  if [[ "$LIVE_ID" == receipts-hemi-testnet ]]; then
    echo "deployment id receipts-hemi-testnet is the committed deployment, with another owner and service signer; pick another DEPLOYMENT_ID" >&2
    exit 2
  fi
fi

if [[ "$MODE" == fork ]]; then
  PORT=8546
  anvil --fork-url "$LIVE_RPC" --chain-id 743111 --port $PORT --silent &
  ANVIL_PID=$!
  trap 'kill $ANVIL_PID 2>/dev/null || true; rm -rf contracts/ignition/deployments/receipts-hemi-testnet-fork contracts/ignition/parameters/receipts-hemi-testnet-fork.json' EXIT
  RPC="http://127.0.0.1:$PORT"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
  cast rpc anvil_setBalance "$RELAYER" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null   # 1 ETH on the fork only
  DEPLOYMENT_ID=receipts-hemi-testnet-fork
  VERIFY=()
else
  RPC="$LIVE_RPC"
  DEPLOYMENT_ID=$LIVE_ID
  VERIFY=()   # Hardhat's Blockscout verifier gets HTTP 403 from this explorer (DECISIONS.md D-10); verified below via the v2 API
fi

# The committed deployment keeps its committed parameters file; every other one writes its own.
PARAMS_NAME=$([[ "$DEPLOYMENT_ID" == receipts-hemi-testnet ]] && echo hemi-testnet.json || echo "$DEPLOYMENT_ID.json")
PARAMS=contracts/ignition/parameters/$PARAMS_NAME

echo "mode      $MODE"
echo "ignition  deployment $DEPLOYMENT_ID, parameters $PARAMS"
echo "rpc       $RPC (chain $(cast chain-id --rpc-url "$RPC"))"
echo "owner     $OWNER"
echo "service   $SERVICE"
echo "relayer   $RELAYER (deployer, pays gas)"

BALANCE=$(cast balance "$RELAYER" --rpc-url "$RPC")
echo "relayer balance $(cast from-wei "$BALANCE") ETH"
if [[ "$(echo "$BALANCE < $MIN_BALANCE_WEI" | bc)" == 1 ]]; then
  echo "The relayer needs at least 0.0005 testnet ETH (0.002 recommended). Send it to $RELAYER:" >&2
  echo "  Sepolia ETH from a faucet, tunneled at https://app.hemi.xyz/en/tunnel/?networkType=testnet" >&2
  exit 2
fi

mkdir -p "$(dirname "$PARAMS")"
cat > "$PARAMS" <<JSON
{
  "ReceiptRegistryModule": {
    "owner": "$OWNER",
    "serviceSigner": "$SERVICE"
  }
}
JSON
node contracts/scripts/check-deploy-params.mjs "$PARAMS"

(
  cd contracts
  HARDHAT_IGNITION_CONFIRM_DEPLOYMENT=yes HEMI_TESTNET_RPC_URL="$RPC" HEMI_TESTNET_DEPLOYER_PRIVATE_KEY="$RELAYER_KEY" \
    npx hardhat ignition deploy --network hemiTestnet --build-profile production \
    --parameters "ignition/parameters/$PARAMS_NAME" --deployment-id "$DEPLOYMENT_ID" \
    ${VERIFY[@]+"${VERIFY[@]}"} ignition/modules/ReceiptRegistry.ts
)

DEPLOYED="contracts/ignition/deployments/$DEPLOYMENT_ID/deployed_addresses.json"
REGISTRY=$(jq -r '."ReceiptRegistryModule#ReceiptRegistry"' "$DEPLOYED")
DEPLOY_TX=$(jq -r 'select(.type=="TRANSACTION_CONFIRM" or .type=="ONCHAIN_INTERACTION_SUCCESS" or .type=="DEPLOYMENT_EXECUTION_STATE_COMPLETE") | (.hash // .receipt.transactionHash // empty)' "contracts/ignition/deployments/$DEPLOYMENT_ID/journal.jsonl" 2>/dev/null | tail -1)
DEPLOY_BLOCK=""
if [[ -n "$DEPLOY_TX" ]]; then DEPLOY_BLOCK=$(cast receipt "$DEPLOY_TX" blockNumber --rpc-url "$RPC"); fi

echo
echo "== read-back from chain =="
fail=0
check() { # name expected actual   (cast may append " [6.553e4]"; compare the first word)
  set -- "$1" "$2" "${3%% *}"
  if [[ "$(echo "$2" | tr 'A-F' 'a-f')" == "$(echo "$3" | tr 'A-F' 'a-f')" ]]; then echo "ok    $1 = $3"; else echo "FAIL  $1 = $3 (expected $2)"; fail=1; fi
}
check registry-code "nonempty" "$( [[ $(cast code "$REGISTRY" --rpc-url "$RPC") != 0x ]] && echo nonempty || echo empty)"
check owner "$OWNER" "$(cast call "$REGISTRY" 'owner()(address)' --rpc-url "$RPC")"
check serviceSigner "$SERVICE" "$(cast call "$REGISTRY" 'serviceSigner()(address)' --rpc-url "$RPC")"
check "schemaVersionEnabled(1)" true "$(cast call "$REGISTRY" 'schemaVersionEnabled(uint16)(bool)' 1 --rpc-url "$RPC")"
check paused false "$(cast call "$REGISTRY" 'paused()(bool)' --rpc-url "$RPC")"
check pendingOwner 0x0000000000000000000000000000000000000000 "$(cast call "$REGISTRY" 'pendingOwner()(address)' --rpc-url "$RPC")"
check MAX_DEADLINE_WINDOW 3600 "$(cast call "$REGISTRY" 'MAX_DEADLINE_WINDOW()(uint64)' --rpc-url "$RPC")"
check MAX_BATCH_COUNT 65536 "$(cast call "$REGISTRY" 'MAX_BATCH_COUNT()(uint32)' --rpc-url "$RPC")"
check batchCount 0 "$(cast call "$REGISTRY" 'batchCount()(uint256)' --rpc-url "$RPC")"
if [[ "$MODE" == live ]]; then
  # Blockscout v2 standard-input verification, with the exact solc input of the production build.
  BUILD_INFO_ID=$(jq -r '.buildInfoId' contracts/artifacts/contracts/ReceiptRegistry.sol/ReceiptRegistry.json)
  BUILD_INFO="contracts/artifacts/build-info/$BUILD_INFO_ID.json"
  INPUT_JSON=$(mktemp -t receipts-standard-input).json
  jq '.input' "$BUILD_INFO" > "$INPUT_JSON"
  SOLC="v$(jq -r '.solcLongVersion' "$BUILD_INFO")"
  ARGS=$(cast abi-encode "constructor(address,address)" "$OWNER" "$SERVICE" | sed 's/^0x//')
  curl -s -X POST "$EXPLORER/api/v2/smart-contracts/$REGISTRY/verification/via/standard-input" \
    -F "compiler_version=$SOLC" -F "contract_name=ReceiptRegistry" -F "license_type=mit" \
    -F "autodetect_constructor_args=false" -F "constructor_args=$ARGS" \
    -F "files[0]=@$INPUT_JSON;type=application/json"; echo
  rm -f "$INPUT_JSON"
  for _ in $(seq 1 20); do
    VERIFIED=$(curl -s "$EXPLORER/api/v2/smart-contracts/$REGISTRY" | jq -r '.is_verified // false')
    [[ "$VERIFIED" == true ]] && break; sleep 6
  done
  check "explorer is_verified" true "$VERIFIED"
fi
[[ $fail == 0 ]] || { echo "read-back failed; do not use this deployment" >&2; exit 1; }

echo
echo "registry      $REGISTRY"
echo "deploy tx     ${DEPLOY_TX:-unknown}"
echo "deploy block  ${DEPLOY_BLOCK:-unknown}"
[[ "$MODE" == live ]] && echo "explorer      $EXPLORER/address/$REGISTRY"

if [[ "$MODE" == live ]]; then
  # The backup holds the same keys: readable by its owner only, and gitignored (.env.*).
  [[ -f .env ]] && (umask 077 && cp .env ".env.bak.$(date +%s)" && chmod 600 .env.bak.*)
  cat > .env <<ENV
# Written by scripts/testnet-deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Secrets: never commit.
CHAIN_ID=743111
HEMI_RPC_URLS=$LIVE_RPC
REGISTRY_ADDRESS=$REGISTRY
REGISTRY_DEPLOY_BLOCK=${DEPLOY_BLOCK:-0}
SERVICE_PRIVATE_KEY=$SERVICE_KEY
RELAYER_PRIVATE_KEY=$RELAYER_KEY
DEV_FREE=1
PAY_TO=$OWNER
FACILITATOR_URL=http://host.docker.internal:8080
ENV
  chmod 600 .env
  echo "wrote .env (DEV_FREE=1; unset it to require x402 payment)"
fi
