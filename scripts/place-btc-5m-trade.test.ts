import { describe, expect, it } from "bun:test";
import { chooseBestSide, placeBtc5mTrade } from "./place-btc-5m-trade.ts";

describe("chooseBestSide", () => {
  it("picks the side with higher liquidity", () => {
    expect(
      chooseBestSide(
        { price: 0.5, liquidity: 10 },
        { price: 0.49, liquidity: 20 },
      ),
    ).toBe("DOWN");
  });
});

describe("placeBtc5mTrade", () => {
  it("falls back from FOK to GTC and sends the right order", async () => {
    const calls: any[] = [];

    const fakeClient = {
      init: async () => {},
      postMultipleOrders: async (orders: any[]) => {
        calls.push(...orders);
        const order = orders[0];
        if (order.orderType === "FOK") {
          return [
            {
              orderId: "",
              status: "",
              success: true,
              errorMsg: "order couldn't be fully filled. FOK orders are fully filled or killed.",
            },
          ];
        }
        return [
          {
            orderId: "order-123",
            status: "live",
            success: true,
            errorMsg: "",
          },
        ];
      },
    };

    const fakeApiQueue = {
      eventDetails: new Map([
        [
          "btc-updown-5m-123",
          {
            negRisk: false,
            markets: [{ clobTokenIds: JSON.stringify(["up-token", "down-token"]) }],
          },
        ],
      ]),
      queueEventDetails: async (_slug: string) => {},
    };

    const fakeOrderBook = {
      subscribe: (_tokenIds: string[]) => {},
      waitForReady: async () => {},
      bestAskInfo: (side: "UP" | "DOWN") =>
        side === "UP"
          ? { price: 0.51, liquidity: 100 }
          : { price: 0.49, liquidity: 10 },
      getTokenId: (side: "UP" | "DOWN") =>
        side === "UP" ? "up-token" : "down-token",
      getTickSize: (_tokenId: string) => "0.01",
      getFeeRate: (_tokenId: string) => 72,
    };

    const result = await placeBtc5mTrade(
      {
        client: fakeClient as any,
        apiQueue: fakeApiQueue as any,
        orderBook: fakeOrderBook as any,
      },
      {
        slug: "btc-updown-5m-123",
        side: "auto",
        shares: 1,
      },
    );

    expect(result.side).toBe("UP");
    expect(result.mode).toBe("GTC");
    expect(result.tokenId).toBe("up-token");
    expect(result.price).toBe(0.51);
    expect(calls).toHaveLength(3);
    expect(calls[0].orderType).toBe("FOK");
    expect(calls[0].tokenId).toBe("up-token");
    expect(calls[1].orderType).toBe("FOK");
    expect(calls[1].tokenId).toBe("down-token");
    expect(calls[2].orderType).toBe("GTC");
    expect(calls[2].tokenId).toBe("up-token");
    expect(calls[2].shares).toBe(1);
  });
});
