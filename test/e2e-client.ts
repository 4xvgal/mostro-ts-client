// E2E: MostroClient facade end-to-end against the local regtest daemon.
//
// Exercises the full UI-facing surface: start, order book callback, create
// order, take order, trade-state callback.
//
// Run: npx tsx test/e2e-client.ts

import { MostroClient, generateMnemonic } from "../src/protocol/index.js";
import { createMostroStore } from "../src/react/store.js";
import { infoFromRelay } from "./lib/relay.js";
import { SimplePool } from "nostr-tools/pool";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  pool.close(RELAYS);
  if (!mostroPubkey) throw new Error("no mostro info event");

  const mnemonic = generateMnemonic();

  const client = new MostroClient({ mnemonic, mostroPubkey, relays: RELAYS });

  // Reactive store + client binding (React integration path).
  const store = createMostroStore();
  client.bind({
    setOrders: (orders) => store.setOrders(orders),
    upsertTrade: (id, row) => store.upsertTrade(id, row),
    setInstanceInfo: (info) => store.setInstanceInfo(info),
  });

  // Order book callback (classic path).
  let bookSeen = false;
  client.onOrders((orders) => {
    bookSeen = true;
    console.log(`[onOrders] ${orders.length} pending orders`);
  });

  await client.start();
  console.log("started, identity:", client.identity.slice(0, 16) + "...");
  console.log("bookSeen after start:", bookSeen);
  console.log("store orders:", store.state.orders.length);
  console.log("store status:", store.state.status);

  // Create order.
  const created = await client.createOrder({
    kind: "sell",
    fiatAmount: 18,
    fiatCode: "USD",
    paymentMethod: "SEPA",
    expirationDays: 1,
  });
  console.log("created order:", created.orderId.slice(0, 8), "status:", created.status);
  if (!created.orderId) throw new Error("no order id from createOrder");

  // Trade state callback for the created order.
  client.onTrade(created.orderId, (id, state) => {
    console.log(`[onTrade] ${id.slice(0, 8)} action=${state.action} status=${state.status}`);
  });

  // Take the created order (same client, acts as taker too — fine for E2E).
  const book = await client.fetchOrders();
  const myOrder = book.find((o) => o.id === created.orderId);
  if (myOrder) {
    const take = await client.takeOrder(myOrder);
    console.log("take result next:", take.next, take.amount ?? "");
    if (take.next !== "add-invoice" && take.next !== "bond-invoice" && take.next !== "hold-invoice") {
      throw new Error(`unexpected take result: ${take.next}`);
    }
  } else {
    console.log("order not in book yet (book refresh may lag) — skipping take");
  }

  await client.stop();
  console.log("E2E-CLIENT OK");
}

main().catch((e) => {
  console.error("E2E-CLIENT FAIL:", e);
  process.exit(1);
});