// Browser persistence adapter for TrustGraphStore (localStorage).
// No Node imports — safe to bundle for the browser.
//
// Note: localStorage is synchronous and size-limited (~5MB); the trust-graph
// cache (a few hundred KB) fits, first-seen ledger is tiny.

import type { Attestation } from "./graph.js";
import type { AttestationSnapshot, FirstSeenRecord, TrustGraphStore } from "./store.js";

interface Data {
  attestations: Attestation[];
  savedAt: number;
  firstSeen: Record<string, FirstSeenRecord>;
}

export class LocalStorageTrustGraphStore implements TrustGraphStore {
  constructor(private readonly key = "mostro-trust-graph") {}

  private load(): Data {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      if (raw) return JSON.parse(raw) as Data;
    } catch {
      // unavailable / corrupt
    }
    return { attestations: [], savedAt: 0, firstSeen: {} };
  }

  private save(d: Data): void {
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(d));
    } catch {
      // quota exceeded / unavailable
    }
  }

  async loadAttestations(): Promise<AttestationSnapshot | null> {
    const d = this.load();
    return d.attestations.length > 0 ? { attestations: d.attestations, savedAt: d.savedAt } : null;
  }

  async saveAttestations(attestations: Attestation[]): Promise<void> {
    const d = this.load();
    d.attestations = attestations;
    d.savedAt = Date.now();
    this.save(d);
  }

  async loadFirstSeen(): Promise<Record<string, FirstSeenRecord>> {
    return this.load().firstSeen;
  }

  async saveFirstSeen(state: Record<string, FirstSeenRecord>): Promise<void> {
    const d = this.load();
    d.firstSeen = state;
    this.save(d);
  }
}

export function openLocalStorageTrustGraphStore(key?: string): LocalStorageTrustGraphStore {
  return new LocalStorageTrustGraphStore(key);
}
