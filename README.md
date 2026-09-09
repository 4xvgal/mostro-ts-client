# mostro-ts-client

TypeScript client library for the [Mostro](https://mostro.network) P2P
Lightning-over-Nostr marketplace. Protocol-compatible with `mostro-core`,
usable from Node or browser.

## Install

```bash
npm install mostro-ts-client
```

## Quick start

```ts
import { MostroClient, openSqliteStore } from "mostro-ts-client";

const client = new MostroClient({
  mnemonic,              // BIP-39 seed
  mostroPubkey,          // instance pubkey (hex)
  relays: ["wss://relay.example"],
  store: openSqliteStore(),   // or openIndexedDbStore() in browser
});

await client.start();

client.onOrders((orders) => renderBook(orders));          // order book
client.onTrade(id, (state) => renderTrade(id, state));    // trade state
const created = await client.createOrder({ kind: "sell", fiatAmount: 100, paymentMethod: "SEPA" });
const take = await client.takeOrder(order);               // next UI step
await client.submitInvoice(orderId, bolt11);
await client.restore();                                   // session recovery
await client.stop();
```

## Features

- Mostro protocol v2 (NIP-44 kind-14) transport
- Order book (kind 38383), create/take orders, invoice submission
- Trade state machine + per-order DM history
- P2P chat (K_conv/K_sign), disputes, admin actions
- Blossom attachments (ChaCha20-Poly1305)
- Session restore; SQLite (Node) and IndexedDB (browser) stores
- React store bindings (`src/react/`)

## Local regtest stack

Fully self-contained dev environment (bitcoind + LND ×2 + nostr relay +
Mostro daemon). Funds the nodes and opens the channel automatically:

```bash
cd docker
MOSTRO_RELAY_LOCAL_PORT=7080 docker compose -f docker-compose.regtest.yml up --build
```

The `regtest-init` one-shot service waits for readiness, mines blocks, funds
both LND nodes and opens a channel, then exits 0. Mostro publishes instance
info to `ws://localhost:7080` — the default TUI/client relay.

## Requirements

Node 22+ (`node:sqlite`). Browsers: any IndexedDB-capable modern browser.

## Development

```bash
npm test
```

Dev harness: `npx tsx tui/main.ts` (needs the local regtest stack).