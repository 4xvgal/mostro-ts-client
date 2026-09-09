// NIP-19 npub encoding (from hex pubkey). Mirrors mostrix
// `hex_pubkey_to_npub` in `src/ui/key_handler/validation.rs`.

import { bech32 } from "@scure/base";
import { hex } from "@scure/base";

/** Convert a 64-char hex pubkey to `npub1...` (bech32). Null on invalid input. */
export function hexToNpub(pubkeyHex: string): string | null {
  const trimmed = pubkeyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return null;
  }
  const bytes = hex.decode(trimmed.toLowerCase());
  return bech32.encode("npub", bech32.toWords(bytes));
}

/** Convert `npub1...` back to hex pubkey. Null on invalid input. */
export function npubToHex(npub: string): string | null {
  const trimmed = npub.trim();
  if (!trimmed.startsWith("npub1")) {
    return null;
  }
  try {
    const { words } = bech32.decode(trimmed);
    const bytes = new Uint8Array(bech32.fromWords(words));
    return hex.encode(bytes);
  } catch {
    return null;
  }
}