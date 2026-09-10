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
import type { ChatMessage } from "../protocol/chat.js";

export type ClientStatus = "idle" | "connecting" | "ready" | "error";

export interface MyTradeRow {
  id: string;
  status: string | null;
  /** Last applied DM action that touched this trade. */
  lastAction: string | null;
  disputeId: string | null;
}

/** Per-order chat history split by conversation. */
export interface OrderChats {
  order: ChatMessage[];
  dispute: ChatMessage[];
}

export interface MostroUIState {
  status: ClientStatus;
  orders: SmallOrder[];
  /** order_id → trade state. */
  trades: Record<string, MyTradeRow>;
  /** order_id → chat history (peer + solver). */
  chats: Record<string, OrderChats>;
  /** Local identity snapshot. */
  user: { pubkey: string; lastTradeIndex: number } | null;
  instanceInfo: MostroInstanceInfo | null;
  lastError: string | null;
}

export interface MostroStore {
  state: MostroUIState;
  /** Connect a client: bind its callbacks into this store. */
  connect: (client: MostroClient) => void;
  disconnect: () => void;
  /** Merge instance info from the client. */
  setInstanceInfo: (info: MostroInstanceInfo | null) => void;
  setStatus: (status: ClientStatus, error?: string | null) => void;
  /** Replace the order book. */
  setOrders: (orders: SmallOrder[]) => void;
  /** Update one trade's UI row. */
  upsertTrade: (orderId: string, row: Partial<MyTradeRow>) => void;
  /** Append a chat message (order peer or dispute solver). */
  upsertChatMessage: (orderId: string, scope: "order" | "dispute", msg: ChatMessage) => void;
  /** Set the local identity snapshot. */
  setUser: (user: { pubkey: string; lastTradeIndex: number }) => void;
  reset: () => void;
}

/** Create a reactive store for one (or many) Mostro clients. */
export function createMostroStore(): MostroStore {
  const store = createStore<MostroUIState>(() => ({
    status: "idle",
    orders: [],
    trades: {},
    chats: {},
    user: null,
    instanceInfo: null,
    lastError: null,
  }));

  return {
    get state() {
      return store.getState();
    },
    connect(client: MostroClient) {
      store.setState({ status: "connecting" });
      // Bind the client's reactive sink into this store.
      client.bind({
        setOrders: (orders) => store.setState({ orders }),
        upsertTrade: (orderId, row) =>
          store.setState((s) => {
            const existing = s.trades[orderId] ?? {
              id: orderId,
              status: null,
              lastAction: null,
              disputeId: null,
            };
            return { trades: { ...s.trades, [orderId]: { ...existing, ...row } } };
          }),
        setInstanceInfo: (info) => store.setState({ instanceInfo: info }),
        upsertChatMessage: (orderId, scope, msg) =>
          store.setState((s) => {
            const existing = s.chats[orderId] ?? { order: [], dispute: [] };
            return {
              chats: { ...s.chats, [orderId]: { ...existing, [scope]: [...existing[scope], msg] } },
            };
          }),
        setUser: (user) => store.setState({ user, status: "ready" }),
      });
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
    upsertChatMessage(orderId, scope, msg) {
      store.setState((s) => {
        const existing = s.chats[orderId] ?? { order: [], dispute: [] };
        return { chats: { ...s.chats, [orderId]: { ...existing, [scope]: [...existing[scope], msg] } } };
      });
    },
    setUser(user) {
      store.setState({ user });
    },
    reset() {
      store.setState({
        status: "idle",
        orders: [],
        trades: {},
        chats: {},
        user: null,
        instanceInfo: null,
        lastError: null,
      });
    },
  };
}

export type { MostroUIState as MostroUIStateType };