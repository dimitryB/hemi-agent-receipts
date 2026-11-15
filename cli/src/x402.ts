import { createWalletClient, custom, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createPermit2ApprovalTx, ExactEvmScheme, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
import { createHemiPublicClient, describePaymentRequired, pollTransactionReceipt, type FetchLike, type X402PaymentRequirements } from "@hemi-receipts/sdk";
import { Failure, UsageError } from "./io.js";

/**
 * Paying the service with x402 (the same flow as x402facilitator's buyer/pay.ts): the payment is
 * an off-chain signature that the service's facilitator settles. Permit2 assets (Hemi testnet
 * USDC.e) also need a one-time approve(Permit2, max) from the payer, which is sent only with
 * --approve-permit2. Mainnet USDC.e uses EIP-3009 and needs no approval.
 */

/** Default per-payment cap in base units: 0.01 of a 6-decimal stablecoin. */
export const DEFAULT_MAX_PAYMENT = 10_000n;
/** Hemi testnet never mines tips below the node's suggestion (0.001 gwei). */
const MIN_PRIORITY_FEE_WEI = 1_000_000n;

export interface PayingFetchOptions {
  privateKey: Hex;
  /** The requirements of the 402 that is being paid. */
  accepts: X402PaymentRequirements[];
  maxAmount: bigint;
  approvePermit2: boolean;
  /** RPC for the payment network (allowance reads, approval). Defaults to the Hemi network's RPCs. */
  rpcUrl?: string;
  baseFetch: FetchLike;
  log: (line: string) => void;
}

const amountOf = (r: X402PaymentRequirements): bigint => BigInt(r.amount ?? r.maxAmountRequired ?? "0");

export function parseKey(value: string | undefined, name: string): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new UsageError(`${name} must be a 0x-prefixed 32-byte hex private key`);
  return value as Hex;
}

export function createPayingFetch(options: PayingFetchOptions): FetchLike {
  const account = privateKeyToAccount(options.privateKey);
  const payable = options.accepts.filter((r) => r.scheme === "exact" && r.network.startsWith("eip155:"));
  if (payable.length === 0) {
    throw new Failure(`payment required, but no option is an x402 "exact" payment on an EVM chain: ${describePaymentRequired({ x402Version: 2, accepts: options.accepts })}`);
  }
  const affordable = payable.filter((r) => amountOf(r) <= options.maxAmount);
  if (affordable.length === 0) {
    throw new Failure(
      `the service asks ${describePaymentRequired({ x402Version: 2, accepts: payable })}, more than the per-payment cap of ${options.maxAmount} base units; raise it with X402_MAX_AMOUNT`,
    );
  }
  const matches = (r: { network: string; asset: string }) => affordable.some((a) => a.network === r.network && a.asset.toLowerCase() === r.asset.toLowerCase());

  const client = new x402Client()
    .register("eip155:*", new ExactEvmScheme(account))
    // Hemi assets are not x402 default assets: allow exactly the ones offered, capped.
    .setSpendControls({ allowedAssets: affordable.map((r) => ({ network: r.network as `${string}:${string}`, asset: r.asset, maxAmountPerPayment: options.maxAmount.toString() })) })
    .registerPolicy((_version, reqs) => reqs.filter(matches))
    .onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
      options.log(`paying ${req.amount} base units of ${req.asset} on ${req.network} to ${req.payTo} from ${account.address} (x402 ${req.extra?.assetTransferMethod ?? "eip3009"})`);
      if (req.extra?.assetTransferMethod === "permit2") await ensurePermit2Allowance(req as unknown as X402PaymentRequirements, account, options);
    });
  return wrapFetchWithPayment(options.baseFetch as typeof fetch, client) as FetchLike;
}

async function ensurePermit2Allowance(req: X402PaymentRequirements, account: ReturnType<typeof privateKeyToAccount>, options: PayingFetchOptions): Promise<void> {
  const chainId = Number(req.network.split(":")[1]);
  let client;
  try {
    client = createHemiPublicClient({ chainId, rpcUrls: options.rpcUrl ? [options.rpcUrl] : undefined });
  } catch {
    throw new Failure(`cannot check the Permit2 allowance on ${req.network}: no RPC known for chain ${chainId}; set X402_RPC_URL`);
  }
  const token = req.asset as Address;
  const allowance = await client.readContract(getPermit2AllowanceReadParams({ tokenAddress: token, ownerAddress: account.address }));
  if (allowance >= amountOf(req)) return;
  if (!options.approvePermit2) {
    throw new Failure(
      `payer ${account.address} has not approved Permit2 to spend ${token} on ${req.network} (allowance ${allowance}); rerun with --approve-permit2 to send one approve(Permit2, max) transaction from the payer`,
    );
  }
  const tx = createPermit2ApprovalTx(token);
  const wallet = createWalletClient({ account, chain: client.chain, transport: custom({ request: (a) => client.request(a as never) }) });
  const suggested = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, chain: client.chain, maxPriorityFeePerGas: suggested > MIN_PRIORITY_FEE_WEI ? suggested : MIN_PRIORITY_FEE_WEI });
  options.log(`approve(Permit2, max) sent: ${hash}`);
  const receipt = await pollTransactionReceipt(client, hash);
  if (receipt.status !== "success") throw new Failure(`Permit2 approval ${hash} reverted`);
}
