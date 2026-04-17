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
    const endpoint = `https://gamma-api.polymarket.com/events?slug=${slug}`;
    console.log(`[api-queue] event request slug=${slug} url=${endpoint}`);
  
    const res = await fetchWithRetry(endpoint);
    const raw = await res.text();
  
    // FULL RAW RESPONSE BODY
    console.log(`[api-queue] event response slug=${slug} status=${res.status} body=${raw}`);
  
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.log(`[api-queue] event parse_error slug=${slug} err=${String(e)}`);
      throw e;
    }
  
    const list = parsed as any[];
    const event: EventResponse | undefined = list?.[0];
  
    if (!event) {
      throw new Error(`No event found for slug=${slug}`);
    }
  
    this.eventResponse.set(slug, event);
  }

  queueMarketPrice(slot: Slot): { cancel: () => void } {
    if (this._queuedSlots.has(slot.startTime)) return { cancel: () => {} };
    this._queuedSlots.add(slot.startTime);
  
    const { startTime, endTime } = slot;
    const controller = new AbortController();
  
    const slotStartSec = Math.floor(startTime / 1000);
    const slotEndSec = Math.floor(endTime / 1000);
  
    const url = new URL("https://polymarket.com/api/crypto/crypto-price");
    url.searchParams.set("symbol", Env.getAssetConfig().apiSymbol);
    url.searchParams.set("variant", "fiveminute");
    url.searchParams.set("eventStartTime", startTime.toString());
    url.searchParams.set("endDate", endTime.toString());
  
    console.log(
      `[api-queue] request slotStartMs=${startTime} slotEndMs=${endTime} slotStartSec=${slotStartSec} slotEndSec=${slotEndSec} url=${url.toString()}`,
    );
  
    fetchWithRetry(url, {
      options: { headers: { Accept: "application/json" } },
      useCurl: false,
      totalRetry: Number.MAX_VALUE,
      abort: controller.signal,
      resolveWhen: async (res) => {
        const raw = await res.text();
  
        // FULL RAW RESPONSE BODY
        console.log(
          `[api-queue] response status=${res.status} slotStartMs=${startTime} body=${raw}`,
        );
  
        let data: MarketData & {
          timestamp?: number;
          completed?: boolean;
          incomplete?: boolean;
          cached?: boolean;
        };
  
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.log(
            `[api-queue] parse_error slotStartMs=${startTime} err=${String(e)}`,
          );
          throw e;
        }
  
        if (data.openPrice != null) {
          this.marketResult.set(slot.startTime, data);
          console.log(
            `[api-queue] open_ready slotStartMs=${startTime} open=${data.openPrice} close=${data.closePrice}`,
          );
          return data;
        }
  
        throw new Error("Open price not set yet");
      },
      retryBackOff: (currentRetry) => {
        if (this.marketResult.get(slot.startTime)) {
          return 8000;
        }
        return currentRetry * 500;
      },
    });
  
    return { cancel: () => controller.abort() };
  }
}
