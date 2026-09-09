// Reactive UI store for Mostro — framework-agnostic (vanilla zustand).
//
// MostroClient stays pure (network + persistence). This store holds the
// UI-facing reactive state (order book, my trades, connection status) and is
// kept in sync by the client's callbacks. React binds via useMostroStore;
// Vue/Svelte subscribe to the same store with their own bindings.

import { createStore } from "zustand/vanilla";
import type { SmallOrder } from "../protocol/order.js";
import type { MostroInstanceInfo } from "../protocol/mostroInfo.js";
import type { MostroClient } from "../protocol/client.js";
import type { AppliedTradeState } from "../protocol/client.js";

export type ClientStatus = "idle" | "connecting" | "ready" | "error";

export interface MyTradeRow {
  id: string;
  status: string | null;
  /** Last applied DM action that touched this trade. */
  lastAction: string | null;
  disputeId: string | null;
}

export interface MostroUIState {
  status: ClientStatus;
  orders: SmallOrder[];
  /** order_id → trade state. */
  trades: Record<string, MyTradeRow>;
  instanceInfo: MostroInstanceInfo | null;
  lastError: string | null;
}

export interface MostroStore {
  state: MostroUIState;
  /** Connect a client: subscribe its callbacks into this store. */
  connect: (client: MostroClient) => void;
  disconnect: () => void;
  /** Merge instance info from the client. */
  setInstanceInfo: (info: MostroInstanceInfo | null) => void;
  setStatus: (status: ClientStatus, error?: string | null) => void;
  /** Replace the order book. */
  setOrders: (orders: SmallOrder[]) => void;
  /** Update one trade's UI row. */
  upsertTrade: (orderId: string, row: Partial<MyTradeRow>) => void;
  reset: () => void;
}

/** Create a reactive store for one (or many) Mostro clients. */
export function createMostroStore(): MostroStore {
  const store = createStore<MostroUIState>(() => ({
    status: "idle",
    orders: [],
    trades: {},
    instanceInfo: null,
    lastError: null,
  }));

  return {
    get state() {
      return store.getState();
    },
    connect(client: MostroClient) {
      // Order book → store.
      client.onOrders((orders) => {
        store.setState({ orders });
      });
      // Trade state → store.
      // (onTrade registration happens per-order in the client; a blanket
      // subscription is added when the client exposes one. For now the client
      // drives persistOrder + we subscribe via a helper the client calls.)
      store.setState({ status: "connecting" });
    },
    disconnect() {
      store.setState({ status: "idle" });
    },
    setInstanceInfo(info) {
      store.setState({ instanceInfo: info });
    },
    setStatus(status, error = null) {
      store.setState({ status, lastError: error });
    },
    setOrders(orders) {
      store.setState({ orders });
    },
    upsertTrade(orderId, row) {
      store.setState((s) => {
        const existing = s.trades[orderId] ?? {
          id: orderId,
          status: null,
          lastAction: null,
          disputeId: null,
        };
        return { trades: { ...s.trades, [orderId]: { ...existing, ...row } } };
      });
    },
    reset() {
      store.setState({ status: "idle", orders: [], trades: {}, instanceInfo: null, lastError: null });
    },
  };
}

export type { MostroUIState as MostroUIStateType };