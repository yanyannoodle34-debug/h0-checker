/**
 * Tests for PayPal checker flow detection and response classification.
 *
 * Run with: npm test
 * Or: npx tsx --test server/paypal-checker.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyPayPalResponse } from "./paypal-checker";

// Test constants
const GATE_NAME = "Test PayPal Gate";
const CARD_META = { brand: "visa", funding: "CREDIT", country: "US" };
const ISSUER = "TEST BANK";
const FULL_CARD_INFO = "4242424242424242|12|2030|123";
const LATENCY = 100;

// ─── PayPal JSON response classification ────────────────────────────────────────

test("PayPal JSON: COMPLETED status → live (CVV LIVE)", () => {
  const json = { status: "COMPLETED" };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CVV LIVE ✓ PayPal Approved"));
  assert.equal(r.code, "pp_approved");
});

test("PayPal JSON: APPROVED status → live (CVV LIVE)", () => {
  const json = { status: "APPROVED" };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CVV LIVE ✓ PayPal Approved"));
});

test("PayPal JSON: success=true → live", () => {
  const json = { success: true };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CVV LIVE ✓ PayPal Approved"));
});

test("PayPal JSON: PAYER_ACTION_REQUIRED → live (3DS)", () => {
  const json = { status: "PAYER_ACTION_REQUIRED" };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("3DS Required"));
  assert.equal(r.code, "pp_3ds_required");
});

test("PayPal JSON: REQUIRES_ACTION with 3ds in issue → live (3DS)", () => {
  // REQUIRES_ACTION alone doesn't trigger 3DS - need 3ds/authentication in issue
  const json = { status: "REQUIRES_ACTION", details: [{ issue: "3DS_REQUIRED" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("3DS Required"));
});

test("PayPal JSON: instrument_declined → live (CCN LIVE)", () => {
  const json = { status: "DECLINED", details: [{ issue: "INSTRUMENT_DECLINED" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CCN LIVE"));
});

test("PayPal JSON: insufficient_funds → live (CCN LIVE)", () => {
  const json = { details: [{ issue: "INSUFFICIENT_FUNDS" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CCN LIVE"));
});

test("PayPal JSON: do_not_honor → live (CCN LIVE)", () => {
  const json = { details: [{ issue: "DO_NOT_HONOR" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CCN LIVE"));
});

test("PayPal JSON: cvv2_failure → live (CCN LIVE)", () => {
  const json = { details: [{ issue: "CVV2_FAILURE" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CCN LIVE"));
});

test("PayPal JSON: invalid_card → dead", () => {
  const json = { details: [{ issue: "INVALID_CARD" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
  assert.ok(r.response.includes("DECLINED"));
});

test("PayPal JSON: card_expired → dead", () => {
  const json = { details: [{ issue: "CARD_EXPIRED" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
  assert.ok(r.response.includes("DECLINED"));
});

test("PayPal JSON: fraud/suspected_fraud → dead", () => {
  const json = { details: [{ issue: "SUSPECTED_FRAUD" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
  assert.ok(r.response.includes("DECLINED"));
});

test("PayPal JSON: unknown issue → dead with description", () => {
  const json = { details: [{ issue: "SOME_UNKNOWN_ISSUE", description: "Transaction declined" }] };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
  assert.ok(r.response.includes("Transaction declined"));
});

// ─── PayPal HTML/text response classification ───────────────────────────────────

test("HTML: success=true envelope → live (GiveWP/WP-AJAX)", () => {
  const html = '{"success":true,"data":{"id":"EC-123"}}';
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CVV LIVE ✓ PayPal Charge Approved"));
});

test("HTML: payment successful → live", () => {
  const html = "Payment successful! Thank you for your donation.";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CVV LIVE ✓ PayPal Checkout Confirmed"));
});

test("HTML: order confirmed → live", () => {
  const html = "Your order confirmed successfully.";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CVV LIVE ✓ PayPal Checkout Confirmed"));
});

test("HTML: insufficient funds → live (CCN)", () => {
  const html = "Insufficient funds in your account";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CCN LIVE"));
});

test("HTML: do not honor → live (CCN)", () => {
  const html = "Do not honor";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("CCN LIVE"));
});

test("HTML: card declined → dead", () => {
  const html = "card declined";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
  assert.ok(r.response.includes("DECLINED"));
});

test("HTML: invalid card number → dead", () => {
  const html = "card number is invalid";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
});

test("HTML: expired card → dead", () => {
  const html = "card is expired";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
});

test("HTML: fraud suspected → dead", () => {
  const html = "Suspected fraud";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "dead");
});

test("HTML: 3ds required → live (3DS)", () => {
  const html = "3ds required";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("3ds"));
});

test("HTML: authentication required → live (3DS)", () => {
  const html = "authentication required";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
  assert.ok(r.response.includes("authentication required"));
});

test("HTML: unknown response → error", () => {
  const html = "Some completely unknown response text";
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "error");
  assert.ok(r.response.includes("Unknown Response"));
});

// ─── Edge cases ────────────────────────────────────────────────────────────────

test("Empty response → error", () => {
  const r = classifyPayPalResponse("", null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "error");
});

test("Case insensitive matching works", () => {
  const html = "INSUFFICIENT FUNDS"; // uppercase
  const r = classifyPayPalResponse(html, null, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.status, "live");
});

test("Response includes card brand and country", () => {
  const json = { status: "COMPLETED" };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.ok(r.response.includes("visa"));
  assert.ok(r.response.includes("[US]"));
  assert.ok(r.response.includes("TEST BANK"));
});

test("Latency is preserved", () => {
  const json = { status: "COMPLETED" };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, FULL_CARD_INFO, 250);
  assert.equal(r.latency, 250);
});

test("Gate name is preserved", () => {
  const json = { status: "COMPLETED" };
  const r = classifyPayPalResponse("", json, "My Custom Gate", CARD_META, ISSUER, FULL_CARD_INFO, LATENCY);
  assert.equal(r.gate, "My Custom Gate");
});

test("Full card info is preserved", () => {
  const json = { status: "COMPLETED" };
  const r = classifyPayPalResponse("", json, GATE_NAME, CARD_META, ISSUER, "4111111111111111|01|2025|123", LATENCY);
  assert.equal(r.cardInfo, "4111111111111111|01|2025|123");
});