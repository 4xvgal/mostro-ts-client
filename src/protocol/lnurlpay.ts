// LNURL-pay resolution for Lightning addresses / lnurl1 strings.
//
// Mirrors mostrix `src/util/ln_address.rs` (LNURL-pay metadata lookup) and the
// LNURL-pay spec: `user@domain` → `https://domain/.well-known/lnurlp/user` →
// `callback?amount=<msat>` → `pr` (bolt11). No dependencies — uses fetch.

import { bech32, utf8 } from "@scure/base";
import { assertSafeFetchUrl, fetchWithTimeout } from "./net.js";
import type { UrlPolicy } from "./net.js";
import { bolt11AmountMsat } from "./invoice.js";

/** Resolve a `user@domain` address or `lnurl1…` string to its LNURL-pay metadata URL. */
export function lnurlpMetadataUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith("lnurl1")) {
    // lnurl1… is a bech32-encoded URL.
    const { words } = bech32.decode(trimmed as `${string}1${string}`, 1023);
    return utf8.encode(new Uint8Array(bech32.fromWords(words)));
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    const user = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    return `https://${domain}/.well-known/lnurlp/${user}`;
  }
  throw new Error(`not a Lightning address or lnurl: ${input}`);
}

/** LNURL-pay metadata returned by the well-known endpoint. */
export interface LnurlpMetadata {
  callback: string;
  minSendable: number | null;
  maxSendable: number | null;
  metadata: string | null;
}

/** Fetch + validate LNURL-pay metadata (metadata `tag` must be `payRequest`). */
export async function fetchLnurlpMetadata(input: string, policy: UrlPolicy = {}): Promise<LnurlpMetadata> {
  const url = assertSafeFetchUrl(lnurlpMetadataUrl(input), policy);
  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) {
    throw new Error(`LNURL-pay metadata fetch returned ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (json.tag !== "payRequest" || typeof json.callback !== "string") {
    throw new Error("endpoint is not a valid LNURL-pay service");
  }
  return {
    callback: json.callback,
    minSendable: typeof json.minSendable === "number" ? json.minSendable : null,
    maxSendable: typeof json.maxSendable === "number" ? json.maxSendable : null,
    metadata: typeof json.metadata === "string" ? json.metadata : null,
  };
}

/** Reachability check for a Lightning address (mirrors mostrix ln_address_pay_request_reachable). */
export async function lightningAddressReachable(input: string, policy: UrlPolicy = {}): Promise<boolean> {
  try {
    await fetchLnurlpMetadata(input, policy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Lightning address to a bolt11 invoice for `amountMsat` (or the
 * callback URL when no amount is given / the server takes none).
 */
export async function resolveLightningAddress(
  input: string,
  amountMsat?: number,
  policy: UrlPolicy = {},
): Promise<string> {
  const metaUrl = assertSafeFetchUrl(lnurlpMetadataUrl(input), policy);
  const meta = await fetchLnurlpMetadata(input, policy);
  if (amountMsat != null) {
    if (meta.minSendable != null && amountMsat < meta.minSendable) {
      throw new Error(`amount below minSendable (${meta.minSendable})`);
    }
    if (meta.maxSendable != null && amountMsat > meta.maxSendable) {
      throw new Error(`amount above maxSendable (${meta.maxSendable})`);
    }
  }
  const callback = assertSafeFetchUrl(meta.callback, policy);
  // LUD-16: the callback must live on the same host as the metadata endpoint,
  // otherwise a malicious resolver can redirect the payment invoice fetch.
  if (callback.hostname !== metaUrl.hostname) {
    throw new Error(
      `LNURL-pay callback host ${callback.hostname} does not match ${metaUrl.hostname}`,
    );
  }
  if (amountMsat != null) {
    callback.searchParams.set("amount", String(amountMsat));
  }
  const res = await fetchWithTimeout(callback.toString());
  if (!res.ok) {
    throw new Error(`LNURL-pay callback returned ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.pr !== "string" || json.pr.length === 0) {
    throw new Error("LNURL-pay callback returned no invoice");
  }
  // The returned invoice must encode the requested amount, or a malicious
  // server could hand back an invoice for a different (larger) sum.
  if (amountMsat != null) {
    const actual = bolt11AmountMsat(json.pr);
    if (actual === null) {
      throw new Error("LNURL-pay callback returned an amountless invoice");
    }
    if (actual !== amountMsat) {
      throw new Error(`invoice amount ${actual} msat does not match requested ${amountMsat} msat`);
    }
  }
  return json.pr;
}
