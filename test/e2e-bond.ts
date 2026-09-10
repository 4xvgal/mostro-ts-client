// E2E: maker anti-abuse bond against a bond-enabled regtest daemon.
//
// Default: verifies that MostroClient.createOrder() surfaces the maker bond
// as next: { type: "pay-bond", role: "maker", invoice, amount }.
//
// BOND_PAY=1: full path — pays the bond hold invoice from lnd-bob and waits
// until the order goes live (Mostro flips WaitingMakerBond -> Pending, emits
// the NIP-33 order event, and sends the NewOrder ack DM). Then cancels the
// order to release the bond. This exercises the whole maker-bond lifecycle.
//
// Requires the bond-mode override:
//   MOSTRO_RELAY_LOCAL_PORT=7080 docker compose \
//     -f docker/docker-compose.regtest.yml -f docker/docker-compose.bond.yml \
//     up -d --force-recreate mostro
//
// Run:
//   npx tsx test/e2e-bond.ts
//   BOND_PAY=1 npx tsx test/e2e-bond.ts

import { execFileSync, spawn } from "node:child_process";
import { SimplePool } from "nostr-tools/pool";
import {
  MostroClient,
  generateMnemonic,
  mnemonicToSeed,
  mostroInfoFromTags,
  instanceBondsEnabled,
  NOSTR_INFO_EVENT_KIND,
} from "../src/protocol/index.js";
import { openNodeSqliteStore } from "../src/protocol/node-store.js";
import { infoFromRelay } from "./lib/relay.js";

const RELAY = "ws://localhost:7080";
const RELAYS = [RELAY];
const BOND_PAY = process.env.BOND_PAY === "1";

function ln(args: string[]): string {
  return execFileSync("./scripts/ln.sh", args, { encoding: "utf8" });
}

/**
 * Pay a hold invoice without waiting. `lncli payinvoice` does not return for a
 * hold invoice (the HTLC stays in-flight until Mostro settles/cancels it), so
 * run it detached and detect success via the order going live instead.
 */
function lnDetached(args: string[]): void {
  const child = spawn("./scripts/ln.sh", args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");

  const infoEvent = await pool.get(RELAYS, {
    kinds: [NOSTR_INFO_EVENT_KIND],
    authors: [mostroPubkey],
    limit: 1,
  });
  const info = infoEvent ? mostroInfoFromTags(infoEvent.tags) : null;
  pool.close(RELAYS);

  if (!instanceBondsEnabled(info)) {
    console.log("bond disabled on this instance — skipping (run the bond-mode override)");
    return;
  }

  const client = new MostroClient({
    seed: mnemonicToSeed(generateMnemonic()),
    mostroPubkey,
    relays: RELAYS,
    store: openNodeSqliteStore(),
  });
  await client.start();

  try {
    const res = await client.createOrder({
      kind: "sell",
      fiatAmount: 25,
      paymentMethod: "SEPA",
      expirationDays: 1,
    });
    console.log("createOrder ->", JSON.stringify(res, null, 2));

    if (res.next.type !== "pay-bond") throw new Error(`expected next.type="pay-bond", got ${res.next.type}`);
    const bond = res.next;
    if (bond.role !== "maker") throw new Error(`expected role="maker", got ${bond.role}`);
    if (!bond.invoice.startsWith("lnbc")) throw new Error(`expected a bolt11 invoice, got ${bond.invoice}`);
    if (typeof bond.amount !== "number" || bond.amount <= 0) {
      throw new Error(`expected a positive bond amount, got ${bond.amount}`);
    }
    if (res.status !== "waiting-maker-bond") {
      throw new Error(`expected status="waiting-maker-bond", got ${res.status}`);
    }
    const invoice = bond.invoice;

    if (!BOND_PAY) {
      console.log(`\npay with: scripts/ln.sh payinvoice ${invoice}`);
      console.log("E2E-BOND OK");
      return;
    }

    // --- full path: pay the hold invoice, wait for the order to go live ---
    try {
      console.log(ln(["rebalance", "50000"]).trim());
    } catch {
      console.log("rebalance skipped (bob may already have outbound liquidity)");
    }

    // Hold invoice: payinvoice never returns (HTLC held), so fire and forget.
    lnDetached(["payinvoice", invoice]);
    console.log("payinvoice dispatched (hold invoice stays in-flight)");

    // Library helper: resolves once Mostro publishes the order (bond accepted).
    await client.waitForOrderLive(res.orderId, 30_000);
    console.log("order live: pending (NewOrder ack / orderbook)");

    // Release the bond by cancelling the (still pending) order.
    try {
      await client.cancelOrder(res.orderId);
      console.log("cancel sent — Mostro releases the bond hold invoice");
    } catch (e) {
      console.log("cancel skipped:", e instanceof Error ? e.message : String(e));
    }

    console.log("E2E-BOND OK");
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  console.error("E2E-BOND FAIL:", e);
  process.exit(1);
});
