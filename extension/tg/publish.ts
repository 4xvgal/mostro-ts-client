// Publish with per-relay results + optional retries (partial-failure handling).

import type { NostrEvent } from "nostr-tools/core";
import type { EventPublisher } from "./graph.js";

export interface RelayPublish {
  relay: string;
  ok: boolean;
  error?: string;
}

export interface PublishReport {
  eventId: string;
  relays: RelayPublish[];
  /** True if at least one relay accepted the event. */
  ok: boolean;
}

export interface PublishResult {
  event: NostrEvent;
  report: PublishReport;
}

/** Thrown by TrustGraph authoring when no relay accepted the event. */
export class PublishError extends Error {
  constructor(message: string, readonly report: PublishReport) {
    super(message);
    this.name = "PublishError";
  }
}

/**
 * Publish to every relay, collecting per-relay outcomes. Failed relays are
 * retried up to `retries` times. `ok` is true if at least one relay accepted.
 */
export async function publishEvent(
  pool: EventPublisher,
  relays: string[],
  event: NostrEvent,
  opts: { retries?: number } = {},
): Promise<PublishReport> {
  const retries = Math.max(0, opts.retries ?? 0);
  const outcome = new Map<string, RelayPublish>();
  let targets = [...relays];

  for (let attempt = 0; attempt <= retries && targets.length > 0; attempt++) {
    let settled: PromiseSettledResult<string>[];
    try {
      settled = await Promise.allSettled(pool.publish(targets, event));
    } catch (err) {
      settled = targets.map(() => ({ status: "rejected", reason: err }) as PromiseRejectedResult);
    }
    const failed: string[] = [];
    settled.forEach((r, i) => {
      const relay = targets[i] ?? relays[i] ?? `#${i}`;
      if (r.status === "fulfilled") {
        outcome.set(relay, { relay, ok: true });
      } else {
        outcome.set(relay, { relay, ok: false, error: String(r.reason) });
        failed.push(relay);
      }
    });
    targets = failed;
  }

  const reportRelays = relays.map((relay) => outcome.get(relay) ?? { relay, ok: false, error: "not attempted" });
  return { eventId: event.id, relays: reportRelays, ok: reportRelays.some((r) => r.ok) };
}
