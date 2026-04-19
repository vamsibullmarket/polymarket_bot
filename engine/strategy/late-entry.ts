// Buy and Hold strategy

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
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
  /** Set when programmatic exit starts; cleared after resolution TSV append. */
  lastExitReason: string | null;
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

/** When `remaining <` this, use `checkEntryV2FinalStretch` (last ~25s). */
const TIGHT_ENTRY_REMAINING_THRESHOLD = 25;
/** Final-stretch CLOB band (inclusive) and liquidity floor. */
const TIGHT_ENTRY_PRICE_MIN = 0.7;
const TIGHT_ENTRY_PRICE_MAX = 0.91;
const TIGHT_ENTRY_MIN_LIQUIDITY = 120;

const FINAL_STRETCH_PEAK_GAP_RATIO_MIN = 0.5;
const FINAL_STRETCH_GAP_SAFETY_MIN = 7;
const FINAL_STRETCH_MAX_DIVERGENCE = 26;
/** Fixed per-share stop for final-stretch fills only (tighter than entry−0.20). */
const FINAL_STRETCH_STOP_LOSS_PRICE = 0.5;

/** V2 early-trend window (seconds remaining): |gap| > 80, ask 0.75–0.90, relaxed divergence. */
const EARLY_TREND_REMAINING_MIN = 151;
const EARLY_TREND_REMAINING_MAX = 270;
/** Reject when |gap| <= this (USD vs open). */
const EARLY_TREND_MIN_ABS_GAP = 80;
const EARLY_TREND_PRICE_MIN = 0.75;
const EARLY_TREND_PRICE_MAX = 0.9;
const EARLY_TREND_MAX_DIVERGENCE = 35;
const EARLY_TREND_MIN_LIQUIDITY = 150;
const EARLY_TREND_MIN_GAP_SAFETY = 7;
const EARLY_TREND_MIN_PEAK_GAP_RATIO = 0.48;

/** Prefer best bid on held side vs this threshold; fallback to mid if no bid. */
const SETTLEMENT_PREVIEW_THRESHOLD = 0.5;

const WINS_AND_LOSSES_PATH = "state/winsAndLosses.txt";
/** Tab: ISO slug side exitReason label priceUsed priceSource mid hindsight */
const LATE_ENTRY_RESOLUTION_LOG_PATH = "state/late-entry-stop-resolution.txt";

type WinsAndLossesTotals = {
  wins: number;
  losses: number;
  stopLossHits: number;
  stoppedThenPreviewWin: number;
  stoppedThenPreviewLoss: number;
};

function formatSignalTriggerLine(
  slug: string,
  params: {
    remaining: number;
    path: "final_stretch" | "normal" | "early_trend";
    signal: EntrySignal;
    gap: number;
    liveBtc: number;
    oraclePrice: number | undefined;
    priceToBeat: number;
    spread: number | null;
    up: { price: number; liquidity: number } | null;
    down: { price: number; liquidity: number } | null;
    rsi: number | null;
    atr: number | null;
    rtv: number | null;
    gapSafety: number | null;
    peakGapRatio: number | null;
    divergence: number | null;
    binancePrice: number | undefined;
    coinbasePrice: number | undefined;
  },
): string {
  const u = params.up;
  const d = params.down;
  const upS = u ? `${u.price.toFixed(2)}@${u.liquidity.toFixed(0)}` : "na";
  const downS = d ? `${d.price.toFixed(2)}@${d.liquidity.toFixed(0)}` : "na";
  return (
    `[${slug}] late-entry: SIGNAL_TRIGGER path=${params.path} remaining=${params.remaining}s ` +
    `side=${params.signal.side} ask=${params.signal.ask.toFixed(4)} ` +
    `spread=${params.spread != null ? params.spread.toFixed(4) : "na"} ` +
    `gap=${params.gap.toFixed(2)} gapAbs=${params.signal.gap.toFixed(2)} ` +
    `gapSafety=${params.gapSafety?.toFixed(2) ?? "na"} peakGap=${params.peakGapRatio?.toFixed(2) ?? "na"} ` +
    `live=${params.liveBtc.toFixed(2)} oracle=${params.oraclePrice?.toFixed(2) ?? "na"} open=${params.priceToBeat.toFixed(2)} ` +
    `binance=${params.binancePrice?.toFixed(2) ?? "na"} coinbase=${params.coinbasePrice?.toFixed(2) ?? "na"} ` +
    `rsi=${params.rsi?.toFixed(1) ?? "na"} atr=${params.atr?.toFixed(2) ?? "na"} rtv=${params.rtv?.toFixed(2) ?? "na"} ` +
    `div=${params.divergence?.toFixed(2) ?? "na"} ` +
    `up=${upS} down=${downS} liq_chosen=${params.signal.liquidity.toFixed(0)} stop=${params.signal.stopLossPrice.toFixed(2)}`
  );
}

