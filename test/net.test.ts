import { test } from "node:test";
import assert from "node:assert/strict";

import { assertSafeFetchUrl, isPrivateHost } from "../src/protocol/net.js";

test("isPrivateHost flags loopback and RFC1918", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "10.0.0.5", "192.168.1.1", "172.16.9.9", "169.254.169.254", "100.64.1.1"]) {
    assert.ok(isPrivateHost(h), `${h} should be private`);
  }
  assert.ok(!isPrivateHost("example.com"));
  assert.ok(!isPrivateHost("172.32.0.1"));
  assert.ok(!isPrivateHost("8.8.8.8"));
});

test("assertSafeFetchUrl rejects http and private hosts by default", () => {
  assert.throws(() => assertSafeFetchUrl("http://example.com/x"), /insecure http/);
  assert.throws(() => assertSafeFetchUrl("https://127.0.0.1/x"), /private\/loopback/);
  assert.throws(() => assertSafeFetchUrl("file:///etc/passwd"), /unsupported URL scheme/);
});

test("assertSafeFetchUrl allows https public and opt-in local", () => {
  assert.equal(assertSafeFetchUrl("https://example.com/x").hostname, "example.com");
  assert.equal(assertSafeFetchUrl("http://localhost:3998/x", { allowHttp: true, allowPrivate: true }).hostname, "localhost");
});
