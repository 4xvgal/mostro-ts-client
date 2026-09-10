# mostro-ts-client

## 0.2.0-rc.0

### Minor Changes

- 03d989d: Take a raw BIP-39 seed instead of a mnemonic across `MostroClient`, `Store`, and `restoreSession`; the library no longer receives or persists the mnemonic. Adds `mnemonicToSeed()` and `deriveKeysFromSeed()`.
  
  Authenticate inbound Mostro DMs by the outer kind-14 event signature only; Mostro omits the inner `trade_sig`, which previously caused every inbound reply to be discarded.
