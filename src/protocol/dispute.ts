// Dispute types. Ported from mostro-core 0.14.3 `src/dispute.rs`.

import type { UserInfo } from "./user.js";

export type { UserInfo };

// Lifecycle status of a Dispute (serde kebab-case).
export const DisputeStatus = {
  Initiated: "initiated",
  InProgress: "in-progress",
  SellerRefunded: "seller-refunded",
  Settled: "settled",
  Released: "released",
} as const;

export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

/** Parse a DisputeStatus from its kebab-case string. Returns null on unknown input. */
export function disputeStatusFromString(s: string): DisputeStatus | null {
  switch (s) {
    case DisputeStatus.Initiated:
      return DisputeStatus.Initiated;
    case DisputeStatus.InProgress:
      return DisputeStatus.InProgress;
    case DisputeStatus.SellerRefunded:
      return DisputeStatus.SellerRefunded;
    case DisputeStatus.Settled:
      return DisputeStatus.Settled;
    case DisputeStatus.Released:
      return DisputeStatus.Released;
    default:
      return null;
  }
}

/** Extended dispute view for solvers. Bundles the Dispute with key parent Order fields. */
export interface SolverDisputeInfo {
  id: string;
  kind: string;
  status: string;
  hash: string | null;
  preimage: string | null;
  order_previous_status: string;
  initiator_pubkey: string;
  buyer_pubkey: string | null;
  seller_pubkey: string | null;
  initiator_full_privacy: boolean;
  counterpart_full_privacy: boolean;
  initiator_info: UserInfo | null;
  counterpart_info: UserInfo | null;
  premium: number;
  payment_method: string;
  amount: number;
  fiat_amount: number;
  fee: number;
  routing_fee: number;
  buyer_invoice: string | null;
  invoice_held_at: number;
  taken_at: number;
  created_at: number;
}

/** Database representation of a dispute. */
export interface Dispute {
  id: string;
  order_id: string;
  status: string;
  order_previous_status: string;
  solver_pubkey: string | null;
  created_at: number;
  taken_at: number;
}