// Shared relay helpers for live/E2E tests.

import type { SimplePool } from "nostr-tools/pool";

export const NOSTR_INFO_KIND = 38385;

/**
 * Discover the Mostro instance pubkey from its kind-38385 info event.
 * Returns the author pubkey (hex) or null when absent.
 */
export async function infoFromRelay(pool: SimplePool, relay: string): Promise<string | null> {
  const ev = await pool.get([relay], { kinds: [NOSTR_INFO_KIND], limit: 1 });
  if (!ev) {
    return null;
  }
  return ev.pubkey;
}

/** Parse protocol-version tag from a kind-38385 event. */
export function protocolVersionFromTags(tags: string[][]): number | null {
  const t = tags.find((tag) => tag[0] === "protocol_version");
  return t ? Number.parseInt(t[1] ?? "", 10) : null;
}