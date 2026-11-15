/**
 * Pre-deployment guard for a ReceiptRegistry Ignition parameter file.
 *
 *   node scripts/check-deploy-params.mjs ignition/parameters/hemi-testnet.json
 *
 * `owner` and `serviceSigner` are constructor arguments. The contract is not
 * upgradeable and ownership cannot be renounced, so deploying with the example
 * addresses would hand the incident-response key to an address nobody controls.
 * The service signer can be rotated later, but only by that owner.
 *
 * When the file name contains "mainnet" the script also refuses unless the
 * environment has CONFIRM_MAINNET_DEPLOY=yes.
 *
 * Run before `hardhat ignition deploy`. Exits non-zero on any problem.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getAddress, isAddress } from "viem";

const PARAMETERS_PATH = process.argv[2];
const MODULE = "ReceiptRegistryModule";
const PLACEHOLDERS = new Set([
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x0000000000000000000000000000000000000000",
]);

if (!PARAMETERS_PATH) {
  console.error("Usage: node scripts/check-deploy-params.mjs <ignition parameter file>");
  process.exit(1);
}

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(PARAMETERS_PATH, "utf8"));
} catch (error) {
  console.error(`Could not read ${PARAMETERS_PATH}: ${error.message}`);
  console.error("Copy the matching ignition/parameters/*.example.json and fill in real values.");
  process.exit(1);
}

const params = parsed?.[MODULE];
if (!params || typeof params !== "object") {
  console.error(`${PARAMETERS_PATH} has no "${MODULE}" section.`);
  process.exit(1);
}

const { owner, serviceSigner } = params;

for (const key of Object.keys(params)) {
  if (key !== "owner" && key !== "serviceSigner") {
    fail(`unexpected parameter "${key}". ${MODULE} takes only owner and serviceSigner.`);
  }
}

for (const [name, value] of Object.entries({ owner, serviceSigner })) {
  // strict: false accepts an all-lowercase or all-uppercase address; a mixed-case one
  // must still carry a correct EIP-55 checksum, or isAddress rejects it.
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    fail(`${name} is not a valid address: ${JSON.stringify(value)}`);
    continue;
  }
  if (value !== value.toLowerCase() && value.slice(2) !== value.slice(2).toUpperCase() && !isAddress(value)) {
    fail(`${name} has a mixed-case spelling with a wrong EIP-55 checksum: ${value}`);
    continue;
  }
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    fail(`${name} is still a placeholder or the zero address (${value}).`);
  }
  if (value !== getAddress(value)) {
    notes.push(`${name} is not checksummed. ${getAddress(value)} is the checksummed form.`);
  }
}

if (
  typeof owner === "string" &&
  typeof serviceSigner === "string" &&
  isAddress(owner, { strict: false }) &&
  isAddress(serviceSigner, { strict: false }) &&
  owner.toLowerCase() === serviceSigner.toLowerCase()
) {
  // The point of the split is that a compromised service key cannot administer the
  // contract. The constructor rejects this too, after the deployer has paid for gas.
  fail("owner and serviceSigner are the same address. They must be separate accounts.");
}

const isMainnet = basename(PARAMETERS_PATH).toLowerCase().includes("mainnet");
if (isMainnet && process.env.CONFIRM_MAINNET_DEPLOY !== "yes") {
  fail(
    "this is a mainnet parameter file. Re-run with CONFIRM_MAINNET_DEPLOY=yes once the owner " +
      "(ideally a multisig) and the service signer have been double-checked.",
  );
}

if (notes.length > 0) {
  console.log("Notes:");
  for (const note of notes) console.log(`  - ${note}`);
}

if (problems.length > 0) {
  console.error(`\n${PARAMETERS_PATH} is not safe to deploy:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\nThe owner is permanent unless it transfers ownership itself. Fix these before deploying.");
  process.exit(1);
}

console.log(`${PARAMETERS_PATH} checks out${isMainnet ? " (mainnet, confirmed)" : ""}:`);
console.log(`  owner          ${getAddress(owner)}`);
console.log(`  serviceSigner  ${getAddress(serviceSigner)}`);
