// Machine-readable reasons carried by a CantDo response.
// Ported from mostro-core 0.14.3 `src/error.rs` (CantDoReason, serde snake_case).

export const CantDoReason = {
  InvalidSignature: "invalid_signature",
  InvalidTradeIndex: "invalid_trade_index",
  InvalidAmount: "invalid_amount",
  InvalidInvoice: "invalid_invoice",
  InvalidPaymentRequest: "invalid_payment_request",
  InvalidPeer: "invalid_peer",
  InvalidRating: "invalid_rating",
  InvalidTextMessage: "invalid_text_message",
  InvalidOrderKind: "invalid_order_kind",
  InvalidOrderStatus: "invalid_order_status",
  InvalidPubkey: "invalid_pubkey",
  InvalidParameters: "invalid_parameters",
  InvalidPayload: "invalid_payload",
  OrderAlreadyCanceled: "order_already_canceled",
  CantCreateUser: "cant_create_user",
  IsNotYourOrder: "is_not_your_order",
  NotAllowedByStatus: "not_allowed_by_status",
  OutOfRangeFiatAmount: "out_of_range_fiat_amount",
  OutOfRangeSatsAmount: "out_of_range_sats_amount",
  PriceTooStale: "price_too_stale",
  IsNotYourDispute: "is_not_your_dispute",
  DisputeTakenByAdmin: "dispute_taken_by_admin",
  NotAuthorized: "not_authorized",
  DisputeCreationError: "dispute_creation_error",
  NotFound: "not_found",
  InvalidDisputeStatus: "invalid_dispute_status",
  InvalidAction: "invalid_action",
  PendingOrderExists: "pending_order_exists",
  InvalidFiatCurrency: "invalid_fiat_currency",
  TooManyRequests: "too_many_requests",
  InvalidCashuToken: "invalid_cashu_token",
  CashuMintUnavailable: "cashu_mint_unavailable",
  InvalidMintUrl: "invalid_mint_url",
  CashuEscrowNotLocked: "cashu_escrow_not_locked",
  CashuSignatureMissing: "cashu_signature_missing",
} as const;

export type CantDoReason = (typeof CantDoReason)[keyof typeof CantDoReason];

/** Parse a CantDoReason from its snake_case wire value. Returns null on unknown input. */
export function cantDoReasonFromString(s: string): CantDoReason | null {
  const values: readonly string[] = Object.values(CantDoReason);
  if (values.includes(s)) {
    return s as CantDoReason;
  }
  return null;
}