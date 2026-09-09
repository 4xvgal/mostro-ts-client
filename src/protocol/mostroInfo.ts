// Mostro instance info (kind 38385) parsing and helpers.
// Ported from mostrix `src/util/mostro_info.rs`.

import { Transport, transportFromString } from "./transport.js";
import type { Action } from "./action.js";
import { NOSTR_INFO_EVENT_KIND } from "./constants.js";

/** Nostr kind for Mostro instance status events. */
export const MOSTRO_INSTANCE_INFO_KIND = NOSTR_INFO_EVENT_KIND;

/** Age in seconds after which instance info is considered stale (7 days). */
const INSTANCE_INFO_STALE_SECS = 604_800;

/** Structured representation of a Mostro instance info event (kind 38385). */
export interface MostroInstanceInfo {
  /** When the instance info event was created (event created_at). */
  last_updated: number | null;
  mostro_version: string | null;
  mostro_commit_hash: string | null;
  max_order_amount: number | null;
  min_order_amount: number | null;
  expiration_hours: number | null;
  expiration_seconds: number | null;
  fiat_currencies_accepted: string[];
  max_orders_per_response: number | null;
  fee: number | null;
  pow: number | null;
  /** First-contact PoW toll on v2; falls back to pow when absent. */
  pow_first_contact: number | null;
  /** Wire transport version (`1` / `2`). */
  protocol_version: number | null;
  /** Anti-abuse bond feature flag. */
  bond_enabled: boolean | null;
  hold_invoice_expiration_window: number | null;
  hold_invoice_cltv_delta: number | null;
  invoice_expiration_window: number | null;
  lnd_version: string | null;
  lnd_node_pubkey: string | null;
  lnd_commit_hash: string | null;
  lnd_node_alias: string | null;
  lnd_chains: string[];
  lnd_networks: string[];
  lnd_uris: string[];
}

export function emptyMostroInstanceInfo(): MostroInstanceInfo {
  return {
    last_updated: null,
    mostro_version: null,
    mostro_commit_hash: null,
    max_order_amount: null,
    min_order_amount: null,
    expiration_hours: null,
    expiration_seconds: null,
    fiat_currencies_accepted: [],
    max_orders_per_response: null,
    fee: null,
    pow: null,
    pow_first_contact: null,
    protocol_version: null,
    bond_enabled: null,
    hold_invoice_expiration_window: null,
    hold_invoice_cltv_delta: null,
    invoice_expiration_window: null,
    lnd_version: null,
    lnd_node_pubkey: null,
    lnd_commit_hash: null,
    lnd_node_alias: null,
    lnd_chains: [],
    lnd_networks: [],
    lnd_uris: [],
  };
}

/** True when last_updated is older than 7 days (or absent). */
export function isInstanceInfoStale(info: MostroInstanceInfo): boolean {
  if (info.last_updated === null) {
    return true;
  }
  const age = Math.floor(Date.now() / 1000) - info.last_updated;
  return age > INSTANCE_INFO_STALE_SECS;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBondEnabled(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") {
    return true;
  }
  if (v === "false" || v === "0" || v === "no") {
    return false;
  }
  return null;
}

/**
 * Build a MostroInstanceInfo from the tags of a kind-38385 event.
 * Unknown tags are ignored; missing tags leave fields null/empty.
 * Does NOT authenticate authorship — use selectAuthenticInstanceInfoEvent first.
 */
