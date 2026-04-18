import { fetchWithRetry } from "../utils/fetch-retry";
import { Env } from "../utils/config";
import type { Slot } from "../utils/slot";

export type MarketData = {
  startTime: number;
  endTime: number;
  completed: boolean;
  openPrice: number;
  closePrice: number | null;
};

export type EventResponse = {
  id: string;
  ticker: string;
  negRisk: boolean;
  markets: {
    id: string;
    conditionId: string;
    clobTokenIds: string; // JSON array string e.g. '["upId","downId"]'
    outcomes: string; // JSON array string e.g. '["Up","Down"]'
    outcomePrices: string; // JSON array string e.g. '["0.99","0.01"]'
    closed: boolean;
    feeSchedule?: {
      rate: number;
      exponent: number;
      takerOnly: boolean;
      rebateRate: number;
    };
  }[];
};

export class APIQueue {
  private eventResponse: Map<string, EventResponse> = new Map();
  private _marketResult: Map<number, MarketData> = new Map();
  private _queuedSlots = new Set<number>();

  get eventDetails() {
    return this.eventResponse;
  }

  get marketResult() {
    return this._marketResult;
  }

  async queueEventDetails(slug: string) {
    const res = await fetchWithRetry(
      `https://gamma-api.polymarket.com/events?slug=${slug}`,
    );
    const event: EventResponse = ((await res.json()) as any[])[0];
    this.eventResponse.set(slug, event);
  }
  
  queueMarketPrice(slot: Slot): { cancel: () => void } {
    if (this._queuedSlots.has(slot.startTime)) return { cancel: () => {} };
    this._queuedSlots.add(slot.startTime);
  
    const { startTime, endTime } = slot;
    const controller = new AbortController();
  
    const url = new URL("https://polymarket.com/api/crypto/crypto-price");
    url.searchParams.set("symbol", Env.getAssetConfig().apiSymbol);
    url.searchParams.set("variant", "fiveminute");
    url.searchParams.set("eventStartTime", startTime.toString());
    url.searchParams.set("endDate", endTime.toString());
  
    fetchWithRetry(url, {
      options: { headers: { Accept: "application/json" } },
      useCurl: false,
      totalRetry: Number.MAX_VALUE,
      abort: controller.signal,
      resolveWhen: async (res) => {
        const data = (await res.json()) as MarketData & {
          timestamp?: number;
          completed?: boolean;
          incomplete?: boolean;
          cached?: boolean;
        };
  
        // Persist every response so open/close keep refreshing over time.
        const prev = this.marketResult.get(slot.startTime);
        this.marketResult.set(slot.startTime, {
          startTime,
          endTime,
          completed: Boolean(data.completed),
          openPrice: data.openPrice ?? prev?.openPrice ?? null,
          closePrice: data.closePrice ?? prev?.closePrice ?? null,
        } as MarketData);
  
        // Keep retrying until close is available (market fully resolved).
        if (data.closePrice != null) {
          return data;
        }
  
        throw new Error("Market not resolved yet (closePrice missing)");
      },
      retryBackOff: () => 1500,
    });
  
    return { cancel: () => controller.abort() };
  }
}
