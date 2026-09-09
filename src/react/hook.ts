// React bindings for the Mostro UI store.
//
// `useMostroStore` mirrors zustand's selector hook but is bound to the
// vanilla store created by createMostroStore, so the same store can also be
// consumed by Vue/Svelte without a second source of truth.

import { useSyncExternalStore } from "react";
import type { MostroUIState } from "./store.js";
import { createStore } from "zustand/vanilla";

/** A vanilla zustand store snapshot accessor (duck-typed to avoid pulling react zustand). */
export interface StoreSnapshot {
  getState: () => MostroUIState;
  subscribe: (listener: (state: MostroUIState, prev: MostroUIState) => void) => () => void;
}

/**
 * React hook reading a slice of the Mostro UI store.
 *
 * const orders = useMostroStore(store, (s) => s.orders)
 */
export function useMostroStore<T>(
  store: StoreSnapshot,
  selector: (state: MostroUIState) => T,
): T {
  return useSyncExternalStore(
    (cb) => {
      const unsub = store.subscribe(() => cb());
      return unsub;
    },
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/** Convenience: build a selector hook bound to one store instance. */
export function bindMostroStore(store: StoreSnapshot) {
  return {
    useMostroStore: <T,>(selector: (s: MostroUIState) => T) =>
      useMostroStore(store, selector),
    store,
  };
}

export type { MostroUIState };
export { createStore };