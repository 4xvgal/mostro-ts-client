// Persistence port for the trust graph (Repository pattern).
// Keeps the collected attestations and the first-seen ledger across sessions.
// Runtime-specific adapters implement this interface; the default is in-memory.

import type { Attestation } from "./graph.js";

export interface FirstSeenRecord {
  orderId: string;
  ts: number;
}

/** Attestation cache blob + when it was saved (for cache TTL). */
export interface AttestationSnapshot {
  attestations: Attestation[];
  savedAt: number;
}

export interface TrustGraphStore {
  loadAttestations(): Promise<AttestationSnapshot | null>;
  saveAttestations(attestations: Attestation[]): Promise<void>;
  loadFirstSeen(): Promise<Record<string, FirstSeenRecord>>;
  saveFirstSeen(state: Record<string, FirstSeenRecord>): Promise<void>;
}

/** Default store: process-lifetime only (no persistence across restarts). */
export class MemoryTrustGraphStore implements TrustGraphStore {
  private snapshot: AttestationSnapshot | null = null;
  private firstSeen: Record<string, FirstSeenRecord> = {};

  async loadAttestations(): Promise<AttestationSnapshot | null> {
    return this.snapshot;
  }
  async saveAttestations(attestations: Attestation[]): Promise<void> {
    this.snapshot = { attestations, savedAt: Date.now() };
  }
  async loadFirstSeen(): Promise<Record<string, FirstSeenRecord>> {
    return this.firstSeen;
  }
  async saveFirstSeen(state: Record<string, FirstSeenRecord>): Promise<void> {
    this.firstSeen = state;
  }
}
