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
  entryBid: number;
  shares: number;
  stopLossPrice: number;
  maxSeenBid: number;
  prevBid: number | null;      // bid from previous tick, for velocity calculation
  breakEvenLocked: boolean;
  gapRevTicks: number;
  stopBreachTicks: number;
};

type LateEntryState = {
  hasEntered: boolean;
  position: LateEntryPosition | null;
  stopLossFired: boolean;
  exitInProgress: boolean;
  hadPosition: boolean;
  /** Set on BUY fill; used for settlement-preview after exit. */
  lastTradeSide: "UP" | "DOWN" | null;
  /** One-shot CLOB hint before official resolution. */
  settlementPreviewLogged: boolean;
  released: boolean;
  signalConfirmTicks: number; // consecutive ticks with same signal — must hit 2 before entering
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_ORDER_USD = 5;
const NO_SIGNAL_LOG_INTERVAL_MS = 5_000;

// Open-price availability tuning
const OPEN_PRICE_GRACE_AFTER_OPEN_S = 20;
const OPEN_PRICE_HARD_TIMEOUT_S = 90;

const ENTRY_STRATEGY: "v1" | "v2" = "v2";

/** CLOB mid on your outcome token — tune if most rows are uncertain. */
const SETTLEMENT_PREVIEW_WIN_MIN = 0.98;
const SETTLEMENT_PREVIEW_LOSS_MAX = 0.02;

function midForOutcome(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
): number | null {
  const bid = ctx.orderBook.bestBidPrice(side);
  const ask = ctx.orderBook.bestAskInfo(side)?.price ?? null;
  if (bid != null && ask != null) {
    return (bid + ask) / 2;
  }
  return ask ?? bid ?? null;
}

function classifySettlementPreview(
  mid: number | null,
): "win_preview" | "loss_preview" | "uncertain" | "no_book" {
  if (mid === null || Number.isNaN(mid)) {
    return "no_book";
  }
  if (mid >= SETTLEMENT_PREVIEW_WIN_MIN) {
    return "win_preview";
  }
  if (mid <= SETTLEMENT_PREVIEW_LOSS_MAX) {
    return "loss_preview";
  }
  return "uncertain";
}

function explainNoSignal(params: {
  remaining: number;
  btcPrice?: number;
  oraclePrice?: number;
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

  if (params.btcPrice !== undefined) values.push(`live=${params.btcPrice.toFixed(2)}`);
  else reasons.push("live_price_missing");

  if (params.oraclePrice !== undefined) values.push(`oracle=${params.oraclePrice.toFixed(2)}`);

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

    if (params.remaining > 150) {
      reasons.push(`entry_in=${params.remaining - 150}s`);
    } else if (params.remaining < 25) {
      reasons.push(`too_late(remaining=${params.remaining}s)`);
    } else if (ENTRY_STRATEGY === "v1") {
      // V1 conditions
      if (params.atr === null) reasons.push("atr_not_ready");
      else if (params.atr > 22) reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);

      if (params.divergence !== null && params.divergence > 18) reasons.push(`divergence_too_high=${params.divergence.toFixed(2)}`);

      const upStrong = params.up !== null && params.up.price >= 0.62 && params.up.liquidity >= 60;
      const downStrong = params.down !== null && params.down.price >= 0.62 && params.down.liquidity >= 60;
      if (!upStrong && !downStrong) reasons.push("no_strong_side");

      if (upStrong && gap < -20) reasons.push(`gap_contradicts_up(gap=${gap.toFixed(0)})`);
      if (downStrong && !upStrong && gap > 20) reasons.push(`gap_contradicts_down(gap=${gap.toFixed(0)})`);
    } else {
      // V2 conditions
      // V2 conditions
      if (params.atr === null) reasons.push("atr_not_ready");
      else if (params.atr > 22) reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);

      if (params.divergence !== null && params.divergence > 18) reasons.push(`divergence_too_high=${params.divergence.toFixed(2)}`);

      if (params.rsi === null) {
        reasons.push("rsi_not_ready");
      } else {
        const upStrong = params.up !== null && params.up.price >= 0.55 && params.up.liquidity >= 60;
        const downStrong = params.down !== null && params.down.price >= 0.55 && params.down.liquidity >= 60;

        if (!upStrong && !downStrong) {
          reasons.push("no_strong_side");
        } else {
          let side: "UP" | "DOWN";
          let info: { price: number; liquidity: number };
          if (upStrong && downStrong) {
            if (gap > 8) { side = "UP"; info = params.up!; }
            else if (gap < -8) { side = "DOWN"; info = params.down!; }
            else {
              const upScore = params.up!.price * params.up!.liquidity;
              const downScore = params.down!.price * params.down!.liquidity;
              side = upScore >= downScore ? "UP" : "DOWN";
              info = side === "UP" ? params.up! : params.down!;
            }
          } else if (upStrong) { side = "UP"; info = params.up!; }
          else { side = "DOWN"; info = params.down!; }

          if (Math.abs(gap) < 25) reasons.push(`gap_too_small(${gap.toFixed(1)})`);
          if (info.liquidity < 120) reasons.push(`liq_too_low=${info.liquidity.toFixed(0)}`);
          if (side === "UP" && params.rsi < 55) reasons.push(`rsi_contradicts_up(rsi=${params.rsi.toFixed(1)})`);
          if (side === "DOWN" && params.rsi > 45) reasons.push(`rsi_contradicts_down(rsi=${params.rsi.toFixed(1)})`);
          if (side === "UP" && gap < -8) reasons.push(`gap_contradicts_up(gap=${gap.toFixed(0)})`);
          if (side === "DOWN" && gap > 8) reasons.push(`gap_contradicts_down(gap=${gap.toFixed(0)})`);
          if (info.price < 0.55) reasons.push(`price_too_low=${info.price.toFixed(2)}`);
          if (info.price > 0.90) reasons.push(`price_too_high=${info.price.toFixed(2)}`);
          if (info.liquidity < 80) reasons.push(`liq_too_low=${info.liquidity.toFixed(0)}`);
          if (params.peakGapRatio !== null && params.peakGapRatio < 0.55) reasons.push(`peak_gap_ratio_low=${params.peakGapRatio.toFixed(2)}`);
          if (params.gapSafety !== null && params.gapSafety < 8) reasons.push(`gap_safety_low=${params.gapSafety.toFixed(2)}`);
        }
      }
    }
  }

  if (reasons.length === 0) reasons.push("signal_ok");
  return [...values, ...reasons].join("; ");
}

