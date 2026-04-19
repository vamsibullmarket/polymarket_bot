import { APIQueue } from "../tracker/api-queue.ts";
import type { EarlyBirdClient } from "./client.ts";
import { EarlyBirdSimClient, PolymarketEarlyBirdClient } from "./client.ts";
import { MarketLifecycle } from "./market-lifecycle.ts";
import { loadState, saveState, type CompletedMarketState } from "./state.ts";
import { getSlug } from "../utils/slot.ts";
import { log, MarketLog } from "./log.ts";
import { recover } from "./recovery.ts";
import {
  strategies,
  DEFAULT_STRATEGY,
  type Strategy,
} from "./strategy/index.ts";
import { WalletTracker } from "./wallet-tracker.ts";
import { TickerTracker } from "../tracker/ticker";
import { Env } from "../utils/config.ts";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { dirname } from "path";


const SAVE_INTERVAL_MS = 5000;
const WINNING_SLUGS_PATH = "state/winning-btc-5m.txt";


export class EarlyBird {
  private _lifecycles = new Map<string, MarketLifecycle>();
  private _completedSlugs = new Set<string>();
  private _marketLogs = new Map<string, MarketLog>();
  private _completedMarkets: CompletedMarketState[] = [];
  private _client: EarlyBirdClient;
  private _apiQueue = new APIQueue();
  private _sessionPnl = 0;
  private _sessionLoss = 0;
  private _shuttingDown = false;
  private _lastSaveMs = 0;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _slotOffset: number;

  private readonly _statePath: string;
  private readonly _rounds: number | null; // null = unlimited
  private readonly _prod: boolean;
  private readonly _minSessionPnl: number;
  private readonly _alwaysLog: boolean;
  private _roundsCreated = 0;
  private _lastHeartbeatMs = 0;
  private _tracker!: WalletTracker;
  private _ticker = new TickerTracker();

  constructor(
    strategyName?: string,
    slotOffset = 1,
    prod = false,
    rounds: number | null = null,
    alwaysLog = false,
  ) {
    this._prod = prod;
    this._statePath = prod
      ? "state/early-bird-prod.json"
      : "state/early-bird.json";
    this._rounds = rounds;
    this._strategyName = strategyName ?? DEFAULT_STRATEGY;
    this._strategy = strategies[this._strategyName]!;
    this._slotOffset = slotOffset;
    this._alwaysLog = alwaysLog;
    this._minSessionPnl = parseFloat(process.env.MAX_SESSION_LOSS ?? "3");
    if (prod) {
      this._client = new PolymarketEarlyBirdClient();
    } else {
      this._client = new EarlyBirdSimClient((tokenId) => {
        for (const lifecycle of this._lifecycles.values()) {
          const snap = lifecycle.getBookSnapshot(tokenId);
          if (snap) return snap;
        }
        return {
          bestAsk: null,
          bestAskLiquidity: null,
          bestBid: null,
          bestBidLiquidity: null,
        };
      });
    }
  }

  private _appendWinningSlugToFile(slug: string): void {
    if (!slug.startsWith("btc-updown-5m-")) {
      return;
    }
    mkdirSync(dirname(WINNING_SLUGS_PATH), { recursive: true });
    const existing = existsSync(WINNING_SLUGS_PATH)
      ? readFileSync(WINNING_SLUGS_PATH, "utf8")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (existing.includes(slug)) {
      return;
    }
    const body = `${[...existing, slug].join("\n")}\n`;
    writeFileSync(WINNING_SLUGS_PATH, body, "utf8");
  }

