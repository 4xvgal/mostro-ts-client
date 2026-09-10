---
"mostro-ts-client": minor
---

`createOrder`/`takeOrder` now return `next: NextStep`, a discriminated union
(`{ type: "none" | "pay-bond" | "pay-hold-invoice" | "add-invoice" }`) instead
of loose optional fields, so consumers must handle every outcome.

On bond-enabled instances `createOrder` now surfaces the maker bond
(`next.type === "pay-bond"`, with the bolt11 `invoice` and `amount`) instead of
timing out — the create-order roundtrip also accepts the `pay-bond-invoice`
reply. Adds `waitForOrderLive(orderId, timeoutMs?)` to await the order going
live after the bond is paid.

BREAKING CHANGE: `TakeOrderResult.next` is now an object; both
`CreateOrderResult` and `TakeOrderResult` expose `orderId`, `status`, and
`next`.
