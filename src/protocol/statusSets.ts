// Terminal order status sets. Ported from mostrix `src/models.rs`
// (TERMINAL_DM_STATUSES / TERMINAL_ORDER_HISTORY_STATUSES / bulk-delete).

/**
 * Kebab-case order statuses excluded from startup DM hydration.
 * `success` is intentionally omitted so post-success trade DMs still hydrate.
 */
export const TERMINAL_DM_STATUSES: readonly string[] = [
  "canceled",
  "canceled-by-admin",
  "settled-by-admin",
  "completed-by-admin",
  "expired",
  "cooperatively-canceled",
];

/**
 * Kebab-case terminal statuses for order-history retention/cleanup.
 * Includes `success`, unlike TERMINAL_DM_STATUSES.
 */
export const TERMINAL_ORDER_HISTORY_STATUSES: readonly string[] = [
  "success",
  "canceled",
  "canceled-by-admin",
  "settled-by-admin",
  "completed-by-admin",
  "expired",
  "cooperatively-canceled",
];

/** Kebab-case statuses eligible for bulk user cleanup in My Trades. */
export const ORDER_HISTORY_BULK_DELETE_STATUSES: readonly string[] = ["success", "canceled"];