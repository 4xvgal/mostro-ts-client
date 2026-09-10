import { test } from "node:test";
import assert from "node:assert/strict";
import { bech32, utf8 } from "@scure/base";

import { lnurlpMetadataUrl } from "../src/protocol/index.js";

test("lnurlpMetadataUrl maps a Lightning address to the well-known URL", () => {
  assert.equal(lnurlpMetadataUrl("alice@example.com"), "https://example.com/.well-known/lnurlp/alice");
  assert.equal(lnurlpMetadataUrl("  bob@sub.example.org  "), "https://sub.example.org/.well-known/lnurlp/bob");
});

test("lnurlpMetadataUrl passes through raw http(s) URLs", () => {
  assert.equal(lnurlpMetadataUrl("http://localhost:3998/lnurlp/alice"), "http://localhost:3998/lnurlp/alice");
});

test("lnurlpMetadataUrl decodes lnurl1 bech32", () => {
  const enc = bech32.encode("lnurl", bech32.toWords(utf8.decode("https://example.com/lnurl")), 1023);
  assert.equal(lnurlpMetadataUrl(enc), "https://example.com/lnurl");
});

test("lnurlpMetadataUrl rejects non-addresses", () => {
  assert.throws(() => lnurlpMetadataUrl("not-an-address"));
});
