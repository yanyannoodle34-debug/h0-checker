import test from "node:test";
import assert from "node:assert/strict";
import { decodeBtTokenStrict } from "./bt-token";

const realToken = Buffer.from(JSON.stringify({
  authorizationFingerprint: "fp_real_abc",
  merchantId: "merch_xyz",
  clientApiUrl: "https://api.sandbox.braintreegateway.com",
})).toString("base64");

test("decodes a well-formed BT token", () => {
  const r = decodeBtTokenStrict(realToken);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.authFingerprint, "fp_real_abc");
  assert.equal(r.ok && r.merchantId, "merch_xyz");
  assert.equal(r.ok && r.clientApiUrl, "https://api.sandbox.braintreegateway.com");
});

test("empty / null / non-string input → empty", () => {
  assert.equal(decodeBtTokenStrict("").ok, false);
  // @ts-expect-error — runtime defence
  assert.equal(decodeBtTokenStrict(null as any).ok, false);
});

test("plain garbage → not_base64", () => {
  const r = decodeBtTokenStrict("not a base64 string!! <html>");
  assert.deepEqual(r, { ok: false, error: "not_base64" });
});

test("base64 of non-JSON bytes → not_json", () => {
  const r = decodeBtTokenStrict(Buffer.from("hello world bytes").toString("base64"));
  assert.deepEqual(r, { ok: false, error: "not_json" });
});

test("decodes JSON with no authorizationFingerprint → no_auth_fingerprint", () => {
  const stripeShaped = Buffer.from(JSON.stringify({ pk_token: "pk_test", account: "acct_x" })).toString("base64");
  const r = decodeBtTokenStrict(stripeShaped);
  assert.deepEqual(r, { ok: false, error: "no_auth_fingerprint" });
});

test("tolerates URL-encoded padding (=  → %3D)", () => {
  const urlEncoded = encodeURIComponent(realToken);
  const r = decodeBtTokenStrict(urlEncoded);
  assert.ok(r.ok);
  assert.equal(r.ok && r.authFingerprint, "fp_real_abc");
});

test("tolerates JSON-escaped slashes (\\/  →  /)", () => {
  const escaped = realToken.replace(/\//g, "\\/");
  const r = decodeBtTokenStrict(escaped);
  assert.ok(r.ok);
});

test("tolerates unicode-escaped = (\\u003D)", () => {
  // Strip "=" then replace with the unicode escape — exercises the cleanup step.
  const escaped = realToken.replace(/=/g, "\\u003d");
  const r = decodeBtTokenStrict(escaped);
  assert.ok(r.ok);
});

test("strips missing padding and still decodes", () => {
  const stripped = realToken.replace(/=+$/, "");
  const r = decodeBtTokenStrict(stripped);
  assert.ok(r.ok);
});

test("unwraps {data: '<inner base64>'} envelope", () => {
  const wrapped = Buffer.from(JSON.stringify({ data: realToken })).toString("base64");
  const r = decodeBtTokenStrict(wrapped);
  assert.ok(r.ok);
  assert.equal(r.ok && r.authFingerprint, "fp_real_abc");
});
