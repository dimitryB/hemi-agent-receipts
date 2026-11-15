# receipts (CLI)

```
receipts from-trace <trace.jsonl> [--agent ADDR] [--principal ADDR] [--model NAME] [--run-id HEX] [-o manifest.json]
receipts attest <manifest.json...> [--service URL] [--key-env NAME] [--chain-id N] [--registry ADDR]
                [--direct] [--store] [--wait[=STAGE]] [--timeout SEC] [--interval SEC] [--out DIR] [--json] [--approve-permit2]
receipts status <runId> [--service URL] [--rpc URL]... [--esplora URL]... [--pop-miner ADDR]... [--btc-scan N] [--no-btc] [--json]
receipts fetch <runId> [--service URL] [-o FILE] [--manifest FILE]
receipts verify <receipt.json> [--rpc URL]... [--registry ADDR] [--manifest FILE] [--confirmations N]
                [--esplora URL]... [--pop-miner ADDR]... [--btc-scan N] [--no-btc] [--json]
```

Exit status: 0 success / valid, 1 failed / invalid, 2 usage or runtime error (including an
RPC that could not be read during `verify`).

A typical run:

```sh
receipts from-trace examples/trace.jsonl -o run.json
AGENT_PRIVATE_KEY=0x… receipts attest run.json --wait --out receipts/   # prints "<runId> <status>"
receipts status 0x<runId>
receipts verify receipts/0x<runId>.receipt.json                         # chain only, no service
```

- **Service URL**: `--service`, else `RECEIPTS_SERVICE_URL`, else `http://localhost:8787`.
- **Signing**: `attest` signs with the key in the variable named by `--key-env` (default
  `AGENT_PRIVATE_KEY`); its address must be the manifest's agent or principal. The EIP-712
  domain (chain id, registry) comes from the service's `GET /health` unless both
  `--chain-id` and `--registry` are given.
- **`--direct`**: the service countersigns the receipt for your own transaction instead of
  batching it. The CLI writes `<runId>.attest.json` (`to`, `data`, `deadline`, signatures) to
  `--out`; send it from any wallet before the deadline, e.g. `cast send <to> <data>`. With
  `--wait` the CLI then waits for your transaction to be detected.
- **`--timeout SEC`**: the most `--wait` may take in total, across every receipt (default 600);
  `--interval SEC` is the pause between status reads (default 5). A receipt not there in time
  is reported with its last stage, and the command exits 1.
- **Payment (x402)**: on HTTP 402, with `X402_PRIVATE_KEY` set, `attest` pays with
  `@x402/fetch` and retries, capped at `X402_MAX_AMOUNT` base units per payment (default
  10000). Testnet USDC.e uses Permit2: the payer needs a one-time `approve(Permit2, max)`,
  which the CLI sends only with `--approve-permit2` (allowance read via `X402_RPC_URL` or the
  Hemi RPCs). Mainnet USDC.e uses EIP-3009 and needs no approval. Without `X402_PRIVATE_KEY`,
  `attest` stops and prints the price.
- **verify** never contacts the service. The registry comes from `--registry` or the SDK's
  known deployment for the file's chain (`DEPLOYMENTS`), never from the file; RPCs default to
  the network's public RPCs. It prints every check and the reasons for any failure.
- **Bitcoin finality** (`verify`, `status`): read from Bitcoin through Esplora with the SDK's
  per-network defaults; `--esplora`, `--pop-miner` and `--btc-scan` override them, `--no-btc`
  skips it. `status` re-checks an anchored receipt's stage locally (Hemi RPC + Bitcoin) and
  says what the service reported; with `--no-btc` it shows the service's status as is.
- `from-trace` follows `docs/SCHEMA.md` §6; errors name the trace line.

Tests: `npm test -w cli` (in-process runs against a fake service and anvil).
