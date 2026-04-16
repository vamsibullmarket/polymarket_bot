#!/usr/bin/env bun
import { APIQueue } from "../tracker/api-queue.ts";
import { OrderBook } from "../tracker/orderbook.ts";
import {
  PolymarketEarlyBirdClient,
  type MultiOrderRequest,
  type PlacedOrder,
} from "../engine/client.ts";
import { getSlug } from "../utils/slot.ts";

export type TradeSide = "UP" | "DOWN";
export type TradeMode = "FOK" | "GTC";

type BestAsk = { price: number; liquidity: number };

type MarketInfo = {
  negRisk: boolean;
  markets: [{ clobTokenIds: string }];
};

type TradeDeps = {
  client: Pick<PolymarketEarlyBirdClient, "init" | "postMultipleOrders">;
  apiQueue: Pick<APIQueue, "queueEventDetails" | "eventDetails">;
  orderBook: Pick<
    OrderBook,
    | "subscribe"
    | "waitForReady"
    | "bestAskInfo"
    | "getTokenId"
    | "getTickSize"
    | "getFeeRate"
  >;
};

export type TradeResult = {
  slug: string;
  side: TradeSide;
  mode: TradeMode;
  tokenId: string;
  price: number;
  shares: number;
  response: PlacedOrder[];
};

export function chooseBestSide(up: BestAsk | null, down: BestAsk | null): TradeSide {
  if (up && down) return up.liquidity >= down.liquidity ? "UP" : "DOWN";
  if (up) return "UP";
  if (down) return "DOWN";
  throw new Error("No order book liquidity available for either side");
}

function otherSide(side: TradeSide): TradeSide {
  return side === "UP" ? "DOWN" : "UP";
}

function isPlaced(response: PlacedOrder[]): boolean {
  return Boolean(response[0]?.orderId);
}

export async function placeBtc5mTrade(
  deps: TradeDeps,
  opts?: {
    slug?: string;
    side?: TradeSide | "auto";
    shares?: number;
  },
): Promise<TradeResult> {
  const slug = opts?.slug ?? getSlug(0);
  const shares = opts?.shares ?? 1;
  const requestedSide = opts?.side ?? "auto";

  await deps.client.init();
  await deps.apiQueue.queueEventDetails(slug);

  const event = deps.apiQueue.eventDetails.get(slug) as MarketInfo | undefined;
  if (!event?.markets?.[0]) {
    throw new Error(`No market data found for slug ${slug}`);
  }

  const tokenIds = JSON.parse(event.markets[0].clobTokenIds) as [string, string];
  deps.orderBook.subscribe(tokenIds);
  await deps.orderBook.waitForReady();

  const upAsk = deps.orderBook.bestAskInfo("UP");
  const downAsk = deps.orderBook.bestAskInfo("DOWN");
  const preferredSide =
    requestedSide === "auto"
      ? chooseBestSide(upAsk, downAsk)
      : requestedSide;
  const candidateSides: TradeSide[] =
    requestedSide === "auto"
      ? [preferredSide, otherSide(preferredSide)]
      : [preferredSide];

  for (const side of candidateSides) {
    const ask = side === "UP" ? upAsk : downAsk;
    if (!ask) continue;

    const tokenId = deps.orderBook.getTokenId(side);
    const tickSize = deps.orderBook.getTickSize(tokenId);
    const feeRateBps = deps.orderBook.getFeeRate(tokenId);

    const fokOrder: MultiOrderRequest = {
      tokenId,
      action: "buy",
      price: ask.price,
      shares,
      tickSize,
      negRisk: event.negRisk,
      feeRateBps,
      orderType: "FOK",
    };

    const fokResponse = await deps.client.postMultipleOrders([fokOrder]);
    if (isPlaced(fokResponse)) {
      return {
        slug,
        side,
        mode: "FOK",
        tokenId,
        price: ask.price,
        shares,
        response: fokResponse,
      };
    }
  }

  const side = requestedSide === "auto" ? preferredSide : requestedSide;
  const ask = side === "UP" ? upAsk : downAsk;
  if (!ask) {
    throw new Error(`No ask liquidity found for ${side}`);
  }

  const tokenId = deps.orderBook.getTokenId(side);
  const tickSize = deps.orderBook.getTickSize(tokenId);
  const feeRateBps = deps.orderBook.getFeeRate(tokenId);

  const gtcOrder: MultiOrderRequest = {
    tokenId,
    action: "buy",
    price: ask.price,
    shares,
    tickSize,
    negRisk: event.negRisk,
    feeRateBps,
    orderType: "GTC",
  };

  const gtcResponse = await deps.client.postMultipleOrders([gtcOrder]);
  if (!isPlaced(gtcResponse)) {
    const msg = gtcResponse[0]?.errorMsg || "order placement returned no orderId";
    throw new Error(msg);
  }

  return {
    slug,
    side,
    mode: "GTC",
    tokenId,
    price: ask.price,
    shares,
    response: gtcResponse,
  };
}

async function main() {
  process.env["MARKET_ASSET"] ||= "btc";
  process.env["MARKET_WINDOW"] ||= "5m";

  const sideArg = (process.argv.find((arg) => arg.startsWith("--side="))?.split("=")[1] ??
    "auto") as TradeSide | "auto";
  const sharesArg = Number(
    process.argv.find((arg) => arg.startsWith("--shares="))?.split("=")[1] ?? "1",
  );
  const slugArg = process.argv.find((arg) => arg.startsWith("--slug="))?.split("=")[1];

  const result = await placeBtc5mTrade(
    {
      client: new PolymarketEarlyBirdClient(),
      apiQueue: new APIQueue(),
      orderBook: new OrderBook(),
    },
    {
      slug: slugArg,
      side: sideArg,
      shares: sharesArg,
    },
  );

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
