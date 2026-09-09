// Live read-only smoke test against the public Mostro relay.
// Fetches instance info (38385) + order book (38383) and parses with our
// Phase 1 protocol layer. Run: npx tsx test/live.ts

import { SimplePool } from "nostr-tools/pool";
import { deserializeMessage, messageFromJson, kindFromString, statusFromString } from "../src/protocol/index.js";

const RELAY = "wss://relay.mostro.network";
const MOSTRO_PUBKEY = "82fa8cb978b43c79b2156585bac2c011176a21d2aead6d9f7c575c005be88390";
const ORDER_KIND = 38383;
const INFO_KIND = 38385;

async function main() {
  const pool = new SimplePool();
  console.log(`connecting: ${RELAY}`);

  // 1. Instance info (kind 38385, author = mostro pubkey)
  const infoEvent = await pool.get([RELAY], {
    kinds: [INFO_KIND],
    authors: [MOSTRO_PUBKEY],
  });
  if (!infoEvent) {
    console.log("no instance info event found");
  } else {
    console.log(`\n=== instance info (kind 38385) ===`);
    console.log(`event id: ${infoEvent.id.slice(0, 16)}...`);
    console.log(`created_at: ${new Date(infoEvent.created_at * 1000).toISOString()}`);
    const tags = infoEvent.tags.map((t) => `[${t.join(", ")}]`).join(" ");
    console.log(`tags: ${tags}`);
    if (infoEvent.content) {
      try {
        const parsed = JSON.parse(infoEvent.content);
        console.log(`content: ${JSON.stringify(parsed, null, 2)}`);
      } catch {
        console.log(`content: ${infoEvent.content}`);
      }
    }
  }

  // 2. Recent orders (kind 38383) — public order book is TAG-based (content
  //    is empty); DMs carry the JSON Message in content. Parse the tags.
  const orderEvents = await pool.querySync([RELAY], {
    kinds: [ORDER_KIND],
    limit: 5,
  });
  console.log(`\n=== order book (kind 38383): ${orderEvents.length} events ===`);
  for (const ev of orderEvents) {
    console.log(`\n--- ${ev.id.slice(0, 16)}... d-tag=${(ev.tags.find((t) => t[0] === "d") ?? [])[1] ?? "?"}`);
    if (ev.content) {
      try {
        const m = messageFromJson(JSON.parse(ev.content));
        console.log(`  content JSON parsed: variant=${m.variant}`);
      } catch (e) {
        console.log(`  content PARSE FAIL: ${(e as Error).message}`);
      }
    }
    const t = Object.fromEntries(
      ev.tags.filter((tag) => tag.length >= 2 && !tag[0].startsWith("#")).map((tag) => [tag[0], tag[1]]),
    );
    console.log(
      `  tags: k=${t.k} f=${t.f} s=${t.s} amt=${t.amt} fa=${t.fa} pm=${t.pm} premium=${t.premium}`,
    );
    console.log(`  kind-parse=${kindFromString(t.k ?? "")} status-parse=${statusFromString(t.s ?? "")}`);
  }

  pool.close([RELAY]);
  console.log("\ndone");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});