import { PolymarketEarlyBirdClient } from "./engine/client.ts";

async function main() {
  const client = new PolymarketEarlyBirdClient();
  await client.init();

  const res = await client.postMultipleOrders([
    {
      tokenId: "53148187488145649434480598025634217757801934777184554725940806379222987811334",
      action: "buy",
      price: 0.51,
      shares: 1,
      tickSize: "0.01",
      negRisk: false,
      feeRateBps: 0,
      orderType: "GTC",
    },
  ]);

  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
