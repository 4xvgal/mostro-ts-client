// Domain-tagged identity proof payload for protocol-v2 NIP-44 transport.
// Ported from mostro-core 0.14.3 `src/transport.rs` `identity_proof_payload`.

/**
 * Payload the identity key signs for the v2 identity proof.
 *
 * `mostro-transport-v2-identity:<trade_pubkey>:<message_json>` binds the
 * proof to BOTH the message and the trade key that authored the event —
 * prevents grafting a proof onto an event authored by a different trade key.
 */
export function identityProofPayload(tradePubkeyHex: string, messageJson: string): string {
  return `mostro-transport-v2-identity:${tradePubkeyHex}:${messageJson}`;
}