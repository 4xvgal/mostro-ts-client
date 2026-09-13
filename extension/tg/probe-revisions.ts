// Probe: does the relay retain earlier revisions of a replaceable event?
// Decides whether first-seen (§12) can reconstruct an order's birth timestamp
// from a snapshot, or must observe live (§15 open item).
//
//   MOSTRO_RELAY=ws://localhost:7080 npx tsx extension/tg/probe-revisions.ts

import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { hex } from "@scure/base";

const RELAY = process.env.MOSTRO_RELAY ?? "ws://localhost:7080";
const KIND = 30500;

async function query(pool: SimplePool, pubkey: string): Promise<Array<{ id: string; created_at: number; tag: string; content: string }>> {
  const events = await pool.querySync([RELAY], { kinds: [KIND], authors: [pubkey] });
  return events.map((e) => ({
    id: e.id.slice(0, 8),
    created_at: e.created_at,
    tag: e.tags.find((t) => t[0] === "d")?.[1] ?? "",
    content: e.content,
  }));
}

async function main() {
  const pool = new SimplePool();
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const hexSk = hex.encode(sk);
  const d = `tg:probe:${Math.floor(Math.random() * 1e9)}`;
  const base = Math.floor(Date.now() / 1000);

  const publish = async (label: string, createdAt: number) => {
    const ev = finalizeEvent(
      { kind: KIND, created_at: createdAt, tags: [["d", d], ["p", pubkey]], content: label },
      hex.decode(hexSk),
    );
    await Promise.all(pool.publish([RELAY], ev));
    await new Promise((r) => setTimeout(r, 300));
    const rows = await query(pool, pubkey);
    const mine = rows.filter((r) => r.tag === d);
    console.log(
      `publish ${label.padEnd(8)} created_at=${createdAt} -> relay has ${mine.length}: ` +
        mine.map((m) => `${m.content}@${m.created_at}(#${m.id})`).join(", "),
    );
    return mine;
  };

  const r1 = await publish("rev1", base);
  const r2 = await publish("rev2", base + 5);
  const r3 = await publish("rev_old", base + 2); // earlier than rev2, later than rev1

  const final = await query(pool, pubkey);
  const mine = final.filter((r) => r.tag === d);
  console.log(`\nfinal revision count = ${mine.length}`);
  console.log(`survivor ts = ${mine.map((m) => m.created_at).join(",")} (expected rev2 = ${base + 5})`);

  const verdict =
    r1.length === 1 && r2.length === 1 && r3.length === 1 && mine.length === 1 && mine[0]!.created_at === base + 5
      ? "RETAIN-LATEST-ONLY"
      : "UNEXPECTED";
  console.log(`\nVERDICT: ${verdict}`);
  console.log("=> snapshot shows only the winning revision; original birth ts is NOT recoverable from the relay.");
  pool.close([RELAY]);
}

main().catch((e) => {
  console.error("probe FAIL:", e);
  process.exit(1);
});
