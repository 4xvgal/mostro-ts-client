// Key management — deterministic derivation (NIP-06).
// Ported from mostrix `src/models.rs` (User::derive_trade_keys /
// get_identity_keys). Path: m/44'/1237'/38383'/0/{trade_index}.
//
// account = NOSTR_ORDER_EVENT_KIND (38383). Identity key is index 0;
// every trade gets a fresh trade key at a strictly-increasing index.

import * as bip39 from "bip39";
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex, bech32 } from "@scure/base";

import { NOSTR_ORDER_EVENT_KIND } from "./constants.js";

/** BIP-44 coin type for Nostr (NIP-06). */
const NOSTR_COIN_TYPE = 1237;
/** Max trade index (u32) accepted by the Rust derivation guard. */
const MAX_TRADE_INDEX = 0xffff_ffff;

export interface DerivedKeys {
  /** x-only public key, hex. */
  pubkey: string;
  /** secret key, hex. */
  secret: string;
  /** Derivation path, e.g. m/44'/1237'/38383'/0/1. */
  path: string;
}

function derivationPath(tradeIndex: number): string {
  return `m/44'/${NOSTR_COIN_TYPE}'/${NOSTR_ORDER_EVENT_KIND}'/0/${tradeIndex}`;
}

/**
 * Convert a BIP-39 mnemonic to its 64-byte seed.
 *
 * The library only ever needs the seed for derivation; callers that already
 * hold a seed should pass it to `deriveKeysFromSeed` to avoid re-running the
 * PBKDF2 step.
 */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return bip39.mnemonicToSeedSync(mnemonic);
}

/**
 * Derive keys at `m/44'/1237'/38383'/0/{tradeIndex}` from a BIP-39 seed.
 *
 * The last index is NON-hardened (matches the mostro-webtool and mostrix
 * derivation); the pubkey is x-only (32-byte, nostr PublicKey form).
 */
export function deriveKeysFromSeed(seed: Uint8Array, tradeIndex: number): DerivedKeys {
  if (tradeIndex < 0 || tradeIndex > MAX_TRADE_INDEX) {
    throw new Error(`Invalid trade_index ${tradeIndex} for key derivation; expected 0..=${MAX_TRADE_INDEX}`);
  }
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(derivationPath(tradeIndex));
  if (!child.privateKey) {
    throw new Error("derivation produced no private key");
  }
  const secret = hex.encode(child.privateKey);
  const pubkey = hex.encode(secp256k1.getPublicKey(child.privateKey, true).slice(1));
  return { pubkey, secret, path: derivationPath(tradeIndex) };
}

/**
 * Derive keys at `m/44'/1237'/38383'/0/{tradeIndex}` from a BIP-39 mnemonic.
 *
 * Mirrors `Keys::from_mnemonic_advanced(&mnemonic, None, Some(38383), Some(0),
 * Some(index))` in mostrix.
 */
export function deriveKeysFromMnemonic(mnemonic: string, tradeIndex: number): DerivedKeys {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("invalid mnemonic");
  }
  return deriveKeysFromSeed(mnemonicToSeed(mnemonic), tradeIndex);
}

/** Derive the identity key (trade index 0). */
export function deriveIdentityKeys(mnemonic: string): DerivedKeys {
  return deriveKeysFromMnemonic(mnemonic, 0);
}

/**
 * Derive a fresh trade key at the given index. Callers must reserve the
 * index atomically before using it (see reserveNextTradeIndex).
 */
export function deriveTradeKeys(mnemonic: string, tradeIndex: number): DerivedKeys {
  return deriveKeysFromMnemonic(mnemonic, tradeIndex);
}

/**
 * Atomically increment a last-trade-index counter and derive the next keys.
 *
 * Mirrors `User::reserve_next_trade_index`: reads `lastTradeIndex` (treating
 * null as `noneBase`), derives at index+1, and returns the new counter plus
 * keys. `noneBase` is 1 for order flows, 0 for range-order NextTrade.
 */
export function reserveNextTradeIndex(
  state: { lastTradeIndex: number | null },
  mnemonic: string,
  noneBase: number,
): { nextIndex: number; keys: DerivedKeys; nextState: { lastTradeIndex: number | null } } {
  const nextIndex = (state.lastTradeIndex ?? noneBase) + 1;
  const keys = deriveTradeKeys(mnemonic, nextIndex);
  return {
    nextIndex,
    keys,
    nextState: { lastTradeIndex: nextIndex },
  };
}

/** Generate a fresh 12-word mnemonic. */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(128);
}

/** Validate a mnemonic string. */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

/** Encode a secret key hex string as `nsec1...` (Bech32). */
export function nsecFromSecret(secretHex: string): string {
  const bytes = hex.decode(secretHex);
  return bech32.encode("nsec", bech32.toWords(bytes));
}

/**
 * Derive the identity nsec for a mnemonic (index 0), exactly as mostrix's
 * `derive_identity_nsec_from_mnemonic`. This is the value that belongs in
 * `settings.toml`'s `nsec_privkey`.
 */
export function identityNsecFromMnemonic(mnemonic: string): string {
  const identity = deriveIdentityKeys(mnemonic);
  return nsecFromSecret(identity.secret);
}