function sharesForNotional(price: number, notionalUsd = TARGET_ORDER_USD): number {
  return Math.max(1, Math.ceil(notionalUsd / price));
}

/**
 * Strategy V2 entry: same base gates as V1 but adds:
 *  - RSI on gap must confirm direction (gap momentum alignment)
 *  - Tighter gap/direction sanity (-8/+8 vs -20/+20)
 *  - When both sides are strong, gap direction wins the tiebreaker first;
 *    price*liquidity score is only a secondary tiebreaker when gap is near zero
 *  - Entry price ceiling: avoid paying > 0.82 (market already priced in the move)
 *  - Entry price floor: avoid paying < 0.58 (too uncertain, wide stop needed)
 */
/**
 * Strategy V2 entry: same base gates as V1 but adds:
 *  - RSI on gap must confirm direction (gap momentum alignment)
 *  - Tighter gap/direction sanity (-8/+8 vs -20/+20)
 *  - When both sides are strong, gap direction wins the tiebreaker first;
 *    price*liquidity score is only a secondary tiebreaker when gap is near zero
 *  - Entry price band: 0.74–0.77 (strong conviction zone with meaningful upside)
 *  - Stop at entry - 0.20; only promotes to 0.92 once bid hits 0.95
 */
function checkEntryV2(params: {
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
  const { remaining, btcPrice, priceToBeat, up, down, atr, divergence, rsi } = params;

  // --- Time window: 150 seconds remaining ---
  if (remaining < 25 || remaining > 150) return null;

  // --- Volatility gate ---
  if (atr === null || atr > 22) return null;

  // --- Exchange divergence gate ---
  const div = divergence ?? Infinity;
  if (div > 18) return null;

  // --- RSI must be ready ---
  if (rsi === null) return null;

  const gap = btcPrice - priceToBeat;

  // --- CLOB conviction ---
  const upStrong = up !== null && up.price >= 0.55 && up.liquidity >= 60;
  const downStrong = down !== null && down.price >= 0.55 && down.liquidity >= 60;
  if (!upStrong && !downStrong) return null;

  // --- Minimum absolute gap ---
  if (Math.abs(gap) < 25) return null;

  // --- Gap safety: |gap| / ATR must be meaningful ---
  if (params.gapSafety !== null && params.gapSafety < 8) return null;

  // --- Peak gap ratio: gap must still be near its peak ---
  if (params.peakGapRatio !== null && params.peakGapRatio < 0.55) return null;

  // --- Determine side with gap direction as primary tiebreaker ---
  let side: "UP" | "DOWN";
  let info: { price: number; liquidity: number };

  if (upStrong && downStrong) {
    if (gap > 8) {
      side = "UP";
      info = up!;
    } else if (gap < -8) {
      side = "DOWN";
      info = down!;
    } else {
      const upScore = up!.price * up!.liquidity;
      const downScore = down!.price * down!.liquidity;
      side = upScore >= downScore ? "UP" : "DOWN";
      info = side === "UP" ? up! : down!;
    }
  } else if (upStrong) {
    side = "UP";
    info = up!;
  } else {
    side = "DOWN";
    info = down!;
  }

  // --- Directional side needs stronger liquidity than the baseline $80 floor ---
  if (info.liquidity < 80) return null;

  // --- RSI momentum must agree with chosen side ---
  if (side === "UP" && rsi < 35) return null;
  if (side === "DOWN" && rsi > 65) return null;

  // --- Gap/direction sanity ---
  if (side === "UP" && gap < -8) return null;
  if (side === "DOWN" && gap > 8) return null;

  // --- Price band: 0.74–0.77 only ---
  // Strong conviction zone: meaningful upside to 1.00, -0.20 stop stays above 0.50
  if (info.price < 0.74 || info.price > 0.90) return null;

  if (atr !== null && atr < 0.05) return null;

  // Stop is fixed at entry - 0.20; floor at 0.50 as hard minimum
  const stopLossPrice = Math.max(0.50, info.price - 0.20);

  return {
    side,
    ask: info.price,
    gap: Math.abs(gap),
    liquidity: info.liquidity,
    stopLossPrice,
  };
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
    divergence,
  } = params;

  if (remaining < 25 || remaining > 150) {
    return null;
  }

  if (atr === null || atr > 22) {
    return null;
  }

  const div = divergence ?? Infinity;
  if (div > 18) {
    return null;
  }

  const gap = btcPrice - priceToBeat;

  const upStrong = up !== null && up.price >= 0.65 && up.liquidity >= 80;
  const downStrong = down !== null && down.price >= 0.65 && down.liquidity >= 80;

  if (!upStrong && !downStrong) {
    return null;
  }

  // If both are strong, choose the one with higher ask*liquidity score.
  let side: "UP" | "DOWN";
  let info: { price: number; liquidity: number };

  if (upStrong && downStrong) {
    const upScore = up!.price * up!.liquidity;
    const downScore = down!.price * down!.liquidity;
    side = upScore >= downScore ? "UP" : "DOWN";
    info = side === "UP" ? up! : down!;
  } else if (upStrong) {
    side = "UP";
    info = up!;
  } else {
    side = "DOWN";
    info = down!;
  }

  // Direction sanity vs current gap.
  if (side === "UP" && gap < -20) {
    return null;
  }
  if (side === "DOWN" && gap > 20) {
    return null;
  }

  const stopLossPrice =
    info.price >= 0.65 ? Math.max(0.05, info.price - 0.10) : 0.50;

  return {
    side,
    ask: info.price,
    gap: Math.abs(gap),
    liquidity: info.liquidity,
    stopLossPrice,
  };
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
        const entryBid = ctx.orderBook.bestBidPrice(signal.side) ?? signal.ask - 0.03;

        // Fixed stop at entry - 0.20; hard floor at 0.50
        const initialStop = Math.max(0.50, signal.ask - 0.20);

        state.position = {
          side: signal.side,
          tokenId,
          entryPrice: signal.ask,
          entryBid,
          shares: filledShares,
          stopLossPrice: initialStop,
          maxSeenBid: entryBid,
          prevBid: null,
          breakEvenLocked: false,
          gapRevTicks: 0,
          stopBreachTicks: 0,
        };
        state.lastTradeSide = signal.side;
        state.stopLossFired = false;
        state.exitInProgress = false;

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
  _rsi: number | null,
  _releaseLock: () => void,
): void {
  const pos = state.position;
  if (!pos || state.stopLossFired || state.exitInProgress) return;

  const currentBid = ctx.orderBook.bestBidPrice(pos.side) ?? null;
  const bestAsk = ctx.orderBook.bestAskInfo(pos.side)?.price ?? null;
  const spread =
    bestAsk != null && currentBid != null ? bestAsk - currentBid : null;

  const trackedShares = ctx.getTrackedShares(pos.tokenId);
  if (trackedShares > 0) {
    pos.shares = trackedShares;
  }

  if (currentBid !== null && currentBid > pos.maxSeenBid) {
    pos.maxSeenBid = currentBid;
  }

  // Promote stop to 0.92 only once bid reaches 0.97.
  // Until then the fixed -0.20 stop holds — no trailing, no break-even.
  if (!pos.breakEvenLocked && pos.maxSeenBid >= 0.97) {
    pos.stopLossPrice = 0.92;
    pos.breakEvenLocked = true;
    ctx.log(
      `[${ctx.slug}] late-entry: stop promoted to 0.92 (bid hit 0.95, entry=${pos.entryPrice.toFixed(2)})`,
      "cyan",
    );
  }

  // Velocity tracking: store current bid for use next tick, compute single-tick drop.
  const bidDrop = pos.prevBid !== null && currentBid !== null
    ? pos.prevBid - currentBid
    : 0;
  pos.prevBid = currentBid;

  const gapReversed =
    gap !== null &&
    ((pos.side === "UP" && gap < -10) ||
      (pos.side === "DOWN" && gap > 10));

  // Softer gap threshold used only for velocity crash detection.
  const softGapReversed =
    gap !== null &&
    ((pos.side === "UP" && gap < -5) ||
      (pos.side === "DOWN" && gap > 5));

  if (gapReversed) {
    pos.gapRevTicks++;
  } else {
    pos.gapRevTicks = 0;
  }
  const gapRevStable = pos.gapRevTicks >= 3;

  const gapIsLarge = gap !== null && Math.abs(gap) > 20;

  const rawStopBreached =
    currentBid !== null &&
    currentBid <= pos.stopLossPrice;

  if (rawStopBreached) {
    pos.stopBreachTicks++;
  } else {
    pos.stopBreachTicks = 0;
  }

  const stopGap =
    currentBid !== null ? pos.stopLossPrice - currentBid : 0;

  const bookIsEmpty = remaining < 25 && (currentBid ?? 0) < 0.30;

  // Option B: in the final 90s, if bid already hit 0.95 (breakEvenLocked) and
  // the BTC gap is still in our direction, hold for resolution.
  const inResolutionHold =
    remaining < 90 &&
    pos.breakEvenLocked &&
    gap !== null &&
    ((pos.side === "UP" && gap > 5) ||
      (pos.side === "DOWN" && gap < -5));

  const stopBreached =
    !bookIsEmpty &&
    !inResolutionHold &&
    rawStopBreached &&
    (
      (gapIsLarge && gapRevStable) ||
      (!gapIsLarge && (!gapReversed || gapRevStable))
    );

  // Gap confirmed reversed for 3 ticks AND bid is still above entry price —
  // don't wait for the fixed stop, sell now to protect profit.
  const panicExit =
    gapRevStable &&
    currentBid !== null &&
    currentBid > pos.entryPrice &&
    !inResolutionHold;

  // Velocity crash: bid dropped hard in a single tick while gap is already turning.
  // Fires on first detection — no need to wait for gapRevStable (3 ticks).
  const velocityCrash =
    bidDrop >= 0.06 &&
    softGapReversed &&
    pos.gapRevTicks >= 1 &&   // gap must be sustained, not a 1-tick noise spike
    !inResolutionHold;

  // Profit protection: large single-tick bid crash while still in profit.
  // Gap hasn't reversed yet but money is at risk — get out now.
  const profitProtectionExit =
    bidDrop >= 0.07 &&
    currentBid !== null &&
    currentBid > pos.entryPrice &&
    !inResolutionHold;


  const nearExpiryFlip =
    remaining < 25 &&
    gap !== null &&
    Math.abs(gap) <= 5 &&
    (currentBid ?? 0) > 0.30;

  const stopMode = gapIsLarge
    ? (gapRevStable ? "gap-large-reversed" : "gap-large-protected")
    : (!gapReversed ? "gap-small-normal" : "gap-small-reversal");

  ctx.log(
    `[${ctx.slug}] late-entry: pos-tick` +
    ` ask=${bestAsk?.toFixed(2) ?? "none"}` +
    ` bid=${currentBid?.toFixed(2) ?? "none"}` +
    ` spread=${spread != null ? spread.toFixed(2) : "?"}` +
    ` gap=${gap?.toFixed(1) ?? "null"}` +
    ` stop=${pos.stopLossPrice.toFixed(2)}` +
    ` stopGap=${stopGap.toFixed(2)}` +
    ` peak=${pos.maxSeenBid.toFixed(2)}` +
    ` entry=${pos.entryPrice.toFixed(2)}` +
    ` beLocked=${pos.breakEvenLocked}` +
    ` trackedShares=${pos.shares.toFixed(6)}` +
    ` gapRev=${gapReversed}` +
    ` gapRevTicks=${pos.gapRevTicks}` +
    ` stopTicks=${pos.stopBreachTicks}` +
    ` stopMode=${stopMode}` +
    ` gapIsLarge=${gapIsLarge}` +
    ` gapRevStable=${gapRevStable}` +
    ` bookEmpty=${bookIsEmpty}` +
    ` resolutionHold=${inResolutionHold}`,
    "dim",
  );

  // const shouldSell = nearExpiryFlip || stopBreached || panicExit || velocityCrash || profitProtectionExit;
  const shouldSell = false;
  if (!shouldSell) return;

  const exitReason = nearExpiryFlip
    ? `near-expiry coin-flip (gap=${gap?.toFixed(1)}, remaining=${remaining}s)`
    : panicExit
      ? `panic-exit (gapRevStable, bid=${currentBid?.toFixed(2)}, peak=${pos.maxSeenBid.toFixed(2)}, entry=${pos.entryPrice.toFixed(2)}, gap=${gap?.toFixed(1)})`
      : velocityCrash
        ? `velocity-crash (bidDrop=${bidDrop.toFixed(2)}/tick, bid=${currentBid?.toFixed(2)}, gap=${gap?.toFixed(1)}, entry=${pos.entryPrice.toFixed(2)})`
        : profitProtectionExit
          ? `profit-protection (bidDrop=${bidDrop.toFixed(2)}/tick, bid=${currentBid?.toFixed(2)}, peak=${pos.maxSeenBid.toFixed(2)}, entry=${pos.entryPrice.toFixed(2)})`
          : `stop-loss @ ${pos.stopLossPrice.toFixed(2)} (mode=${stopMode}, stopGap=${stopGap.toFixed(2)}, peakBid=${pos.maxSeenBid.toFixed(2)}, entry=${pos.entryPrice.toFixed(2)}, beLocked=${pos.breakEvenLocked})`;

  state.stopLossFired = true;
  state.exitInProgress = true;

  const tokenId = pos.tokenId;
  const side = pos.side;
  const DUST_SHARES = 0.5;

  let exitClosed = false;

  const resetAfterExit = (message?: string, color: "green" | "yellow" = "green") => {
    if (exitClosed) {
      return;
    }

    exitClosed = true;
    state.position = null;
    state.stopLossFired = false;
    state.exitInProgress = false;

    if (message) {
      ctx.log(message, color);
    }
  };

  const tryExit = () => {
    if (exitClosed) {
      return;
    }

    if (Date.now() >= ctx.slotEndMs) {
      resetAfterExit(
        `[${ctx.slug}] late-entry: exit abandoned — slot ended [${exitReason}]`,
        "yellow",
      );
      return;
    }

    const targetShares = ctx.getTrackedShares(tokenId);
    if (targetShares <= DUST_SHARES) {
      resetAfterExit(
        `[${ctx.slug}] late-entry: exit complete — remaining shares treated as dust (${targetShares.toFixed(6)}) [${exitReason}]`,
        "yellow",
      );
      return;
    }

    const bestBid = ctx.orderBook.bestBidPrice(side);
    const sellPrice = bestBid !== null ? bestBid : 0.02;

    ctx.log(
      `[${ctx.slug}] late-entry: GTC exit — SELL ${side} @ ${sellPrice} (${targetShares} shares) [${exitReason}]`,
      "red",
    );

    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "sell",
          price: sellPrice,
          shares: targetShares,
          orderType: "GTC",
        },
        expireAtMs: Date.now() + 2000,
        onFilled(filledShares) {
          if (exitClosed) {
            return;
          }

          const remainingShares = ctx.getTrackedShares(tokenId);
          if (remainingShares > DUST_SHARES) {
            // partial fill — retry for the remainder
            tryExit();
            return;
          }

          resetAfterExit(
            `[${ctx.slug}] late-entry: exit SELL filled @ ${sellPrice} (${filledShares} shares)`,
            "green",
          );
        },
        onExpired() {
          if (exitClosed) {
            return;
          }
          tryExit();
        },
        onFailed(reason) {
          if (exitClosed) {
            return;
          }

          const latestTrackedShares = ctx.getTrackedShares(tokenId);

          if (latestTrackedShares <= DUST_SHARES) {
            resetAfterExit(
              `[${ctx.slug}] late-entry: exit complete — remaining shares treated as dust (${latestTrackedShares.toFixed(6)}) [${exitReason}]`,
              "yellow",
            );
            return;
          }

          if (reason.includes("not enough balance")) {
            setTimeout(() => {
              if (!exitClosed) {
                tryExit();
              }
            }, 400);
            return;
          }

          if (reason.includes("invalid amounts")) {
            resetAfterExit(
              `[${ctx.slug}] late-entry: exit stopped — remaining shares below executable size (${latestTrackedShares.toFixed(6)}) [${exitReason}]`,
              "yellow",
            );
            return;
          }

          setTimeout(() => {
            if (!exitClosed) {
              tryExit();
            }
          }, 400);
        },
      },
    ]);
  };

  tryExit();
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const lateEntry: Strategy = async (ctx) => {
  const releaseLock = ctx.hold();

  const state: LateEntryState = {
    hasEntered: false,
    position: null,
    stopLossFired: false,
    exitInProgress: false,
    hadPosition: false,
    lastTradeSide: null,
    settlementPreviewLogged: false,
    released: false,
    signalConfirmTicks: 0,
  };
  const indicators = new Indicators();
  let lastNoSignalLogAt = 0;
  let frozenPriceTicks = 0;
  let lastSeenLivePrice: number | undefined = undefined;
  const FROZEN_PRICE_MAX_TICKS = 15; // 15 seconds of no price change → restart

  const tickInterval = setInterval(() => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(tickInterval);
      if (!state.released) {
        state.released = true;
        releaseLock();
      }
      return;
    }

    // One-shot CLOB hint (no PnL): win_preview / loss_preview / uncertain — before early teardown.
    if (!state.settlementPreviewLogged && state.hadPosition) {
      const side = state.position?.side ?? state.lastTradeSide;
      if (side) {
        const mid = midForOutcome(ctx, side);
        const label = classifySettlementPreview(mid);
        const fire =
          (remaining === 1 && state.position !== null) ||
          (remaining <= 5 &&
            !state.position &&
            !state.exitInProgress &&
            state.hadPosition) ||
          (!state.position &&
            !state.exitInProgress &&
            state.hadPosition &&
            remaining > 5);
        if (fire) {
          const color =
            label === "win_preview"
              ? "green"
              : label === "loss_preview"
                ? "red"
                : label === "no_book"
                  ? "yellow"
                  : "dim";
          ctx.log(
            `[${ctx.slug}] late-entry: settlement-preview side=${side} mid=${mid?.toFixed(4) ?? "n/a"} label=${label} (mid>=${SETTLEMENT_PREVIEW_WIN_MIN} win, mid<=${SETTLEMENT_PREVIEW_LOSS_MAX} loss)`,
            color,
          );
          state.settlementPreviewLogged = true;
        }
      }
    }

    // Single-trade mode: stop only after we actually had a live position
    // and that position has fully exited.
    if (state.hadPosition && !state.position && !state.exitInProgress) {
      clearInterval(tickInterval);
      if (!state.released) {
        state.released = true;
        releaseLock();
      }
      return;
    }

    if (remaining <= 5 && !state.position && !state.exitInProgress) {
      clearInterval(tickInterval);
      if (!state.released) {
        state.released = true;
        releaseLock();
      }
      return;
    }

    const oraclePrice = ctx.ticker.price;
    const binancePrice = ctx.ticker.binancePrice;
    const coinbasePrice = ctx.ticker.coinbasePrice;
    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const up = ctx.orderBook.bestAskInfo("UP");
    const down = ctx.orderBook.bestAskInfo("DOWN");

    // Use live exchange prices (binance + coinbase average) for gap/indicator computation.
    // The Polymarket oracle price updates infrequently and causes RSI/ATR to freeze at 0.
    // Weight Coinbase 90% / Binance 10% — Polymarket's oracle uses Coinbase as its
    // primary source, so this best reflects the gap at settlement.
    const liveBtcPrice: number | undefined =
      binancePrice !== undefined && coinbasePrice !== undefined
        ? coinbasePrice * 0.95 + binancePrice * 0.05
        : coinbasePrice ?? binancePrice ?? oraclePrice;

    // Detect frozen price feed and restart the process.
    if (liveBtcPrice !== undefined) {
      if (liveBtcPrice === lastSeenLivePrice) {
        frozenPriceTicks++;
        if (frozenPriceTicks >= FROZEN_PRICE_MAX_TICKS) {
          ctx.log(
            `[${ctx.slug}] late-entry: price feed frozen for ${frozenPriceTicks}s (stuck at ${liveBtcPrice}) — restarting process`,
            "red",
          );
          process.exit(1); // PM2/systemd will restart automatically
        }
      } else {
        frozenPriceTicks = 0;
        lastSeenLivePrice = liveBtcPrice;
      }
    }

    if (liveBtcPrice === undefined || priceToBeat === null) {
      const now = Date.now();
      const secsToOpen = Math.ceil((ctx.slotStartMs - now) / 1000);
      const secsSinceOpen = Math.max(0, Math.floor((now - ctx.slotStartMs) / 1000));

      if (now - lastNoSignalLogAt >= NO_SIGNAL_LOG_INTERVAL_MS) {
        lastNoSignalLogAt = now;

        if (secsToOpen > 0) {
          ctx.log(
            `[${ctx.slug}] late-entry: pre-open wait (opens in ${secsToOpen}s)`,
            "yellow",
          );
          return;
        }

        if (priceToBeat === null && secsSinceOpen <= OPEN_PRICE_GRACE_AFTER_OPEN_S) {
          ctx.log(
            `[${ctx.slug}] late-entry: open price pending (${secsSinceOpen}s since open)`,
            "yellow",
          );
          return;
        }

        if (priceToBeat === null && secsSinceOpen >= OPEN_PRICE_HARD_TIMEOUT_S) {
          ctx.log(
            `[${ctx.slug}] late-entry: open price unavailable after ${secsSinceOpen}s — skipping round`,
            "red",
          );
          clearInterval(tickInterval);
          if (!state.released) {
            state.released = true;
            releaseLock();
          }
          return;
        }

        ctx.log(
          `[${ctx.slug}] late-entry: waiting — ${explainNoSignal({
            remaining,
            btcPrice: liveBtcPrice,
            oraclePrice,
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
          })}; secsSinceOpen=${secsSinceOpen}`,
          "yellow",
        );
      }
      return;
    }

    const gap = liveBtcPrice - priceToBeat;
    indicators.tick(gap, liveBtcPrice);

    const canEnter = !state.hasEntered && !state.exitInProgress;

    if (canEnter) {
      const signal =
        ENTRY_STRATEGY === "v2"
          ? checkEntryV2({
              remaining,
              btcPrice: liveBtcPrice,
              priceToBeat,
              up,
              down,
              rsi: indicators.rsi,
              atr: indicators.atr,
              rtv: indicators.rtv,
              gapSafety: indicators.gapSafety(gap),
              divergence: ctx.ticker.divergence,
              peakGapRatio: indicators.peakGapRatio(gap),
            })
          : checkEntry({
              remaining,
              btcPrice: liveBtcPrice,
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
        // Spread gate: wide spread = thin book = high slippage risk, skip.
        const currentBid = ctx.orderBook.bestBidPrice(signal.side);
        const spread = currentBid !== null ? signal.ask - currentBid : Infinity;

        if (spread > 0.04) {
          state.signalConfirmTicks = 0;
          ctx.log(
            `[${ctx.slug}] late-entry: no signal — spread_too_wide (ask=${signal.ask.toFixed(2)}, bid=${currentBid?.toFixed(2)}, spread=${spread.toFixed(2)})`,
            "yellow",
          );
        } else {
          state.signalConfirmTicks++;

          if (state.signalConfirmTicks >= 1) {
            state.hasEntered = true;
            state.signalConfirmTicks = 0;
            ctx.log(
              `[${ctx.slug}] late-entry: signal ${signal.side} @ ${signal.ask} (gap ${signal.gap.toFixed(0)}, liq $${signal.liquidity.toFixed(0)})`,
              "cyan",
            );
            placeEntry(ctx, state, signal);
          } else {
            ctx.log(
              `[${ctx.slug}] late-entry: signal_pending (1/2) — ${signal.side} @ ${signal.ask.toFixed(2)} spread=${spread.toFixed(2)} gap=${signal.gap.toFixed(0)}`,
              "yellow",
            );
          }
        }
      } else {
        state.signalConfirmTicks = 0;
        const now = Date.now();
        if (now - lastNoSignalLogAt >= NO_SIGNAL_LOG_INTERVAL_MS) {
          lastNoSignalLogAt = now;
          ctx.log(
            `[${ctx.slug}] late-entry: no signal — ${explainNoSignal({
              remaining,
              btcPrice: liveBtcPrice,
              oraclePrice,
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

    if (state.position) {
      state.hadPosition = true;
    }

    if (state.position && !state.stopLossFired && !state.exitInProgress) {
      checkStopLoss(ctx, state, remaining, gap, indicators.rsi, releaseLock);
    }
  }, 1000);

  return () => {
    clearInterval(tickInterval);
    if (!state.released) {
      state.released = true;
      releaseLock();
    }
  };
};
