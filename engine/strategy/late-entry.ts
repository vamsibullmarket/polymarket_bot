// Buy and Hold strategy

import type { Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";
import { getSlug } from "../../utils/slot.ts";

class RSI {
  private _period: number;
  private _prev: number | null = null;
  private _avgGain: number | null = null;
  private _avgLoss: number | null = null;
  private _seedGains: number[] = [];
  private _seedLosses: number[] = [];
  private _value: number | null = null;

  constructor(period = 14) {
    this._period = period;
  }

  update(value: number): number | null {
    if (this._prev === null) {
      this._prev = value;
      return null;
    }

    const delta = value - this._prev;
    this._prev = value;

    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;

    if (this._avgGain === null) {
      this._seedGains.push(gain);
      this._seedLosses.push(loss);

      if (this._seedGains.length >= this._period) {
        this._avgGain =
          this._seedGains.reduce((s, v) => s + v, 0) / this._period;
        this._avgLoss =
          this._seedLosses.reduce((s, v) => s + v, 0) / this._period;
        this._value = this._computeRsi(this._avgGain, this._avgLoss);
      }
      return this._value;
    }

    this._avgGain = (this._avgGain * (this._period - 1) + gain) / this._period;
    this._avgLoss = (this._avgLoss! * (this._period - 1) + loss) / this._period;
    this._value = this._computeRsi(this._avgGain, this._avgLoss!);
    return this._value;
  }

  get value(): number | null {
    return this._value;
  }

  private _computeRsi(avgGain: number, avgLoss: number): number {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }
}

class ATR {
  private _period: number;
  private _prev: number | null = null;
  private _avgTr: number | null = null;
  private _seedTrs: number[] = [];
  private _value: number | null = null;

  constructor(period = 14) {
    this._period = period;
  }

  update(price: number): number | null {
    if (this._prev === null) {
      this._prev = price;
      return null;
    }

    const tr = Math.abs(price - this._prev);
    this._prev = price;

    if (this._avgTr === null) {
      this._seedTrs.push(tr);
      if (this._seedTrs.length >= this._period) {
        this._avgTr = this._seedTrs.reduce((s, v) => s + v, 0) / this._period;
        this._value = this._avgTr;
      }
      return this._value;
    }

    this._avgTr = (this._avgTr * (this._period - 1) + tr) / this._period;
    this._value = this._avgTr;
    return this._value;
  }

  get value(): number | null {
    return this._value;
  }

  gapSafety(gap: number): number | null {
    if (!this._value) return null;
    return Math.abs(gap) / this._value;
  }
}

class RTV {
  private _window: number;
  private _prices: number[] = [];
  private _value: number | null = null;

  constructor(window = 30) {
    this._window = window;
  }

  update(price: number): void {
    this._prices.push(price);

    if (this._prices.length > this._window + 1) {
      this._prices.shift();
    }

    if (this._prices.length < 3) {
      this._value = null;
      return;
    }

    let sum = 0;
    for (let i = 1; i < this._prices.length; i++) {
      sum += Math.abs(this._prices[i]! - this._prices[i - 1]!);
    }
    this._value = sum / (this._prices.length - 1);
  }

  get value(): number | null {
    return this._value;
  }
}

class Indicators {
  private _rsi = new RSI(14);
  private _atr = new ATR(14);
  private _rtv = new RTV(30);
  private _peakAbsGap = 0;
  private _lastUpdate = 0;

  tick(gap: number | null, btcPrice: number | undefined): void {
    const now = Date.now();
    if (now - this._lastUpdate < 1000) return;
    this._lastUpdate = now;
    if (gap !== null) {
      this._rsi.update(gap);
      if (this._atr.value !== null) {
        const absGap = Math.abs(gap);
        if (absGap > this._peakAbsGap) this._peakAbsGap = absGap;
      }
    }
    if (btcPrice !== undefined) {
      this._atr.update(btcPrice);
      this._rtv.update(btcPrice);
    }
  }

  get rsi(): number | null {
    return this._rsi.value;
  }

  get atr(): number | null {
    return this._atr.value;
  }

  get rtv(): number | null {
    return this._rtv.value;
  }

  peakGapRatio(gap: number): number | null {
    if (this._peakAbsGap === 0) return null;
    return Math.abs(gap) / this._peakAbsGap;
  }

  gapSafety(gap: number): number | null {
    if (!gap) return null;
    return this._atr.gapSafety(gap);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntrySignal = {
  side: "UP" | "DOWN";
  ask: number;
  gap: number;
  liquidity: number;
  stopLossPrice: number;
};

type LateEntryPosition = {
  side: "UP" | "DOWN";
  tokenId: string;
  entryPrice: number;
  shares: number;
  stopLossPrice: number;
};

type LateEntryState = {
  hasEntered: boolean;
  position: LateEntryPosition | null;
  stopLossFired: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_ORDER_USD = 2;
const NO_SIGNAL_LOG_INTERVAL_MS = 5_000;

function explainNoSignal(params: {
  remaining: number;
  btcPrice?: number;
  priceToBeat: number | null;
  up: { price: number; liquidity: number } | null;
  down: { price: number; liquidity: number } | null;
  rsi: number | null;
  atr: number | null;
  rtv: number | null;
  gapSafety: number | null;
  divergence: number | null;
  peakGapRatio: number | null;
  binancePrice?: number;
  coinbasePrice?: number;
}): string {
  const values: string[] = [];
  const reasons: string[] = [];

  if (params.btcPrice !== undefined) values.push(`asset=${params.btcPrice.toFixed(2)}`);
  else reasons.push("asset_price_missing");

  if (params.binancePrice !== undefined) values.push(`binance=${params.binancePrice.toFixed(2)}`);
  else reasons.push("binance_missing");

  if (params.coinbasePrice !== undefined) values.push(`coinbase=${params.coinbasePrice.toFixed(2)}`);
  else reasons.push("coinbase_missing");

  if (params.priceToBeat !== null) values.push(`open=${params.priceToBeat.toFixed(2)}`);
  else reasons.push("market_open_price_missing");

  if (params.up !== null) values.push(`up=${params.up.price.toFixed(2)}@${params.up.liquidity.toFixed(0)}`);
  else reasons.push("up_book_missing");

  if (params.down !== null) values.push(`down=${params.down.price.toFixed(2)}@${params.down.liquidity.toFixed(0)}`);
  else reasons.push("down_book_missing");

  if (params.rsi !== null) values.push(`rsi=${params.rsi.toFixed(2)}`);
  else reasons.push("rsi_not_ready");

  if (params.atr !== null) values.push(`atr=${params.atr.toFixed(2)}`);
  else reasons.push("atr_not_ready");

  if (params.rtv !== null) values.push(`rtv=${params.rtv.toFixed(2)}`);
  else reasons.push("rtv_not_ready");

  if (params.gapSafety !== null) values.push(`gapSafety=${params.gapSafety.toFixed(2)}`);
  else reasons.push("gap_safety_unavailable");

  if (params.divergence !== null) values.push(`divergence=${params.divergence.toFixed(2)}`);
  else reasons.push("coinbase_divergence_unavailable");

  if (params.peakGapRatio !== null) values.push(`peakGapRatio=${params.peakGapRatio.toFixed(2)}`);
  else reasons.push("peak_gap_ratio_unavailable");

  if (params.remaining >= 5 && params.priceToBeat !== null && params.btcPrice !== undefined) {
    const gap = params.btcPrice - params.priceToBeat;
    values.push(`gap=${gap.toFixed(2)}`);

    if (params.remaining <= 90) {
      if (params.atr === null) reasons.push("atr_not_ready");
      else if (params.atr > 2) reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);

      if (params.gapSafety === null) reasons.push("gap_safety_unavailable");
      else if (params.gapSafety < 40) reasons.push(`gap_safety_too_low=${params.gapSafety.toFixed(2)}`);

      if (params.divergence === null) reasons.push("coinbase_divergence_unavailable");
      else if (params.divergence > 10) reasons.push(`divergence_too_high=${params.divergence.toFixed(2)}`);

      if (params.peakGapRatio === null) reasons.push("peak_gap_ratio_unavailable");
      else if (params.peakGapRatio < 0.75) reasons.push(`peak_gap_ratio_too_low=${params.peakGapRatio.toFixed(2)}`);

      const upCertain = params.up !== null && params.up.price > 0.85;
      const downCertain = params.down !== null && params.down.price > 0.85;
      if (!upCertain && !downCertain) {
        reasons.push("no_certain_side");
      } else {
        const chosen = upCertain ? params.up! : params.down!;
        if (chosen.liquidity < 20) {
          reasons.push(`${upCertain ? "up" : "down"}_liquidity_too_low=${chosen.liquidity.toFixed(0)}`);
        }
      }
    } else {
      reasons.push(`waiting_for_entry_window(remaining=${params.remaining}s)`);
    }
  }

  if (reasons.length === 0) reasons.push("signal_ok");
  return [...values, ...reasons].join("; ");
}

function sharesForNotional(price: number, notionalUsd = TARGET_ORDER_USD): number {
  return Math.max(1, Math.ceil(notionalUsd / price));
}

function checkEntry(params: {
  remaining: number;
  btcPrice: number;
  priceToBeat: number;
  up: { price: number; liquidity: number } | null;
  down: { price: number; liquidity: number } | null;
  rsi: number | null;
  atr: number | null;
  rtv: number | null;
  gapSafety: number | null;
  divergence: number | null;
  peakGapRatio: number | null;
}): EntrySignal | null {
  const {
    remaining,
    btcPrice,
    priceToBeat,
    up,
    down,
    atr,
    gapSafety,
    peakGapRatio,
  } = params;

  if (remaining < 5) return null;

  const gap = btcPrice - priceToBeat;
  const absGap = Math.abs(gap);
  const divergence = params.divergence ?? Infinity;

  if (
    remaining <= 90 &&
    atr &&
    atr <= 2 &&
    gapSafety &&
    gapSafety >= 40 &&
    divergence <= 10 &&
    peakGapRatio &&
    peakGapRatio >= 0.75
  ) {
    const upCertain = up != null && up.price > 0.85;
    const downCertain = down != null && down.price > 0.85;

    if (upCertain || downCertain) {
      const side: "UP" | "DOWN" = upCertain ? "UP" : "DOWN";
      const info = (side === "UP" ? up : down)!;

      if (info.liquidity < 20) return null;

      return {
        side,
        ask: info.price,
        gap: absGap,
        liquidity: info.liquidity,
        stopLossPrice: 0.48,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Order placement helpers
// ---------------------------------------------------------------------------

function placeEntry(
  ctx: StrategyContext,
  state: LateEntryState,
  signal: EntrySignal,
): void {
  const tokenId =
    signal.side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];

  const size = sharesForNotional(signal.ask);

  ctx.postOrders([
    {
      req: { tokenId, action: "buy", price: signal.ask, shares: size },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        state.position = {
          side: signal.side,
          tokenId,
          entryPrice: signal.ask,
          shares: filledShares,
          stopLossPrice: signal.stopLossPrice,
        };
        ctx.log(
          `[${ctx.slug}] late-entry: BUY ${signal.side} filled @ ${signal.ask} (${filledShares} shares)`,
          "green",
        );
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] late-entry: BUY ${signal.side} @ ${signal.ask} expired — resetting`,
          "yellow",
        );
        state.hasEntered = false;
      },
      onFailed(reason) {
        ctx.log(
          `[${ctx.slug}] late-entry: BUY ${signal.side} @ ${signal.ask} failed (${reason}) — resetting`,
          "red",
        );
        state.hasEntered = false;
      },
    },
  ]);
}

function checkStopLoss(
  ctx: StrategyContext,
  state: LateEntryState,
  remaining: number,
  gap: number | null,
  rsi: number | null,
): void {
  const pos = state.position;
  if (!pos) return;

  const bestAsk = ctx.orderBook.bestAskInfo(pos.side)?.price ?? null;
  const bestBid = ctx.orderBook.bestBidPrice(pos.side);

  const GAP_CONFIRM_THRESHOLD = 5;
  const gapConfirmsPosition =
    gap !== null &&
    ((pos.side === "UP" && gap > GAP_CONFIRM_THRESHOLD) ||
      (pos.side === "DOWN" && gap < -GAP_CONFIRM_THRESHOLD));
  const rsiConfirmsMomentum =
    rsi !== null && (pos.side === "UP" ? rsi >= 50 : rsi <= 50);

  const shouldSell =
    (remaining <= 80 &&
      remaining >= 20 &&
      bestAsk !== null &&
      bestAsk <= pos.stopLossPrice &&
      !gapConfirmsPosition &&
      !rsiConfirmsMomentum) ||
    (remaining < 20 &&
      bestAsk !== null &&
      bestAsk <= pos.stopLossPrice &&
      !gapConfirmsPosition);

  if (!shouldSell) return;

  state.stopLossFired = true;
  state.position = null;

  const sellPrice =
    bestBid !== null ? bestBid + 0.01 : pos.stopLossPrice - 0.01;

  ctx.log(
    `[${ctx.slug}] late-entry: stop-loss triggered — SELL ${pos.side} @ ${sellPrice}`,
    "red",
  );

  ctx.postOrders([
    {
      force: false,
      req: {
        tokenId: pos.tokenId,
        action: "sell",
        price: sellPrice,
        shares: pos.shares,
      },
      expireAtMs: ctx.slotEndMs,
      onFilled() {
        ctx.log(
          `[${ctx.slug}] late-entry: stop-loss SELL filled @ ${sellPrice}`,
          "green",
        );
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] late-entry: stop-loss SELL expired — emergency selling`,
          "red",
        );
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell")
          .map((o) => o.orderId);
        if (sellIds.length > 0) {
          ctx.emergencySells(sellIds);
        }
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const lateEntry: Strategy = async (ctx) => {
  // This strategy is now enabled for production use.

  // ── ctx.hold() ────────────────────────────────────────────────────────────
  // By default, the engine transitions out of RUNNING as soon as the strategy
  // function returns. Since this strategy is event-driven (it reacts to price
  // ticks over the life of the market), we need to keep the lifecycle in
  // RUNNING until we are truly done.
  //
  // ctx.hold() increments an internal counter and returns a release function.
  // The lifecycle will not exit RUNNING until every active hold has been
  // released. Call release() exactly once when your strategy has no more work
  // to do (position closed, stop-loss fired, or time ran out). Forgetting to
  // call it will cause the engine to hang after the market closes.
  const releaseLock = ctx.hold();

  const state: LateEntryState = {
    hasEntered: false,
    position: null,
    stopLossFired: false,
  };
  const indicators = new Indicators();
  let lastNoSignalLogAt = 0;

  const tickInterval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(tickInterval);
      releaseLock();
      return;
    }

    if (remaining <= 5 && !state.position) {
      clearInterval(tickInterval);
      releaseLock();
      return;
    }

    const btcPrice = ctx.ticker.price;
    const binancePrice = ctx.ticker.binancePrice;
    const coinbasePrice = ctx.ticker.coinbasePrice;
    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const up = ctx.orderBook.bestAskInfo("UP");
    const down = ctx.orderBook.bestAskInfo("DOWN");

    if (btcPrice === undefined || priceToBeat === null) {
      const now = Date.now();
      if (now - lastNoSignalLogAt >= NO_SIGNAL_LOG_INTERVAL_MS) {
        lastNoSignalLogAt = now;
        ctx.log(
          `[${ctx.slug}] late-entry: waiting — ${explainNoSignal({
            remaining,
            btcPrice,
            priceToBeat,
            up,
            down,
            rsi: indicators.rsi,
            atr: indicators.atr,
            rtv: indicators.rtv,
            gapSafety: null,
            divergence: ctx.ticker.divergence,
            peakGapRatio: null,
            binancePrice,
            coinbasePrice,
          })}`,
          "yellow",
        );
      }
      return;
    }

    const gap = btcPrice - priceToBeat;
    indicators.tick(gap, btcPrice);

    if (!state.hasEntered) {
      const signal = checkEntry({
        remaining,
        btcPrice,
        priceToBeat,
        up,
        down,
        rsi: indicators.rsi,
        atr: indicators.atr,
        rtv: indicators.rtv,
        gapSafety: indicators.gapSafety(gap),
        divergence: ctx.ticker.divergence,
        peakGapRatio: indicators.peakGapRatio(gap),
      });

      if (signal) {
        state.hasEntered = true;
        ctx.log(
          `[${ctx.slug}] late-entry: signal ${signal.side} @ ${signal.ask} (gap ${signal.gap.toFixed(0)}, liq $${signal.liquidity.toFixed(0)})`,
          "cyan",
        );
        placeEntry(ctx, state, signal);
      } else {
        const now = Date.now();
        if (now - lastNoSignalLogAt >= NO_SIGNAL_LOG_INTERVAL_MS) {
          lastNoSignalLogAt = now;
          ctx.log(
            `[${ctx.slug}] late-entry: no signal — ${explainNoSignal({
              remaining,
              btcPrice,
              priceToBeat,
              up,
              down,
              rsi: indicators.rsi,
              atr: indicators.atr,
              rtv: indicators.rtv,
              gapSafety: indicators.gapSafety(gap),
              divergence: ctx.ticker.divergence,
              peakGapRatio: indicators.peakGapRatio(gap),
              binancePrice,
              coinbasePrice,
            })}`,
            "yellow",
          );
        }
      }
    }

    if (state.position && !state.stopLossFired) {
      checkStopLoss(ctx, state, remaining, gap, indicators.rsi);
    }
  }, 1000);

  return () => {
    clearInterval(tickInterval);
  };
};