function readWinsAndLosses(): WinsAndLossesTotals {
  const z: WinsAndLossesTotals = {
    wins: 0,
    losses: 0,
    stopLossHits: 0,
    stoppedThenPreviewWin: 0,
    stoppedThenPreviewLoss: 0,
  };
  if (!existsSync(WINS_AND_LOSSES_PATH)) {
    return z;
  }
  try {
    const raw = readFileSync(WINS_AND_LOSSES_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const winM = line.match(/^\s*Wins:\s*(\d+)\s*$/i);
      const lossM = line.match(/^\s*Losses:\s*(\d+)\s*$/i);
      const stopM = line.match(/^\s*StopLossHits:\s*(\d+)\s*$/i);
      const stWinM = line.match(/^\s*StoppedThenPreviewWin:\s*(\d+)\s*$/i);
      const stLossM = line.match(/^\s*StoppedThenPreviewLoss:\s*(\d+)\s*$/i);
      if (winM) {
        z.wins = parseInt(winM[1]!, 10);
      }
      if (lossM) {
        z.losses = parseInt(lossM[1]!, 10);
      }
      if (stopM) {
        z.stopLossHits = parseInt(stopM[1]!, 10);
      }
      if (stWinM) {
        z.stoppedThenPreviewWin = parseInt(stWinM[1]!, 10);
      }
      if (stLossM) {
        z.stoppedThenPreviewLoss = parseInt(stLossM[1]!, 10);
      }
    }
  } catch {
    // keep zeros on read error
  }
  return z;
}

function writeWinsAndLosses(t: WinsAndLossesTotals): void {
  mkdirSync("state", { recursive: true });
  writeFileSync(
    WINS_AND_LOSSES_PATH,
    `Wins: ${t.wins}\n` +
      `Losses: ${t.losses}\n` +
      `StopLossHits: ${t.stopLossHits}\n` +
      `StoppedThenPreviewWin: ${t.stoppedThenPreviewWin}\n` +
      `StoppedThenPreviewLoss: ${t.stoppedThenPreviewLoss}\n`,
    "utf8",
  );
}

function recordStopLossHit(): WinsAndLossesTotals {
  const cur = readWinsAndLosses();
  cur.stopLossHits += 1;
  writeWinsAndLosses(cur);
  return cur;
}

/**
 * Bump wins/losses (+ hindsight buckets after programmatic exit) when settlement-preview is logged.
 * `afterProgrammaticExit`: this trade used the exit path before preview — hindsight counters only then.
 */
function recordSettlementPreviewOutcome(
  label: "win_preview" | "loss_preview" | "uncertain" | "no_book",
  opts: { afterProgrammaticExit: boolean },
): WinsAndLossesTotals {
  const cur = readWinsAndLosses();
  if (label === "win_preview") {
    cur.wins += 1;
    if (opts.afterProgrammaticExit) {
      cur.stoppedThenPreviewWin += 1;
    }
  } else if (label === "loss_preview") {
    cur.losses += 1;
    if (opts.afterProgrammaticExit) {
      cur.stoppedThenPreviewLoss += 1;
    }
  }
  writeWinsAndLosses(cur);
  return cur;
}

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

function signalPriceForSettlement(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
): { price: number | null; source: "bid" | "mid" } {
  const bid = ctx.orderBook.bestBidPrice(side);
  if (bid !== null && !Number.isNaN(bid)) {
    return { price: bid, source: "bid" };
  }
  const mid = midForOutcome(ctx, side);
  return { price: mid, source: "mid" };
}

function classifySettlementPreview(
  signalPrice: number | null,
): "win_preview" | "loss_preview" | "uncertain" | "no_book" {
  if (signalPrice === null || Number.isNaN(signalPrice)) {
    return "no_book";
  }
  if (signalPrice > SETTLEMENT_PREVIEW_THRESHOLD) {
    return "win_preview";
  }
  if (signalPrice < SETTLEMENT_PREVIEW_THRESHOLD) {
    return "loss_preview";
  }
  return "uncertain";
}

function hindsightFromLabel(
  label: "win_preview" | "loss_preview" | "uncertain" | "no_book",
): "would_have_won" | "would_have_lost" | "uncertain" | "no_book" {
  if (label === "win_preview") {
    return "would_have_won";
  }
  if (label === "loss_preview") {
    return "would_have_lost";
  }
  if (label === "no_book") {
    return "no_book";
  }
  return "uncertain";
}