  async start(): Promise<void> {
    log.write("[startup] Starting");
    this._ticker.schedule();
    await this._ticker.waitForReady();
    log.write(`[startup] ${Env.getAssetConfig().apiSymbol} ticker ready`);

    await this._client.init();

    // Seed wallet tracker
    let initialBalance: number;
    if (this._prod) {
      await this._client.updateUSDCBalance();
      initialBalance = await this._client.getUSDCBalance();
      log.write(`[startup] On-chain balance: $${initialBalance.toFixed(2)}`);
    } else {
      initialBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");
      log.write(`[startup] Sim balance: $${initialBalance.toFixed(2)}`);
    }
    this._tracker = new WalletTracker(initialBalance, (msg) =>
      log.write(msg, "dim"),
    );

    log.write(
      `[startup] Min session PnL exit: $${this._minSessionPnl.toFixed(2)}`,
    );

    const state = loadState(this._statePath);
    if (state) {
      log.write(`[startup] Loading state from ${this._statePath}`);
      log.write(
        `[startup] Prior persisted session (discarded after recovery): pnl=${state.sessionPnl} loss=${state.sessionLoss ?? 0} completedMarkets=${state.completedMarkets?.length ?? 0}`,
        "dim",
      );

      // Sim recovery: replay order history to reconstruct balance
      if (!this._prod) {
        for (const market of state.activeMarkets) {
          for (const order of market.orderHistory) {
            if (order.action === "buy") {
              this._tracker.debit(order.price * order.shares);
            } else {
              this._tracker.credit(order.price * order.shares);
            }
          }
        }
      }

      const recovered = await recover(
        state,
        this._client,
        this._apiQueue,
        (msg, color) => log.write(msg, color),
        this._tracker,
        this._ticker,
      );
      for (const [slug, lifecycle] of recovered) {
        this._lifecycles.set(slug, lifecycle);
      }

      this._sessionPnl = 0;
      this._sessionLoss = 0;
      this._completedMarkets = [];
      log.write(
        "[startup] Session PnL/loss and completedMarkets reset for this run; active lifecycles preserved",
        "dim",
      );
      this._saveState();
    } else {
      log.write("[startup] No saved state found. Starting fresh.");
    }

    if (this._prod) {
      const { startClaimWinningCron } = await import("../scripts/claim-winning-cron.ts");
      startClaimWinningCron({ acquireLock: false }).catch((e) => {
        log.write(`[claim-cron] failed to start: ${String(e)}`, "red");
      });
    }

    process.on("exit", () => {
      log.flush();
      this._saveState();
    });

    const onSignal = (sig: string) => {
      log.write(
        `[shutdown] ${sig} received. Initiating graceful shutdown...`,
        "yellow",
      );
      log.flush();
      this._saveState();
      this._startShutdown(`${sig} received.`);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    setInterval(() => this._tick(), 100);
  }

  private _tick(): void {
    // Create a new lifecycle for next market if not shutting down and rounds allow
    const roundsExhausted =
      this._rounds !== null && this._roundsCreated >= this._rounds;
    if (!this._shuttingDown && !roundsExhausted) {
      const slug = getSlug(this._slotOffset);
      if (!this._lifecycles.has(slug) && !this._completedSlugs.has(slug)) {
        const marketLog = new MarketLog(slug);
        this._marketLogs.set(slug, marketLog);
        this._lifecycles.set(
          slug,
          new MarketLifecycle({
            slug,
            apiQueue: this._apiQueue,
            client: this._client,
            log: (msg, color) => {
              log.write(msg, color);
              marketLog.write(msg);       // ← also write to per-market file
            },
            strategyName: this._strategyName,
            strategy: this._strategy,
            tracker: this._tracker,
            ticker: this._ticker,
            alwaysLog: this._alwaysLog,
          }),
        );
        this._roundsCreated++;
      }
    }

    // Tick all lifecycles (fire-and-forget; _ticking guard prevents re-entry)
    const done: string[] = [];
    for (const [slug, lifecycle] of this._lifecycles) {
      lifecycle
        .tick()
        .catch((e) => log.write(`[${slug}] tick error: ${e}`, "red"));
      if (lifecycle.state === "DONE") done.push(slug);
    }

    if (Date.now() - this._lastHeartbeatMs >= 60_000) {
      this._lastHeartbeatMs = Date.now();

      const running = [...this._lifecycles.entries()]
        .filter(([, l]) => l.state === "RUNNING")
        .map(([slug]) => slug);

      const stopping = [...this._lifecycles.entries()]
        .filter(([, l]) => l.state === "STOPPING")
        .map(([slug]) => slug);

      log.write(
        `[heartbeat] running=${running.join(", ") || "none"} | stopping=${stopping.join(", ") || "none"}`,
        "dim",
      );

      const lifecycleEntries = [...this._lifecycles.entries()];

      void (async () => {
        if (this._prod) {
          await this._client.updateUSDCBalance();
          const chainBalance = await this._client.getUSDCBalance();
          const trackedBalance = this._tracker.balance;

          if (Number.isFinite(chainBalance)) {
            const delta = parseFloat((chainBalance - trackedBalance).toFixed(6));

            if (Math.abs(delta) > 0.000001) {
              if (delta > 0) {
                this._tracker.credit(delta);
              } else {
                this._tracker.debit(-delta);
              }

              log.write(
                `[heartbeat] USDC reconciled tracked=$${trackedBalance.toFixed(2)} chain=$${chainBalance.toFixed(2)} delta=${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}`,
                "yellow",
              );
            }
          }
        }

        await Promise.allSettled(
          lifecycleEntries.map(([slug, lifecycle]) =>
            lifecycle
              .heartbeatCheckAndMaybeSettle()
              .then((msg) => log.write(msg, "dim"))
              .catch((e) =>
                log.write(`[${slug}] hb-check error: ${String(e)}`, "red")
              ),
          ),
        );
      })().catch((e) => {
        log.write(`[heartbeat] error: ${String(e)}`, "red");
      });
    }

    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug)!;
      this._sessionPnl = parseFloat(
        (this._sessionPnl + lifecycle.pnl).toFixed(4),
      );
      if (lifecycle.pnl < 0) {
        this._sessionLoss = parseFloat(
          (this._sessionLoss + lifecycle.pnl).toFixed(4),
        );
      }
      log.write(
        `[${slug}] Session PnL: ${this._sessionPnl >= 0 ? "+" : ""}$${this._sessionPnl.toFixed(2)}`,
        this._sessionPnl >= 0 ? "green" : "red",
      );
      this._completedMarkets.push({
        slug,
        strategyName: lifecycle.strategyName,
        pnl: lifecycle.pnl,
        orderHistory: lifecycle.orderHistory,
      });
      if (lifecycle.pnl > 0) {
        this._appendWinningSlugToFile(slug);
      }
      const ml = this._marketLogs.get(slug);
      if (ml) {
        ml.done();
        this._marketLogs.delete(slug);
      }
      lifecycle.destroy();
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        this._startShutdown(
          `Session loss limit reached (total losses: $${this._sessionLoss.toFixed(2)}, threshold: -$${this._minSessionPnl.toFixed(2)}).`,
        );
      }
    }

    // Throttled state persistence (every 5s)
    if (Date.now() - this._lastSaveMs >= SAVE_INTERVAL_MS) {
      this._saveState();
    }

    // Auto-shutdown when all rounds complete and no lifecycles remain
    if (!this._shuttingDown && roundsExhausted && this._lifecycles.size === 0) {
      this._startShutdown(`All ${this._rounds} round(s) complete.`);
    }

    // Exit once all lifecycles are settled during shutdown
    if (this._shuttingDown && this._lifecycles.size === 0) {
      log.write("[shutdown] All settled. Exiting.", "dim");
      this._saveState();
      this._ticker.destroy();
      process.exit(0);
    }
  }

  private _startShutdown(reason: string): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    log.write(`[shutdown] ${reason}`, "yellow");
    log.write("[shutdown] Signalling all lifecycles to cancel.", "yellow");

    for (const [, lifecycle] of this._lifecycles) {
      lifecycle.shutdown();
    }

    const stoppingCount = [...this._lifecycles.values()].filter(
      (l) => l.state === "STOPPING",
    ).length;

    if (stoppingCount > 0) {
      log.write(
        `[shutdown] Waiting for ${stoppingCount} lifecycle(s) to settle...`,
      );
    }
  }

  private _saveState(): void {
    this._lastSaveMs = Date.now();

    const activeMarkets = [...this._lifecycles.entries()]
      .filter(([, l]) => l.state === "RUNNING" || l.state === "STOPPING")
      .map(([slug, l]) => ({
        slug,
        state: l.state as "RUNNING" | "STOPPING",
        strategyName: l.strategyName,
        clobTokenIds: l.clobTokenIds!,
        pendingOrders: l.pendingOrders,
        orderHistory: l.orderHistory,
      }));

    saveState(this._statePath, {
      sessionPnl: this._sessionPnl,
      sessionLoss: this._sessionLoss,
      activeMarkets,
      completedMarkets: this._completedMarkets,
    });
  }
}
