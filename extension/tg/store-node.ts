// Node/Bun persistence adapter for TrustGraphStore (single JSON file).
// Import this module only in Node/Bun — it pulls in `node:fs`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Attestation } from "./graph.js";
import type { AttestationSnapshot, FirstSeenRecord, TrustGraphStore } from "./store.js";

interface Data {
  attestations: Attestation[];
  savedAt: number;
  firstSeen: Record<string, FirstSeenRecord>;
}

export class FileTrustGraphStore implements TrustGraphStore {
  private data: Data | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Data> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await readFile(this.path, "utf8")) as Data;
    } catch {
      this.data = { attestations: [], savedAt: 0, firstSeen: {} };
    }
    return this.data;
  }

  private async flush(): Promise<void> {
    if (!this.data) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data));
  }

  async loadAttestations(): Promise<AttestationSnapshot | null> {
    const d = await this.load();
    return d.attestations.length > 0 ? { attestations: d.attestations, savedAt: d.savedAt } : null;
  }

  async saveAttestations(attestations: Attestation[]): Promise<void> {
    const d = await this.load();
    d.attestations = attestations;
    d.savedAt = Date.now();
    await this.flush();
  }

  async loadFirstSeen(): Promise<Record<string, FirstSeenRecord>> {
    return (await this.load()).firstSeen;
  }

  async saveFirstSeen(state: Record<string, FirstSeenRecord>): Promise<void> {
    (await this.load()).firstSeen = state;
    await this.flush();
  }
}

export function openFileTrustGraphStore(path: string): FileTrustGraphStore {
  return new FileTrustGraphStore(path);
}
