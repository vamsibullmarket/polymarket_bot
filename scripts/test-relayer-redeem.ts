/**
 * One-off: submit CTF redeemPositions via relayer HTTP API (RELAYER_API_KEY).
 * Use for smoke-testing relayer auth; payout may be 0 on lost positions.
 *
 * Usage: bun scripts/test-relayer-redeem.ts [slug]
 * Default slug: btc-updown-5m-1776621600
 *
 * Requires: PRIVATE_KEY, RELAYER_API_KEY, RELAYER_API_KEY_ADDRESS
 * Optional: RPC_URL, RELAYER_BASE_URL
 */

import { Interface } from "ethers/lib/utils";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { submitSafeTransactionViaRelayerApi } from "../engine/relayer-safe-submit.ts";
import { fetchWithRetry } from "../utils/fetch-retry.ts";

const DEFAULT_SLUG = "btc-updown-5m-1776621600";
const CHAIN_ID = 137;
const DEFAULT_RELAYER_BASE = "https://relayer-v2.polymarket.com";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const COLLATERAL_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const INDEX_SETS = [1, 2];

type EventResponse = { markets?: { conditionId?: string }[] };

async function fetchConditionIdFromSlug(slug: string): Promise<string | null> {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetchWithRetry(url, {
    options: { headers: { Accept: "application/json" } },
    useCurl: false,
    totalRetry: 3,
  });
  const arr = (await res.json()) as EventResponse[];
  const first = arr[0];
  return first?.markets?.[0]?.conditionId ?? null;
}

function buildRedeemData(conditionId: string): string {
  const ctf = new Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  ]);
  return ctf.encodeFunctionData("redeemPositions", [
    COLLATERAL_TOKEN,
    ZERO_BYTES32,
    conditionId,
    INDEX_SETS,
  ]);
}

async function main(): Promise<void> {
  const slug = (process.argv[2] ?? DEFAULT_SLUG).trim();
  const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
  const relayerApiKey = process.env.RELAYER_API_KEY?.trim();
  const relayerApiKeyAddress = process.env.RELAYER_API_KEY_ADDRESS?.trim();
  const relayerBaseUrl =
    process.env.RELAYER_BASE_URL?.trim() ?? DEFAULT_RELAYER_BASE;

  if (!privateKey?.startsWith("0x")) {
    throw new Error("PRIVATE_KEY is required");
  }
  if (!relayerApiKey || !relayerApiKeyAddress) {
    throw new Error(
      "RELAYER_API_KEY and RELAYER_API_KEY_ADDRESS are required",
    );
  }

  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== relayerApiKeyAddress.toLowerCase()) {
    throw new Error(
      "RELAYER_API_KEY_ADDRESS must match the address from PRIVATE_KEY",
    );
  }

  const conditionId = await fetchConditionIdFromSlug(slug);
  if (!conditionId) {
    throw new Error(`No conditionId for slug=${slug}`);
  }

  const data = buildRedeemData(conditionId);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.RPC_URL ?? "https://polygon-rpc.com"),
  });

  console.log(`slug=${slug}`);
  console.log(`conditionId=${conditionId}`);
  console.log(`submitting redeem via relayer-api...`);

  const result = await submitSafeTransactionViaRelayerApi({
    wallet,
    chainId: CHAIN_ID,
    relayerBaseUrl,
    relayerApiKey,
    relayerApiKeyAddress,
    transaction: {
      to: CTF_ADDRESS,
      data,
      value: "0",
    },
    metadata: `test-relayer-redeem ${slug}`,
  });

  console.log(`transactionID=${result.transactionID}`);
  console.log(`transactionHash=${result.transactionHash}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
