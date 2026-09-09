// Lifecycle status of an Order. Ported from mostro-core 0.14.3 `src/order.rs`
// (Status, serde kebab-case). Wire values use kebab-case, matching DB and NIP-33.

export const Status = {
  Active: "active",
  Canceled: "canceled",
  CanceledByAdmin: "canceled-by-admin",
  SettledByAdmin: "settled-by-admin",
  CompletedByAdmin: "completed-by-admin",
  Dispute: "dispute",
  Expired: "expired",
  FiatSent: "fiat-sent",
  SettledHoldInvoice: "settled-hold-invoice",
  Pending: "pending",
  Success: "success",
  WaitingBuyerInvoice: "waiting-buyer-invoice",
  WaitingPayment: "waiting-payment",
  WaitingTakerBond: "waiting-taker-bond",
  CooperativelyCanceled: "cooperatively-canceled",
  InProgress: "in-progress",
  WaitingMakerBond: "waiting-maker-bond",
} as const;

export type Status = (typeof Status)[keyof typeof Status];

/** Parse a Status from its kebab-case string. Returns null on unknown input. */
export function statusFromString(s: string): Status | null {
  switch (s.toLowerCase()) {
    case Status.Active:
      return Status.Active;
    case Status.Canceled:
      return Status.Canceled;
    case Status.CanceledByAdmin:
      return Status.CanceledByAdmin;
    case Status.SettledByAdmin:
      return Status.SettledByAdmin;
    case Status.CompletedByAdmin:
      return Status.CompletedByAdmin;
    case Status.Dispute:
      return Status.Dispute;
    case Status.Expired:
      return Status.Expired;
    case Status.FiatSent:
      return Status.FiatSent;
    case Status.SettledHoldInvoice:
      return Status.SettledHoldInvoice;
    case Status.Pending:
      return Status.Pending;
    case Status.Success:
      return Status.Success;
    case Status.WaitingBuyerInvoice:
      return Status.WaitingBuyerInvoice;
    case Status.WaitingPayment:
      return Status.WaitingPayment;
    case Status.WaitingTakerBond:
      return Status.WaitingTakerBond;
    case Status.CooperativelyCanceled:
      return Status.CooperativelyCanceled;
    case Status.InProgress:
      return Status.InProgress;
    case Status.WaitingMakerBond:
      return Status.WaitingMakerBond;
    default:
      return null;
  }
}

export function statusToString(status: Status): string {
  return status;
}