function appendLateEntryResolutionRow(params: {
  iso: string;
  slug: string;
  side: "UP" | "DOWN";
  exitReason: string;
  label: string;
  priceUsed: string;
  priceSource: string;
  mid: string;
  hindsight: string;
}): void {
  mkdirSync("state", { recursive: true });
  const row = [
    params.iso,
    params.slug,
    params.side,
    params.exitReason.replace(/\t/g, " "),
    params.label,
    params.priceUsed,
    params.priceSource,
    params.mid,
    params.hindsight,
  ].join("\t");
  appendFileSync(LATE_ENTRY_RESOLUTION_LOG_PATH, `${row}\n`, "utf8");
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

  const isV2FinalStretch =
    ENTRY_STRATEGY === "v2" &&
    params.remaining >= 1 &&
    params.remaining < TIGHT_ENTRY_REMAINING_THRESHOLD;

  if (params.rsi !== null) values.push(`rsi=${params.rsi.toFixed(2)}`);
  else if (isV2FinalStretch) values.push("rsi=na");
  else reasons.push("rsi_not_ready");

  if (params.atr !== null) values.push(`atr=${params.atr.toFixed(2)}`);
  else reasons.push("atr_not_ready");

  if (params.rtv !== null) values.push(`rtv=${params.rtv.toFixed(2)}`);
  else reasons.push("rtv_not_ready");

  if (params.gapSafety !== null) values.push(`gapSafety=${params.gapSafety.toFixed(2)}`);
  else if (isV2FinalStretch) values.push("gapSafety=na");
  else reasons.push("gap_safety_unavailable");

  if (params.divergence !== null) values.push(`divergence=${params.divergence.toFixed(2)}`);
  else reasons.push("coinbase_divergence_unavailable");

  if (params.peakGapRatio !== null) values.push(`peakGapRatio=${params.peakGapRatio.toFixed(2)}`);
  else if (isV2FinalStretch) values.push("peakGapRatio=na");
  else reasons.push("peak_gap_ratio_unavailable");

  if (params.remaining >= 5 && params.priceToBeat !== null && params.btcPrice !== undefined) {
    const gap = params.btcPrice - params.priceToBeat;
    values.push(`gap=${gap.toFixed(2)}`);

    if (params.remaining > 270) {
      reasons.push(`early_trend_in=${params.remaining - 270}s`);
    } else if (
      ENTRY_STRATEGY === "v2" &&
      params.remaining >= EARLY_TREND_REMAINING_MIN &&
      params.remaining <= EARLY_TREND_REMAINING_MAX
    ) {
      // Mirror checkEntryV2EarlyTrend
      if (params.atr === null) {
        reasons.push("atr_not_ready");
      } else if (params.atr > 22) {
        reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);
      }

      const divEt = params.divergence ?? Infinity;
      if (divEt > EARLY_TREND_MAX_DIVERGENCE) {
        reasons.push(`divergence_too_high=${params.divergence?.toFixed(2) ?? "na"}`);
      }

      if (params.rsi === null) {
        reasons.push("rsi_not_ready");
      } else {
        const inEarlyBand = (p: { price: number; liquidity: number } | null) =>
          p !== null &&
          p.price >= EARLY_TREND_PRICE_MIN &&
          p.price <= EARLY_TREND_PRICE_MAX &&
          p.liquidity >= EARLY_TREND_MIN_LIQUIDITY;

        const upStrongEt = inEarlyBand(params.up);
        const downStrongEt = inEarlyBand(params.down);

        if (!upStrongEt && !downStrongEt) {
          reasons.push(
            `early_trend_no_band_side(need_${EARLY_TREND_PRICE_MIN}-${EARLY_TREND_PRICE_MAX}@liq>=${EARLY_TREND_MIN_LIQUIDITY})`,
          );
        } else {
          let sideEt: "UP" | "DOWN";
          let infoEt: { price: number; liquidity: number };
          if (upStrongEt && downStrongEt) {
            if (gap > 8) {
              sideEt = "UP";
              infoEt = params.up!;
            } else if (gap < -8) {
              sideEt = "DOWN";
              infoEt = params.down!;
            } else {
              const upScoreEt = params.up!.price * params.up!.liquidity;
              const downScoreEt = params.down!.price * params.down!.liquidity;
              sideEt = upScoreEt >= downScoreEt ? "UP" : "DOWN";
              infoEt = sideEt === "UP" ? params.up! : params.down!;
            }
          } else if (upStrongEt) {
            sideEt = "UP";
            infoEt = params.up!;
          } else {
            sideEt = "DOWN";
            infoEt = params.down!;
          }

          if (Math.abs(gap) <= EARLY_TREND_MIN_ABS_GAP) {
            reasons.push(`gap_not_large_enough(need_|gap|>${EARLY_TREND_MIN_ABS_GAP})`);
          }
          if (
            params.peakGapRatio !== null &&
            params.peakGapRatio < EARLY_TREND_MIN_PEAK_GAP_RATIO
          ) {
            reasons.push(`peak_gap_ratio_low=${params.peakGapRatio.toFixed(2)}`);
          }
          if (
            params.gapSafety !== null &&
            params.gapSafety < EARLY_TREND_MIN_GAP_SAFETY
          ) {
            reasons.push(`gap_safety_low=${params.gapSafety.toFixed(2)}`);
          }
          if (sideEt === "UP" && params.rsi < 30) {
            reasons.push(`early_trend_rsi_contradicts_up(rsi=${params.rsi.toFixed(1)})`);
          }
          if (sideEt === "DOWN" && params.rsi > 70) {
            reasons.push(`early_trend_rsi_contradicts_down(rsi=${params.rsi.toFixed(1)})`);
          }
          if (sideEt === "UP" && gap < -8) {
            reasons.push(`gap_contradicts_up(gap=${gap.toFixed(0)})`);
          }
          if (sideEt === "DOWN" && gap > 8) {
            reasons.push(`gap_contradicts_down(gap=${gap.toFixed(0)})`);
          }
          if (params.atr !== null && params.atr < 0.05) {
            reasons.push(`atr_frozen_low=${params.atr.toFixed(2)}`);
          }
        }
      }
    } else if (params.remaining > 150) {
      reasons.push(`normal_window_in=${params.remaining - 150}s`);
    } else if (params.remaining < 1) {
      reasons.push(`too_late(remaining=${params.remaining}s)`);
    } else if (isV2FinalStretch) {
      // Mirror checkEntryV2FinalStretch
      if (params.atr === null) reasons.push("atr_not_ready");
      else if (params.atr > 22) reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);

      const divFs = params.divergence ?? Infinity;
      if (divFs > FINAL_STRETCH_MAX_DIVERGENCE) {
        reasons.push(`divergence_too_high=${params.divergence?.toFixed(2) ?? "na"}`);
      }

      if (
        params.peakGapRatio !== null &&
        params.peakGapRatio < FINAL_STRETCH_PEAK_GAP_RATIO_MIN
      ) {
        reasons.push(`peak_gap_ratio_low=${params.peakGapRatio.toFixed(2)}`);
      }

      if (
        params.gapSafety !== null &&
        params.gapSafety < FINAL_STRETCH_GAP_SAFETY_MIN
      ) {
        reasons.push(`gap_safety_low=${params.gapSafety.toFixed(2)}`);
      }

      const inTightBand = (p: { price: number; liquidity: number } | null) =>
        p !== null &&
        p.price >= TIGHT_ENTRY_PRICE_MIN &&
        p.price <= TIGHT_ENTRY_PRICE_MAX &&
        p.liquidity >= TIGHT_ENTRY_MIN_LIQUIDITY;

      const upOk = inTightBand(params.up);
      const downOk = inTightBand(params.down);

      if (!upOk && !downOk) {
        reasons.push(
          `final_stretch_no_tight_side(need_${TIGHT_ENTRY_PRICE_MIN}-${TIGHT_ENTRY_PRICE_MAX}@liq>=${TIGHT_ENTRY_MIN_LIQUIDITY})`,
        );
      } else {
        let side: "UP" | "DOWN";
        let info: { price: number; liquidity: number };
        if (upOk && downOk) {
          if (gap > 8) {
            side = "UP";
            info = params.up!;
          } else if (gap < -8) {
            side = "DOWN";
            info = params.down!;
          } else {
            const upScore = params.up!.price * params.up!.liquidity;
            const downScore = params.down!.price * params.down!.liquidity;
            side = upScore >= downScore ? "UP" : "DOWN";
            info = side === "UP" ? params.up! : params.down!;
          }
        } else if (upOk) {
          side = "UP";
          info = params.up!;
        } else {
          side = "DOWN";
          info = params.down!;
        }

        if (side === "UP" && gap < -8) {
          reasons.push(`gap_contradicts_up(gap=${gap.toFixed(0)})`);
        }
        if (side === "DOWN" && gap > 8) {
          reasons.push(`gap_contradicts_down(gap=${gap.toFixed(0)})`);
        }

        if (params.rsi !== null) {
          if (side === "UP" && params.rsi < 30) {
            reasons.push(`final_stretch_rsi_contradicts_up(rsi=${params.rsi.toFixed(1)})`);
          }
          if (side === "DOWN" && params.rsi > 70) {
            reasons.push(`final_stretch_rsi_contradicts_down(rsi=${params.rsi.toFixed(1)})`);
          }
        }

        if (params.atr !== null && params.atr < 0.05) {
          reasons.push(`atr_frozen_low=${params.atr.toFixed(2)}`);
        }
      }
    } else if (ENTRY_STRATEGY === "v1") {
      if (params.atr === null) reasons.push("atr_not_ready");
      else if (params.atr > 22) reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);

      if (params.divergence !== null && params.divergence > 18) reasons.push(`divergence_too_high=${params.divergence.toFixed(2)}`);

      const upStrong = params.up !== null && params.up.price >= 0.62 && params.up.liquidity >= 60;
      const downStrong = params.down !== null && params.down.price >= 0.62 && params.down.liquidity >= 60;
      if (!upStrong && !downStrong) reasons.push("no_strong_side");

      if (upStrong && gap < -20) reasons.push(`gap_contradicts_up(gap=${gap.toFixed(0)})`);
      if (downStrong && !upStrong && gap > 20) reasons.push(`gap_contradicts_down(gap=${gap.toFixed(0)})`);
    } else {
      // Mirror checkEntryV2 normal path: TIGHT_ENTRY_REMAINING_THRESHOLD..150
      if (
        params.remaining < TIGHT_ENTRY_REMAINING_THRESHOLD ||
        params.remaining > 150
      ) {
        reasons.push(
          `outside_v2_normal_window(need_${TIGHT_ENTRY_REMAINING_THRESHOLD}-150_remaining=${params.remaining})`,
        );
      }

      if (params.atr === null) reasons.push("atr_not_ready");
      else if (params.atr > 22) reasons.push(`atr_too_high=${params.atr.toFixed(2)}`);

      const div = params.divergence ?? Infinity;
      if (div > 18) {
        reasons.push(`divergence_too_high=${params.divergence?.toFixed(2) ?? "na"}`);
      }

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
            if (gap > 8) {
              side = "UP";
              info = params.up!;
            } else if (gap < -8) {
              side = "DOWN";
              info = params.down!;
            } else {
              const upScore = params.up!.price * params.up!.liquidity;
              const downScore = params.down!.price * params.down!.liquidity;
              side = upScore >= downScore ? "UP" : "DOWN";
              info = side === "UP" ? params.up! : params.down!;
            }
          } else if (upStrong) {
            side = "UP";
            info = params.up!;
          } else {
            side = "DOWN";
            info = params.down!;
          }

          if (Math.abs(gap) < 25) reasons.push(`gap_too_small(${gap.toFixed(1)})`);
          if (params.peakGapRatio !== null && params.peakGapRatio < 0.55) {
            reasons.push(`peak_gap_ratio_low=${params.peakGapRatio.toFixed(2)}`);
          }
          if (params.gapSafety !== null && params.gapSafety < 8) {
            reasons.push(`gap_safety_low=${params.gapSafety.toFixed(2)}`);
          }
          if (info.liquidity < 80) reasons.push(`liq_too_low=${info.liquidity.toFixed(0)}`);
          if (side === "UP" && params.rsi < 35) {
            reasons.push(`rsi_contradicts_up(rsi=${params.rsi.toFixed(1)})`);
          }
          if (side === "DOWN" && params.rsi > 65) {
            reasons.push(`rsi_contradicts_down(rsi=${params.rsi.toFixed(1)})`);
          }
          if (side === "UP" && gap < -8) reasons.push(`gap_contradicts_up(gap=${gap.toFixed(0)})`);
          if (side === "DOWN" && gap > 8) reasons.push(`gap_contradicts_down(gap=${gap.toFixed(0)})`);
          if (info.price < 0.74 || info.price > 0.9) {
            reasons.push(`price_outside_band=${info.price.toFixed(2)}(need_0.74-0.90)`);
          }
          if (params.atr !== null && params.atr < 0.05) {
            reasons.push(`atr_frozen_low=${params.atr.toFixed(2)}`);
          }
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
 * V2 entry for 151–270s remaining: |gap| > 80, ask in [0.75, 0.90], divergence cap 35.
 * Programmatic exit still uses `bidFloorUsd` 0.25 + market-turn (`positionExitShouldTrigger`).
 */
