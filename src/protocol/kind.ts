// Direction of an order: the maker wants to buy or sell sats.
// Ported from mostro-core 0.14.3 `src/order.rs` (Kind, serde kebab-case).

export const Kind = {
  Buy: "buy",
  Sell: "sell",
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

/** Parse a Kind from "buy" or "sell" (case-insensitive). Returns null on unknown input. */
export function kindFromString(s: string): Kind | null {
  switch (s.toLowerCase()) {
    case Kind.Buy:
      return Kind.Buy;
    case Kind.Sell:
      return Kind.Sell;
    default:
      return null;
  }
}

export function kindToString(kind: Kind): string {
  return kind;
}