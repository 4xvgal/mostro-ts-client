# mostro-ts-client

## 0.2.0-rc.1

### Minor Changes

- c2c130b: `createOrder`/`takeOrder` now return `next: NextStep`, a discriminated union
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

## 0.2.0-rc.0

### Minor Changes

- 03d989d: Take a raw BIP-39 seed instead of a mnemonic across `MostroClient`, `Store`, and `restoreSession`; the library no longer receives or persists the mnemonic. Adds `mnemonicToSeed()` and `deriveKeysFromSeed()`.
  
  Authenticate inbound Mostro DMs by the outer kind-14 event signature only; Mostro omits the inner `trade_sig`, which previously caused every inbound reply to be discarded.
