import { existsSync, readFileSync, writeFileSync } from "fs";
import { Interface } from "ethers/lib/utils";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";
import { fetchWithRetry } from "../utils/fetch-retry.ts";
import { log } from "../engine/log.ts";
import { acquireProcessLock } from "../utils/process-lock.ts";

const WINNERS_PATH = "state/winning-btc-5m.txt";
const POLL_MS = 5 * 60 * 1000;

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const COLLATERAL_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const INDEX_SETS = [1, 2];
const MIN_CLAIMABLE_SHARES = 0.01;

type EventMarket = {
    conditionId?: string;
};

type EventResponse = {
    markets?: EventMarket[];
};

function readWinningSlugs(path: string): string[] {
    if (!existsSync(path)) {
        return [];
    }
    const raw = readFileSync(path, "utf8");
    return [...new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean))];
}

function writeWinningSlugs(path: string, slugs: string[]): void {
    const body = slugs.length > 0 ? `${slugs.join("\n")}\n` : "";
    writeFileSync(path, body, "utf8");
}

async function fetchConditionIdFromSlug(slug: string): Promise<string | null> {
    const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
    const res = await fetchWithRetry(url, {
        options: { headers: { Accept: "application/json" } },
        useCurl: false,
        totalRetry: 3,
    });

    const arr = (await res.json()) as EventResponse[];
    const first = arr[0];
    const conditionId = first?.markets?.[0]?.conditionId ?? null;
    return conditionId;
}

function extractWinningTokenId(market: any): string | null {
    const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
    const winner = tokens.find((t: any) => t?.winner === true);
    if (!winner) {
        return null;
    }

    return (
        winner.token_id ??
        winner.tokenId ??
        winner.asset_id ??
        winner.assetId ??
        null
    );
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

  async function claimCycle(
    clobClient: PolymarketEarlyBirdClient,
    relayer: RelayClient,
  ): Promise<void> {
    const inputSlugs = readWinningSlugs(WINNERS_PATH);
    if (inputSlugs.length === 0) {
      log.write("[claim-cron] no slugs to process", "dim");
      return;
    }
  
    log.write(`[claim-cron] checking ${inputSlugs.length} slug(s)`, "dim");
  
    const keep: string[] = [];
  
    for (const slug of inputSlugs) {
      try {
        const conditionId = await fetchConditionIdFromSlug(slug);
        if (!conditionId) {
          log.write(`[claim-cron] ${slug}: missing conditionId, keeping`, "yellow");
          keep.push(slug);
          continue;
        }
  
        const market = await clobClient.clob.getMarket(conditionId);
        const closed = Boolean((market as any)?.closed);
        if (!closed) {
          log.write(`[claim-cron] ${slug}: not resolved yet, keeping`, "dim");
          keep.push(slug);
          continue;
        }
  
        const winningTokenId = extractWinningTokenId(market);
        if (!winningTokenId) {
          log.write(
            `[claim-cron] ${slug}: resolved but winner not finalized yet, keeping`,
            "yellow",
          );
          keep.push(slug);
          continue;
        }
  
        await clobClient.updateAvailableShares(winningTokenId);
        const beforeShares = await clobClient.getAvailableShares(winningTokenId);
  
        if (beforeShares < MIN_CLAIMABLE_SHARES) {
          log.write(
            `[claim-cron] ${slug}: claimable shares=${beforeShares.toFixed(6)} (< ${MIN_CLAIMABLE_SHARES}), dropping`,
            "dim",
          );
          continue;
        }
  
        await clobClient.updateUSDCBalance();
        const beforeCollateral = await clobClient.getUSDCBalance();
  
        const tx = {
          to: CTF_ADDRESS,
          data: buildRedeemData(conditionId),
          value: "0",
        };
  
        log.write(
          `[claim-cron] ${slug}: claiming shares=${beforeShares.toFixed(6)} condition=${conditionId}`,
          "cyan",
        );
  
        const response = await relayer.execute([tx], `claim ${slug}`);
        const result = await response.wait();
        const txHash = (result as any)?.transactionHash ?? "unknown";
  
        await clobClient.updateAvailableShares(winningTokenId);
        const afterShares = await clobClient.getAvailableShares(winningTokenId);
  
        await clobClient.updateUSDCBalance();
        const afterCollateral = await clobClient.getUSDCBalance();
  
        const shareDelta = beforeShares - afterShares;
        const collateralDelta = afterCollateral - beforeCollateral;
        const effectiveClaim = shareDelta > 0.000001 || collateralDelta > 0.000001;
  
        if (!effectiveClaim) {
          log.write(
            `[claim-cron] ${slug}: tx=${txHash} but no effective payout (shares ${beforeShares.toFixed(6)} -> ${afterShares.toFixed(6)}, collateral ${beforeCollateral.toFixed(6)} -> ${afterCollateral.toFixed(6)}), keeping`,
            "yellow",
          );
          keep.push(slug);
          continue;
        }
  
        log.write(
          `[claim-cron] ${slug}: claimed tx=${txHash} shares ${beforeShares.toFixed(6)} -> ${afterShares.toFixed(6)} collateral ${beforeCollateral.toFixed(6)} -> ${afterCollateral.toFixed(6)}`,
          "green",
        );
      } catch (e) {
        log.write(`[claim-cron] ${slug}: error=${String(e)} (keeping)`, "red");
        keep.push(slug);
      }
    }
  
    writeWinningSlugs(WINNERS_PATH, keep);
    log.write(
      `[claim-cron] cycle complete: remaining=${keep.length} claimed=${inputSlugs.length - keep.length}`,
      "dim",
    );
  }

export async function startClaimWinningCron(opts?: {
    acquireLock?: boolean;
  }): Promise<void> {
    if (opts?.acquireLock !== false) {
      acquireProcessLock("claim-winnings-cron");
    }
  
    const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
    if (!privateKey?.startsWith("0x")) {
      throw new Error("PRIVATE_KEY is required");
    }
  
    const builderApiKey = process.env.BUILDER_API_KEY;
    const builderSecret = process.env.BUILDER_SECRET;
    const builderPassphrase =
      process.env.BUILDER_PASSPHRASE ?? process.env.BUILDER_PASS_PHRASE;
  
    if (!builderApiKey || !builderSecret || !builderPassphrase) {
      throw new Error(
        "BUILDER_API_KEY, BUILDER_SECRET, and BUILDER_PASSPHRASE (or BUILDER_PASS_PHRASE) are required",
      );
    }
  
    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({
      account,
      chain: polygon,
      transport: http(process.env.RPC_URL ?? "https://polygon-rpc.com"),
    });
  
    const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: builderApiKey,
        secret: builderSecret,
        passphrase: builderPassphrase,
      },
    });
  
    const relayer = new RelayClient(
      "https://relayer-v2.polymarket.com/",
      137,
      wallet,
      builderConfig,
    );
  
    const clobClient = new PolymarketEarlyBirdClient();
    await clobClient.init();
  
    // Run immediately, then every 5 minutes.
    await claimCycle(clobClient, relayer);
    setInterval(() => {
      claimCycle(clobClient, relayer).catch((e) => {
        log.write(`[claim-cron] unhandled cycle error=${String(e)}`, "red");
      });
    }, POLL_MS);
  
    log.write(`[claim-cron] started poll=${POLL_MS / 1000}s`, "dim");
  }

  async function main(): Promise<void> {
    await startClaimWinningCron({ acquireLock: true });
  }
  
  if (import.meta.main) {
    main().catch((e) => {
      log.write(`[claim-cron] fatal=${String(e)}`, "red");
      process.exit(1);
    });
  }