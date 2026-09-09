// Discriminator describing the verb of a Mostro message.
// Ported from mostro-core 0.14.3 `src/message.rs` (Action, serde kebab-case).

export const Action = {
  NewOrder: "new-order",
  TakeSell: "take-sell",
  TakeBuy: "take-buy",
  PayInvoice: "pay-invoice",
  PayBondInvoice: "pay-bond-invoice",
  FiatSent: "fiat-sent",
  FiatSentOk: "fiat-sent-ok",
  Release: "release",
  Released: "released",
  Cancel: "cancel",
  Canceled: "canceled",
  CooperativeCancelInitiatedByYou: "cooperative-cancel-initiated-by-you",
  CooperativeCancelInitiatedByPeer: "cooperative-cancel-initiated-by-peer",
  DisputeInitiatedByYou: "dispute-initiated-by-you",
  DisputeInitiatedByPeer: "dispute-initiated-by-peer",
  CooperativeCancelAccepted: "cooperative-cancel-accepted",
  BuyerInvoiceAccepted: "buyer-invoice-accepted",
  BondInvoiceAccepted: "bond-invoice-accepted",
  PurchaseCompleted: "purchase-completed",
  BondPayoutCompleted: "bond-payout-completed",
  BondSlashed: "bond-slashed",
  HoldInvoicePaymentAccepted: "hold-invoice-payment-accepted",
  HoldInvoicePaymentSettled: "hold-invoice-payment-settled",
  HoldInvoicePaymentCanceled: "hold-invoice-payment-canceled",
  WaitingSellerToPay: "waiting-seller-to-pay",
  WaitingBuyerInvoice: "waiting-buyer-invoice",
  AddInvoice: "add-invoice",
  AddBondInvoice: "add-bond-invoice",
  BuyerTookOrder: "buyer-took-order",
  Rate: "rate",
  RateUser: "rate-user",
  RateReceived: "rate-received",
  CantDo: "cant-do",
  Dispute: "dispute",
  AdminCancel: "admin-cancel",
  AdminCanceled: "admin-canceled",
  AdminSettle: "admin-settle",
  AdminSettled: "admin-settled",
  AdminAddSolver: "admin-add-solver",
  AdminTakeDispute: "admin-take-dispute",
  AdminTookDispute: "admin-took-dispute",
  PaymentFailed: "payment-failed",
  InvoiceUpdated: "invoice-updated",
  SendDm: "send-dm",
  TradePubkey: "trade-pubkey",
  RestoreSession: "restore-session",
  LastTradeIndex: "last-trade-index",
  Orders: "orders",
  AddCashuEscrow: "add-cashu-escrow",
  CashuEscrowLocked: "cashu-escrow-locked",
  CashuPmSignature: "cashu-pm-signature",
} as const;

export type Action = (typeof Action)[keyof typeof Action];

/** Parse an Action from its kebab-case wire value. Returns null on unknown input. */
export function actionFromString(s: string): Action | null {
  const values: readonly string[] = Object.values(Action);
  if (values.includes(s)) {
    return s as Action;
  }
  return null;
}

export function actionToString(action: Action): string {
  return action;
}