function checkEntryV2EarlyTrend(params: {
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
  const { btcPrice, priceToBeat, up, down, atr, divergence, rsi } = params;

  if (
    params.remaining < EARLY_TREND_REMAINING_MIN ||
    params.remaining > EARLY_TREND_REMAINING_MAX
  ) {
    return null;
  }

  if (atr === null || atr > 22) {
    return null;
  }

  const div = divergence ?? Infinity;
  if (div > EARLY_TREND_MAX_DIVERGENCE) {
    return null;
  }

  if (rsi === null) {
    return null;
  }

  const gap = btcPrice - priceToBeat;

  if (Math.abs(gap) <= EARLY_TREND_MIN_ABS_GAP) {
    return null;
  }

  if (
    params.gapSafety !== null &&
    params.gapSafety < EARLY_TREND_MIN_GAP_SAFETY
  ) {
    return null;
  }

  if (
    params.peakGapRatio !== null &&
    params.peakGapRatio < EARLY_TREND_MIN_PEAK_GAP_RATIO
  ) {
    return null;
  }

  const inBand = (p: { price: number; liquidity: number } | null) =>
    p !== null &&
    p.price >= EARLY_TREND_PRICE_MIN &&
    p.price <= EARLY_TREND_PRICE_MAX &&
    p.liquidity >= EARLY_TREND_MIN_LIQUIDITY;

  const upStrong = inBand(up);
  const downStrong = inBand(down);

  if (!upStrong && !downStrong) {
    return null;
  }

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

  if (side === "UP" && gap < -8) {
    return null;
  }
  if (side === "DOWN" && gap > 8) {
    return null;
  }

  if (side === "UP" && rsi < 30) {
    return null;
  }
  if (side === "DOWN" && rsi > 70) {
    return null;
  }

  if (atr !== null && atr < 0.05) {
    return null;
  }

  const stopLossPrice = Math.max(0.5, info.price - 0.2);

  return {
    side,
    ask: info.price,
    gap: Math.abs(gap),
    liquidity: info.liquidity,
    stopLossPrice,
  };
}

/**
 * When `remaining < TIGHT_ENTRY_REMAINING_THRESHOLD`: CLOB band [TIGHT_ENTRY_PRICE_MIN, TIGHT_ENTRY_PRICE_MAX],
 * relaxed divergence/peak/safety vs older final stretch; stop on signal is `FINAL_STRETCH_STOP_LOSS_PRICE`.
 */
function checkEntryV2FinalStretch(params: {
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
  const { btcPrice, priceToBeat, up, down, atr, divergence, rsi } = params;

  if (atr === null || atr > 22) {
    return null;
  }

  const div = divergence ?? Infinity;
  if (div > FINAL_STRETCH_MAX_DIVERGENCE) {
    return null;
  }

  const gap = btcPrice - priceToBeat;

  if (
    params.peakGapRatio !== null &&
    params.peakGapRatio < FINAL_STRETCH_PEAK_GAP_RATIO_MIN
  ) {
    return null;
  }

  if (
    params.gapSafety !== null &&
    params.gapSafety < FINAL_STRETCH_GAP_SAFETY_MIN
  ) {
    return null;
  }

  const inTightBand = (p: { price: number; liquidity: number } | null) =>
    p !== null &&
    p.price >= TIGHT_ENTRY_PRICE_MIN &&
    p.price <= TIGHT_ENTRY_PRICE_MAX &&
    p.liquidity >= TIGHT_ENTRY_MIN_LIQUIDITY;

  const upOk = inTightBand(up);
  const downOk = inTightBand(down);

  if (!upOk && !downOk) {
    return null;
  }

  let side: "UP" | "DOWN";
  let info: { price: number; liquidity: number };

  if (upOk && downOk) {
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
  } else if (upOk) {
    side = "UP";
    info = up!;
  } else {
    side = "DOWN";
    info = down!;
  }

  if (side === "UP" && gap < -8) {
    return null;
  }
  if (side === "DOWN" && gap > 8) {
    return null;
  }

  if (rsi !== null) {
    if (side === "UP" && rsi < 30) {
      return null;
    }
    if (side === "DOWN" && rsi > 70) {
      return null;
    }
  }

  if (atr !== null && atr < 0.05) {
    return null;
  }

  const stopLossPrice = FINAL_STRETCH_STOP_LOSS_PRICE;

  return {
    side,
    ask: info.price,
    gap: Math.abs(gap),
    liquidity: info.liquidity,
    stopLossPrice,
  };
}

/**
 * Strategy V2 entry: same base gates as V1 but adds:
 *  - RSI on gap must confirm direction (gap momentum alignment)
 *  - Tighter gap/direction sanity (-8/+8 vs -20/+20)
 *  - When both sides are strong, gap direction wins the tiebreaker first;
 *    price*liquidity score is only a secondary tiebreaker when gap is near zero
 *  - Entry price band (normal window): 0.74–0.90 per existing filters
 *  - When `remaining < TIGHT_ENTRY_REMAINING_THRESHOLD`: see `checkEntryV2FinalStretch`
 *  - When `151 <= remaining <= 270`: see `checkEntryV2EarlyTrend`
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

  if (remaining < 1) {
    return null;
  }

  if (
    remaining >= EARLY_TREND_REMAINING_MIN &&
    remaining <= EARLY_TREND_REMAINING_MAX
  ) {
    return checkEntryV2EarlyTrend(params);
  }

  if (remaining < TIGHT_ENTRY_REMAINING_THRESHOLD) {
    return checkEntryV2FinalStretch(params);
  }

  // --- Time window: normal path TIGHT_ENTRY_REMAINING_THRESHOLD..150 ---
  if (remaining < TIGHT_ENTRY_REMAINING_THRESHOLD || remaining > 150) {
    return null;
  }

  // --- Volatility gate ---
  if (atr === null || atr > 22) {
    return null;
  }

  // --- Exchange divergence gate ---
  const div = divergence ?? Infinity;
  if (div > 18) {
    return null;
  }

  // --- RSI must be ready ---
  if (rsi === null) {
    return null;
  }

  const gap = btcPrice - priceToBeat;

  // --- CLOB conviction ---
  const upStrong = up !== null && up.price >= 0.55 && up.liquidity >= 60;
  const downStrong = down !== null && down.price >= 0.55 && down.liquidity >= 60;
  if (!upStrong && !downStrong) {
    return null;
  }

  // --- Minimum absolute gap ---
  if (Math.abs(gap) < 25) {
    return null;
  }

  // --- Gap safety: |gap| / ATR must be meaningful ---
  if (params.gapSafety !== null && params.gapSafety < 8) {
    return null;
  }

  // --- Peak gap ratio: gap must still be near its peak ---
  if (params.peakGapRatio !== null && params.peakGapRatio < 0.55) {
    return null;
  }

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
  if (info.liquidity < 80) {
    return null;
  }

  // --- RSI momentum must agree with chosen side ---
  if (side === "UP" && rsi < 35) {
    return null;
  }
  if (side === "DOWN" && rsi > 65) {
    return null;
  }

  // --- Gap/direction sanity ---
  if (side === "UP" && gap < -8) {
    return null;
  }
  if (side === "DOWN" && gap > 8) {
    return null;
  }

  // --- Price band: 0.74–0.77 only ---
  // Strong conviction zone: meaningful upside to 1.00, -0.20 stop stays above 0.50
  if (info.price < 0.74 || info.price > 0.9) {
    return null;
  }

  if (atr !== null && atr < 0.05) {
    return null;
  }

  // Stop is fixed at entry - 0.20; floor at 0.50 as hard minimum
  const stopLossPrice = Math.max(0.5, info.price - 0.2);

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

  if (remaining < TIGHT_ENTRY_REMAINING_THRESHOLD || remaining > 150) {
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

const POSITION_EXIT_CFG = {
  /** Fire when best bid is at or below this (dollars per share). */
  bidFloorUsd: 0.25,
  /**
   * BTC vs strike must favor the *other* side by at least this many dollars
   * before the bid-floor exit is allowed (UP: gap <= -marketTurnGapUsd).
   */
  marketTurnGapUsd: 10,
  /** Last-minute weak-book exit: remaining seconds in the window. */
  lastMinuteRemainingSec: 60,
  /** Ask−bid must be at least this large in the last minute to count as “wide”. */
  lateSpreadMin: 0.04,
  /** With wide spread in the last minute, exit if bid is strictly below this. */
  lateWeakBidMax: 0.35,
} as const;

function marketTurnedAgainstPosition(pos: LateEntryPosition, gap: number | null): boolean {
  if (gap === null) {
    return false;
  }
  const t = POSITION_EXIT_CFG.marketTurnGapUsd;
  if (pos.side === "UP") {
    return gap <= -t;
  }
  return gap >= t;
}

function positionExitShouldTrigger(
  pos: LateEntryPosition,
  gap: number | null,
  remaining: number,
  currentBid: number | null,
  spread: number | null,
): { exit: boolean; reason: string | null } {
  const C = POSITION_EXIT_CFG;
  const turned = marketTurnedAgainstPosition(pos, gap);

  if (currentBid !== null && currentBid <= C.bidFloorUsd && turned) {
    return {
      exit: true,
      reason: `exit bid<=${C.bidFloorUsd} + market-turned gap=${gap?.toFixed(1) ?? "na"} side=${pos.side}`,
    };
  }

  if (
    remaining <= C.lastMinuteRemainingSec &&
    spread !== null &&
    spread >= C.lateSpreadMin &&
    currentBid !== null &&
    currentBid < C.lateWeakBidMax
  ) {
    return {
      exit: true,
      reason: `exit last-min wide-spread spread=${spread.toFixed(2)}>=${C.lateSpreadMin} bid=${currentBid.toFixed(2)}<${C.lateWeakBidMax} rem=${remaining}s`,
    };
  }

  return { exit: false, reason: null };
}

function checkStopLoss(
  ctx: StrategyContext,
  state: LateEntryState,
  remaining: number,
  gap: number | null,
  _rsi: number | null,
  _releaseLock: () => void,
  peakGapRatio: number | null,
): void {
  const pos = state.position;
  if (!pos || state.stopLossFired || state.exitInProgress) {
    return;
  }

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

  // --- Diagnostics only (display / logging). Exit decisions use `positionExitShouldTrigger` below. ---
  if (!pos.breakEvenLocked && pos.maxSeenBid >= 0.97) {
    pos.stopLossPrice = 0.92;
    pos.breakEvenLocked = true;
    ctx.log(
      `[${ctx.slug}] late-entry: stop promoted to 0.92 (bid hit 0.97, entry=${pos.entryPrice.toFixed(2)})`,
      "cyan",
    );
  }

  pos.prevBid = currentBid;

  const gapReversed =
    gap !== null &&
    ((pos.side === "UP" && gap < -10) || (pos.side === "DOWN" && gap > 10));

  if (gapReversed) {
    pos.gapRevTicks += 1;
  } else {
    pos.gapRevTicks = 0;
  }
  const gapRevStable = pos.gapRevTicks >= 3;

  const gapIsLarge = gap !== null && Math.abs(gap) > 20;

  const rawStopBreached =
    currentBid !== null && currentBid <= pos.stopLossPrice;

  if (rawStopBreached) {
    pos.stopBreachTicks += 1;
  } else {
    pos.stopBreachTicks = 0;
  }

  const stopGap =
    currentBid !== null ? pos.stopLossPrice - currentBid : 0;

  const bookIsEmpty = remaining < 25 && (currentBid ?? 0) < 0.3;

  const inResolutionHold =
    remaining < 90 &&
    pos.breakEvenLocked &&
    gap !== null &&
    ((pos.side === "UP" && gap > 5) || (pos.side === "DOWN" && gap < -5));

  const stopMode = gapIsLarge
    ? gapRevStable
      ? "gap-large-reversed"
      : "gap-large-protected"
    : !gapReversed
      ? "gap-small-normal"
      : "gap-small-reversal";

  const turned = marketTurnedAgainstPosition(pos, gap);
  const exit = positionExitShouldTrigger(pos, gap, remaining, currentBid, spread);
  if (!exit.exit) {
    const peakGapS =
      peakGapRatio !== null ? ` peakGapRatio=${peakGapRatio.toFixed(2)}` : "";
    ctx.log(
      `[${ctx.slug}] late-entry: pos-tick` +
        ` ask=${bestAsk?.toFixed(2) ?? "none"}` +
        ` bid=${currentBid?.toFixed(2) ?? "none"}` +
        ` spread=${spread != null ? spread.toFixed(2) : "?"}` +
        ` gap=${gap?.toFixed(1) ?? "null"}` +
        ` remainingSec=${remaining}s` +
        ` marketTurned=${turned}` +
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
        ` resolutionHold=${inResolutionHold}` +
        peakGapS,
      "dim",
    );
    return;
  }

  const exitReason = exit.reason ?? "position-exit";

  state.stopLossFired = true;
  state.exitInProgress = true;
  state.lastExitReason = exitReason;

  const tokenId = pos.tokenId;
  const side = pos.side;
  const DUST_SHARES = 0.5;

  let exitClosed = false;

  const resetAfterExit = (
    message?: string,
    color: "green" | "yellow" = "green",
    opts?: { recordStopLossHit?: boolean },
  ) => {
    if (exitClosed) {
      return;
    }

    exitClosed = true;
    state.position = null;
    state.stopLossFired = false;
    state.exitInProgress = false;

    if (opts?.recordStopLossHit) {
      recordStopLossHit();
    }

    if (message) {
      ctx.log(message, color);
    }
  };

  const tryExit = () => {
    if (exitClosed) {
      return;
    }

    if (Date.now() >= ctx.slotEndMs) {
      state.lastExitReason = null;
      resetAfterExit(
        `[${ctx.slug}] late-entry: exit abandoned — slot ended [${exitReason}]`,
        "yellow",
        { recordStopLossHit: false },
      );
      return;
    }

    const targetShares = ctx.getTrackedShares(tokenId);
    if (targetShares <= DUST_SHARES) {
      resetAfterExit(
        `[${ctx.slug}] late-entry: exit complete — remaining shares treated as dust (${targetShares.toFixed(6)}) [${exitReason}]`,
        "yellow",
        { recordStopLossHit: true },
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
            tryExit();
            return;
          }

          resetAfterExit(
            `[${ctx.slug}] late-entry: exit SELL filled @ ${sellPrice} (${filledShares} shares)`,
            "green",
            { recordStopLossHit: true },
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
              { recordStopLossHit: true },
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
              { recordStopLossHit: true },
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
    lastExitReason: null,
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

    // One-shot CLOB hint (no PnL): win_preview / loss_preview / uncertain — sampled at end of window only
    // so mid-round exits are not scored against an immature book.
    if (!state.settlementPreviewLogged && state.hadPosition) {
      const side = state.position?.side ?? state.lastTradeSide;
      if (!side) {
        ctx.log(
          `[${ctx.slug}] late-entry: settlement-preview skipped — no side (lastTradeSide missing)`,
          "yellow",
        );
        state.settlementPreviewLogged = true;
      } else {
        const mid = midForOutcome(ctx, side);
        const { price, source } = signalPriceForSettlement(ctx, side);
        const label = classifySettlementPreview(price);
        const fire = remaining <= 1 && !state.exitInProgress;
        if (fire) {
          const afterProgrammaticExit = state.lastExitReason !== null;
          const exitSnap = state.lastExitReason;
          const totals = recordSettlementPreviewOutcome(label, {
            afterProgrammaticExit,
          });
          const bidOnly = ctx.orderBook.bestBidPrice(side);
          const hindsight = hindsightFromLabel(label);
          if (exitSnap !== null) {
            appendLateEntryResolutionRow({
              iso: new Date().toISOString(),
              slug: ctx.slug,
              side,
              exitReason: exitSnap,
              label,
              priceUsed: price?.toFixed(4) ?? "na",
              priceSource: source,
              mid: mid?.toFixed(4) ?? "na",
              hindsight,
            });
            state.lastExitReason = null;
          }
          const color =
            label === "win_preview"
              ? "green"
              : label === "loss_preview"
                ? "red"
                : label === "no_book"
                  ? "yellow"
                  : "dim";
          const lossesInclStops = totals.losses + totals.stopLossHits;
          const tradeHint = afterProgrammaticExit
            ? ` this_trade_hindsight=${hindsight}`
            : "";
          ctx.log(
            `[${ctx.slug}] late-entry: settlement-preview side=${side} ` +
              `bid=${bidOnly?.toFixed(4) ?? "n/a"} mid=${mid?.toFixed(4) ?? "n/a"} ` +
              `price_used=${price?.toFixed(4) ?? "n/a"} source=${source} ` +
              `threshold=${SETTLEMENT_PREVIEW_THRESHOLD} label=${label} ` +
              `preview_wins=${totals.wins} preview_losses=${totals.losses} ` +
              `stop_hits=${totals.stopLossHits} losses_incl_stops=${lossesInclStops} ` +
              `stop_then_preview_win=${totals.stoppedThenPreviewWin} ` +
              `stop_then_preview_loss=${totals.stoppedThenPreviewLoss}` +
              tradeHint,
            color,
          );
          state.settlementPreviewLogged = true;
        }
      }
    }

    // Single-trade mode: stop only after we actually had a live position,
    // that position has fully exited, and settlement preview has logged.
    if (
      state.hadPosition &&
      !state.position &&
      !state.exitInProgress &&
      state.settlementPreviewLogged
    ) {
      clearInterval(tickInterval);
      if (!state.released) {
        state.released = true;
        releaseLock();
      }
      return;
    }

    if (
      remaining <= 5 &&
      !state.position &&
      !state.exitInProgress &&
      !(state.hadPosition && !state.settlementPreviewLogged)
    ) {
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
            const entryPath: "final_stretch" | "normal" | "early_trend" =
              remaining >= EARLY_TREND_REMAINING_MIN &&
              remaining <= EARLY_TREND_REMAINING_MAX
                ? "early_trend"
                : remaining < TIGHT_ENTRY_REMAINING_THRESHOLD
                  ? "final_stretch"
                  : "normal";

            ctx.log(
              formatSignalTriggerLine(ctx.slug, {
                remaining,
                path: entryPath,
                signal,
                gap,
                liveBtc: liveBtcPrice,
                oraclePrice,
                priceToBeat,
                spread: currentBid !== null ? signal.ask - currentBid : null,
                up,
                down,
                rsi: indicators.rsi,
                atr: indicators.atr,
                rtv: indicators.rtv,
                gapSafety: indicators.gapSafety(gap),
                peakGapRatio: indicators.peakGapRatio(gap),
                divergence: ctx.ticker.divergence,
                binancePrice,
                coinbasePrice,
              }),
              "magenta",
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
      checkStopLoss(
        ctx,
        state,
        remaining,
        gap,
        indicators.rsi,
        releaseLock,
        indicators.peakGapRatio(gap),
      );
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
