// Viewer runner: composes TrustGraph + IdentityIndex + annotateOrders into one
// object, with live 30501 ingestion. This is application glue (all library
// primitives already exist) — it just gives a runnable entry point.

import type { SmallOrder } from "../../src/protocol/index.js";
import { TrustGraph, type TrustGraphOptions, type TrustGraphSnapshot } from "./api.js";
import { IdentityIndex, annotateOrders, type AnnotatedOrder, type TrustThresholds } from "./join.js";
import { SOCIAL_INDEX_D, SOCIAL_INDEX_KIND, fetchSocialIndex } from "./social.js";
import type { EventSubscription } from "./graph.js";

export interface ViewerOptions extends TrustGraphOptions {
  /** The Mostro daemon pubkey that authors the order book. */
  mostroPubkey: string;
  thresholds?: TrustThresholds;
}

export class TrustGraphViewer {
  readonly graph: TrustGraph;
  readonly identityIndex = new IdentityIndex();
  private readonly opts: ViewerOptions;
  private subs: EventSubscription[] = [];

  constructor(opts: ViewerOptions) {
    this.opts = opts;
    this.graph = new TrustGraph(opts);
  }

  /** Load kind-30501 social indices, then collect + score the trust graph. */
  async refresh(): Promise<TrustGraphSnapshot> {
    await this.loadSocialIndices();
    return this.graph.refresh();
  }

  private async loadSocialIndices(): Promise<void> {
    const events = await fetchSocialIndex({ pool: this.opts.pool, relays: this.opts.relays });
    for (const ev of events) this.identityIndex.addSocialIndex(ev);
  }

  /** Verify bindings + score the given orders. */
  annotate(orders: SmallOrder[]): AnnotatedOrder[] {
    return annotateOrders(orders, {
      graph: this.graph,
      mostroPubkey: this.opts.mostroPubkey,
      identityIndex: this.identityIndex,
      thresholds: this.opts.thresholds,
      telemetry: this.opts.telemetry,
    });
  }

  score(identity: string): number | undefined {
    return this.graph.score(identity);
  }

  /** Polling refresh + live 38383/30500 (graph) + live 30501 (identity index). */
  start(): void {
    this.graph.start();
    const pool = this.opts.pool;
    if (pool.subscribeMany && this.subs.length === 0) {
      try {
        this.subs.push(
          pool.subscribeMany(this.opts.relays, { kinds: [SOCIAL_INDEX_KIND], "#d": [SOCIAL_INDEX_D] }, {
            onevent: (e) => this.identityIndex.addSocialIndex(e),
          }),
        );
      } catch {
        // subscription unavailable — refresh() still loads indices
      }
    }
  }

  stop(): void {
    this.graph.stop();
    for (const s of this.subs) s.close();
    this.subs = [];
  }
}