export function mostroInfoFromTags(tags: string[][]): MostroInstanceInfo {
  const info = emptyMostroInstanceInfo();
  for (const tag of tags) {
    if (tag.length === 0) {
      continue;
    }
    const key = tag[0];
    const value = tag[1] ?? "";
    switch (key) {
      case "mostro_version":
        info.mostro_version = value;
        break;
      case "mostro_commit_hash":
        info.mostro_commit_hash = value;
        break;
      case "max_order_amount":
        info.max_order_amount = parseIntSafe(value);
        break;
      case "min_order_amount":
        info.min_order_amount = parseIntSafe(value);
        break;
      case "expiration_hours":
        info.expiration_hours = parseIntSafe(value);
        break;
      case "expiration_seconds":
        info.expiration_seconds = parseIntSafe(value);
        break;
      case "fiat_currencies_accepted":
        info.fiat_currencies_accepted = splitCsv(value);
        break;
      case "max_orders_per_response":
        info.max_orders_per_response = parseIntSafe(value);
        break;
      case "fee":
        info.fee = parseFloatSafe(value);
        break;
      case "pow":
        info.pow = parseIntSafe(value);
        break;
      case "pow_first_contact":
        info.pow_first_contact = parseIntSafe(value);
        break;
      case "protocol_version":
        info.protocol_version = parseIntSafe(value);
        break;
      case "bond_enabled":
        info.bond_enabled = parseBondEnabled(value);
        break;
      case "hold_invoice_expiration_window":
        info.hold_invoice_expiration_window = parseIntSafe(value);
        break;
      case "hold_invoice_cltv_delta":
        info.hold_invoice_cltv_delta = parseIntSafe(value);
        break;
      case "invoice_expiration_window":
        info.invoice_expiration_window = parseIntSafe(value);
        break;
      case "lnd_version":
        info.lnd_version = value;
        break;
      case "lnd_node_pubkey":
        info.lnd_node_pubkey = value;
        break;
      case "lnd_commit_hash":
        info.lnd_commit_hash = value;
        break;
      case "lnd_node_alias":
        info.lnd_node_alias = value;
        break;
      case "lnd_chains":
        info.lnd_chains = splitCsv(value);
        break;
      case "lnd_networks":
        info.lnd_networks = splitCsv(value);
        break;
      case "lnd_uris":
        info.lnd_uris = splitCsv(value);
        break;
      default:
        break;
    }
  }
  return info;
}

function parseIntSafe(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) {
    return null;
  }
  const n = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

function parseFloatSafe(value: string): number | null {
  const n = Number.parseFloat(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** NIP-13 difficulty bits from cached instance info (tag `pow`); 0 when absent. */
export function nostrPowFromInstance(instance: MostroInstanceInfo | null): number {
  if (!instance || instance.pow === null) {
    return 0;
  }
  return Math.min(instance.pow, 255);
}

/** Effective first-contact PoW bits; falls back to base pow. */
export function effectivePowFirstContactFromInstance(instance: MostroInstanceInfo | null): number {
  if (!instance) {
    return 0;
  }
  return clampPowBits(instance.pow_first_contact ?? instance.pow);
}

function clampPowBits(bits: number | null): number {
  if (bits === null) {
    return 0;
  }
  return Math.min(bits, 255);
}

/** Protocol actions that introduce a new trade key to Mostro (v2 first-contact lane). */
export function isV2FirstContactProtocolAction(action: Action): boolean {
  return action === "new-order" || action === "take-buy" || action === "take-sell";
}

/**
 * NIP-13 bits for a protocol DM toward Mostro. v2 first-contact actions use
 * max(pow, pow_first_contact).
 */
export function nostrPowForProtocolDm(
  instance: MostroInstanceInfo | null,
  action: Action,
): number {
  const base = nostrPowFromInstance(instance);
  if (
    transportFromInstance(instance) === Transport.Nip44Direct &&
    isV2FirstContactProtocolAction(action)
  ) {
    return Math.max(base, effectivePowFirstContactFromInstance(instance));
  }
  return base;
}

/** Whether the instance has anti-abuse bonds enabled (explicit "true" tag). */
export function instanceBondsEnabled(instance: MostroInstanceInfo | null): boolean {
  return instance?.bond_enabled === true;
}

/** Resolve the wire transport from instance info; unknown version → GiftWrap. */
export function transportFromInstance(info: MostroInstanceInfo | null): Transport {
  if (info?.protocol_version === 2) {
    return Transport.Nip44Direct;
  }
  return Transport.GiftWrap;
}

/**
 * Whether a relay-returned kind-38385 event is safe to treat as Mostro
 * instance info (MOSTRO-075): kind 38385, correct author, matching d-tag.
 * Event signature verification is delegated to the caller (relay or verifyEvent).
 */
export function instanceInfoEventIsAuthentic(
  event: { kind: number; pubkey: string; tags: string[][] },
  mostroPubkeyHex: string,
): boolean {
  if (event.kind !== MOSTRO_INSTANCE_INFO_KIND) {
    return false;
  }
  if (event.pubkey !== mostroPubkeyHex) {
    return false;
  }
  const dTag = event.tags.find((t) => t[0] === "d")?.[1];
  return dTag === mostroPubkeyHex;
}

/** Pick the newest authentic instance-info event from a fetch result. */
export function selectAuthenticInstanceInfoEvent(
  events: Array<{ kind: number; pubkey: string; tags: string[][]; created_at: number }>,
  mostroPubkeyHex: string,
): { kind: number; pubkey: string; tags: string[][]; created_at: number } | null {
  return events
    .filter((e) => instanceInfoEventIsAuthentic(e, mostroPubkeyHex))
    .sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}