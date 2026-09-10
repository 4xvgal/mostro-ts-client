# mostro-ts-client

TypeScript client library for the [Mostro](https://mostro.network) P2P
Lightning-over-Nostr marketplace. Protocol-compatible with `mostro-core`,
usable from Node or browser.

## Install

```bash
npm install mostro-ts-client
```

## Quick start (Node)

```ts
import { MostroClient } from "mostro-ts-client";
import { openNodeSqliteStore } from "mostro-ts-client/node";

const client = new MostroClient({
  mnemonic,                    // BIP-39 seed
  mostroPubkey,                // instance pubkey (hex)
  relays: ["wss://relay.example"],
  store: openNodeSqliteStore("./mostro.db"),
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

## Browser / React

```ts
import { MostroClient } from "mostro-ts-client";
import { openIndexedDbStore } from "mostro-ts-client/browser";

const client = new MostroClient({
  mnemonic,
  mostroPubkey,
  relays,
  store: openIndexedDbStore({ dbName: "mostro" }), // optional { encryptor }
});
```

```tsx
import { createMostroStore, bindMostroStore } from "mostro-ts-client/react";

const uiStore = createMostroStore();
uiStore.connect(client);              // bind before client.start()
const { useMostroStore } = bindMostroStore(uiStore);

const orders = useMostroStore((s) => s.orders);
```

Pass `{ encryptor: rawKeyEncryptor(key32) }` to the store to encrypt sensitive
columns at rest (Argon2id/passphrase or wallet-injected 32-byte key).

## Features

- Mostro protocol v2 (NIP-44 kind-14) transport
- Order book (kind 38383), create/take orders, invoice submission
- Trade state machine + per-order DM history
- P2P chat (K_conv/K_sign), disputes, admin actions
- Blossom attachments (ChaCha20-Poly1305)
- Session restore; SQLite (`/node`, `/bun`) and IndexedDB (`/browser`) stores
- React bindings at `mostro-ts-client/react` (framework-agnostic zustand store + `useMostroStore`)

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

## License

[MIT](LICENSE)