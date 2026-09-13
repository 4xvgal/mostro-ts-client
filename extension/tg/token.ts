// Order-binding pm token (mostro-trust-graph-spec v0.1.1 §4).
// Schnorr-signed token embedded in the order's `pm` field. Verifier needs only
// the identity pubkey. Frozen challenge byte format (see spec §15):
//   - UTF-8, "\n" separators, no trailing newline
//   - k = "buy" | "sell" (mostro `k` tag, NOT numeric)
//   - f = fiat_code as-is from the `f` tag
//   - amounts/premium = i64 decimal, no sign for non-negatives
//   - nonce = base64url unpadded (22 chars)
//   - sig = lowercase hex 128 chars (BIP-340)
//
// Binding limits (spec §16): order_id is server-generated and unknown at sign
// time, pm is immutable, so this proves "identity I signed this pm string" —
// not "I own order X". First-seen (identity, nonce) uniqueness is the 2nd
// defence and lives in the verification pipeline, not here.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad, hex } from "@scure/base";

export const TG_V1_PREFIX = "tg:v1~";
export const TG_V1R_PREFIX = "tg:v1r~";

const V1_TAG = "mostro-ppr-v1";
const V1R_TAG = "mostro-ppr-v1-range";
const TOKEN_RE = /^tg:(v1|v1r)~([A-Za-z0-9_-]+)\.([0-9a-f]{128})$/;

export interface TgOrderFields {
  /** mostro daemon pubkey (kind 38383 event author), lowercase hex. */
  mostroPubkey: string;
  /** `k` tag value: "buy" | "sell". */
  kind: string;
  /** `f` tag value, verbatim. */
  fiatCode: string;
  /** i64 decimal, negative allowed, "%d". */
  premium: number;
  /** canonical_base(pm): token-free, comma-joined, no trim. */
  basePaymentMethod: string;
}

export type TgChallengeInput =
  | (TgOrderFields & { variant?: "v1"; fiatAmount: number })
  | (TgOrderFields & { variant: "v1r"; minAmount: number; maxAmount: number });

export type TgVariant = "v1" | "v1r";

export interface ParsedTgToken {
  variant: TgVariant;
  nonce: Uint8Array;
  sig: Uint8Array;
}

export function isTgToken(s: string): boolean {
  return s.startsWith(TG_V1_PREFIX) || s.startsWith(TG_V1R_PREFIX);
}

/** mostrod-compatible split: comma-separated, drop empty pieces, no trim. */
export function splitPm(pm: string): string[] {
  return pm.split(",").filter((s) => s !== "");
}

/** Canonical base: token-free segments rejoined with commas. */
export function canonicalBase(pm: string): string {
  return splitPm(pm)
    .filter((s) => !isTgToken(s))
    .join(",");
}

export function parseTgToken(token: string): ParsedTgToken | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  try {
    return {
      variant: m[1] as TgVariant,
      nonce: base64urlnopad.decode(m[2]!),
      sig: hex.decode(m[3]!),
    };
  } catch {
    return null;
  }
}

function variantOf(input: TgChallengeInput): TgVariant {
  return input.variant === "v1r" ? "v1r" : "v1";
}

/** Assemble the exact challenge bytes (pre-hash) for a token. */
export function buildChallenge(input: TgChallengeInput, nonce: Uint8Array): Uint8Array {
  const enc = base64urlnopad.encode(nonce);
  const common = [input.mostroPubkey, input.kind, input.fiatCode];
  if (variantOf(input) === "v1r") {
    const r = input as Extract<TgChallengeInput, { minAmount: number }>;
    return new TextEncoder().encode(
      [V1R_TAG, ...common, String(r.minAmount), String(r.maxAmount), String(input.premium), input.basePaymentMethod, enc].join("\n"),
    );
  }
  const f = input as Extract<TgChallengeInput, { fiatAmount: number }>;
  return new TextEncoder().encode(
    [V1_TAG, ...common, String(f.fiatAmount), String(input.premium), input.basePaymentMethod, enc].join("\n"),
  );
}

/** Sign + format a pm token. `nonce` defaults to 16 fresh random bytes. */
export function buildPmToken(
  input: TgChallengeInput,
  identitySecretHex: string,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  const digest = sha256(buildChallenge(input, nonce));
  const sig = schnorr.sign(digest, hex.decode(identitySecretHex));
  const prefix = variantOf(input) === "v1r" ? TG_V1R_PREFIX : TG_V1_PREFIX;
  return `${prefix}${base64urlnopad.encode(nonce)}.${hex.encode(sig)}`;
}

/**
 * Verify a pm token against reconstructed order fields.
 * Fields must come from the actual kind 38383 tags, not client-supplied hints.
 */
export function verifyPmToken(
  input: TgChallengeInput,
  token: string,
  identityPubkeyHex: string,
): boolean {
  const parsed = parseTgToken(token);
  if (!parsed || parsed.variant !== variantOf(input)) return false;
  try {
    return schnorr.verify(parsed.sig, sha256(buildChallenge(input, parsed.nonce)), hex.decode(identityPubkeyHex));
  } catch {
    return false;
  }
}

/** Split a kind 38383 `pm` tag value list. Exactly one token is required. */
export function extractTokenFromSegments(
  segments: string[],
): { token: string; base: string } | null {
  const tokens = segments.filter(isTgToken);
  if (tokens.length !== 1) return null;
  return { token: tokens[0]!, base: segments.filter((s) => !isTgToken(s)).join(",") };
}

/** Append a token to a canonical base, or return the token alone if base is empty. */
export function insertToken(base: string, token: string): string {
  return base === "" ? token : `${base},${token}`;
}
