/**
 * Tests for the Stripe response normalizer.
 *
 * Runs on Node's built-in test runner (no extra deps) via tsx:
 *   npm test          (added to package.json scripts)
 *   npx tsx --test server/stripe-response-normalizer.test.ts
 *
 * The normalizer's correctness hinges on two things that are easy to break
 * silently when a new detector is added:
 *   1. Each known wrapper shape resolves to the right `source` + `status`.
 *   2. Detector *ordering* — a vaguer detector must not swallow a payload that
 *      a more specific one should claim (e.g. wc-order-rest before wc-checkout,
 *      custom-api / wp-rest-donation before the generic wp-admin-ajax).
 * Every case below asserts both fields so a reordering regression fails loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStripeResponse } from "./stripe-response-normalizer";

// ─── Stripe native ───────────────────────────────────────────────────────────

test("stripe PaymentIntent succeeded", () => {
  const r = normalizeStripeResponse({
    id: "pi_3Nxyz123", object: "payment_intent", amount: 5000,
    currency: "usd", status: "succeeded", customer: "cus_ABC123", payment_method: "pm_XYZ123",
  });
  assert.equal(r.source, "stripe-native");
  assert.equal(r.status, "succeeded");
  assert.equal(r.intentId, "pi_3Nxyz123");
});

test("stripe PaymentIntent requires_action", () => {
  const r = normalizeStripeResponse({ id: "pi_abc", status: "requires_action", next_action: { type: "use_stripe_sdk" } });
  assert.equal(r.source, "stripe-native");
  assert.equal(r.status, "requires_action");
});

test("stripe error envelope extracts decline_code", () => {
  const r = normalizeStripeResponse({ error: { code: "card_declined", decline_code: "insufficient_funds", type: "card_error", message: "Your card has insufficient funds." } });
  assert.equal(r.source, "stripe-native");
  assert.equal(r.status, "failed");
  assert.equal(r.code, "insufficient_funds");
});

// ─── WooCommerce REST order ──────────────────────────────────────────────────

test("WC REST order processing → succeeded", () => {
  const r = normalizeStripeResponse({
    id: 1234, status: "processing", currency: "USD", total: "99.99",
    payment_method: "stripe", payment_method_title: "Credit Card (Stripe)",
    transaction_id: "pi_123456789", date_created: "2026-06-24T12:00:00",
    billing: { first_name: "John", last_name: "Doe", email: "john@example.com" },
  });
  assert.equal(r.source, "wc-order-rest");
  assert.equal(r.status, "succeeded");
  assert.equal(r.intentId, "pi_123456789");
});

test("WC REST order failed → failed with code", () => {
  const r = normalizeStripeResponse({ id: 99, status: "failed", payment_method: "stripe", total: "10.00" });
  assert.equal(r.source, "wc-order-rest");
  assert.equal(r.status, "failed");
  assert.equal(r.code, "failed");
});

test("WC REST order on-hold → requires_action", () => {
  const r = normalizeStripeResponse({ id: 99, status: "on-hold", payment_method: "stripe", total: "10.00" });
  assert.equal(r.source, "wc-order-rest");
  assert.equal(r.status, "requires_action");
});

// ─── PayPal ──────────────────────────────────────────────────────────────────

test("PayPal capture COMPLETED → succeeded", () => {
  const r = normalizeStripeResponse({
    id: "8SU12345AB678901C", status: "COMPLETED", intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: "50.00" } }],
    payer: { email_address: "customer@example.com" },
  });
  assert.equal(r.source, "paypal");
  assert.equal(r.status, "succeeded");
  assert.match(r.message || "", /50\.00 USD/);
});

test("PayPal APPROVED → requires_action", () => {
  const r = normalizeStripeResponse({ id: "X1", status: "APPROVED", intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] });
  assert.equal(r.source, "paypal");
  assert.equal(r.status, "requires_action");
});

test("PayPal VOIDED → failed", () => {
  const r = normalizeStripeResponse({ id: "X1", status: "VOIDED", intent: "AUTHORIZE", purchase_units: [] });
  assert.equal(r.source, "paypal");
  assert.equal(r.status, "failed");
  assert.equal(r.code, "voided");
});

// ─── WordPress REST custom donation ──────────────────────────────────────────

test("WP REST donation completed → succeeded", () => {
  const r = normalizeStripeResponse({
    success: true, donation_id: 5678, amount: 25.0, currency: "USD",
    status: "completed", donor: { name: "John Doe", email: "john@example.com" },
    message: "Thank you for your donation.",
  });
  assert.equal(r.source, "wp-rest-donation");
  assert.equal(r.status, "succeeded");
});

test("WP REST donation failed → failed", () => {
  const r = normalizeStripeResponse({ success: false, donation_id: 1, status: "failed", donor: { name: "x", email: "y" }, message: "Card declined" });
  assert.equal(r.source, "wp-rest-donation");
  assert.equal(r.status, "failed");
});

// ─── Custom gateway API ──────────────────────────────────────────────────────

test("custom donation API completed → succeeded, stripe txn extracted", () => {
  const r = normalizeStripeResponse({
    success: true, type: "donation", gateway: "stripe", transaction_id: "TXN123456",
    order_id: 1001, amount: 50.0, currency: "USD", status: "completed",
    customer: { name: "John Doe", email: "john@example.com" }, timestamp: "2026-06-24T12:30:00Z",
  });
  assert.equal(r.source, "custom-api");
  assert.equal(r.status, "succeeded");
  // Non-Stripe txn id is surfaced as `code`, not intentId
  assert.equal(r.code, "TXN123456");
  assert.equal(r.intentId, undefined);
});

test("custom API with pi_ transaction_id sets intentId not code", () => {
  const r = normalizeStripeResponse({ success: true, gateway: "stripe", order_id: 7, status: "completed", transaction_id: "pi_realintent99" });
  assert.equal(r.source, "custom-api");
  assert.equal(r.intentId, "pi_realintent99");
  assert.equal(r.code, undefined);
});

// ─── Ordering / precedence guards ────────────────────────────────────────────
// These are the cases most likely to regress if DETECTORS is reordered.

test("custom-api wins over wp-admin-ajax (both have success)", () => {
  // {success, gateway, customer} must NOT be claimed by the generic admin-ajax detector.
  const r = normalizeStripeResponse({ success: true, gateway: "stripe", customer: { name: "x", email: "y" }, status: "completed" });
  assert.equal(r.source, "custom-api");
});

test("wp-rest-donation wins over wp-admin-ajax (both have success)", () => {
  const r = normalizeStripeResponse({ success: true, donation_id: 5, donor: { name: "x", email: "y" }, status: "completed" });
  assert.equal(r.source, "wp-rest-donation");
});

test("wc-order-rest wins over wc-checkout (numeric id is specific)", () => {
  // Has both a numeric id (wc-order-rest) and would never match result:success/failure,
  // but this guards against a future loosening of detectWCCheckout.
  const r = normalizeStripeResponse({ id: 42, status: "completed", payment_method: "stripe", total: "5.00" });
  assert.equal(r.source, "wc-order-rest");
});

test("plain admin-ajax still falls through to wp-admin-ajax", () => {
  // No gateway / donation_id / donor markers → generic envelope.
  const r = normalizeStripeResponse({ success: false, data: { message: "Something went wrong" } });
  assert.equal(r.source, "wp-admin-ajax");
  assert.equal(r.status, "failed");
});

// ─── Existing wrapper shapes (regression coverage) ───────────────────────────

test("WC Store API failure", () => {
  const r = normalizeStripeResponse({ code: "woocommerce_rest_checkout_error", message: "Card declined", data: { status: 402 } });
  assert.equal(r.source, "wc-store-api");
  assert.equal(r.status, "failed");
});

test("WC classic checkout failure", () => {
  const r = normalizeStripeResponse({ result: "failure", messages: "<ul><li>Card was declined.</li></ul>" });
  assert.equal(r.source, "wc-checkout");
  assert.equal(r.status, "failed");
});

test("HTML success page", () => {
  const r = normalizeStripeResponse("<html><body><h1>Thank you for your purchase</h1></body></html>");
  assert.equal(r.source, "html");
  assert.equal(r.status, "succeeded");
});

// ─── Unknown fallback ────────────────────────────────────────────────────────

test("unrecognized JSON falls through to unknown with best-effort extraction", () => {
  const r = normalizeStripeResponse({ weird: { nested: { message: "totally unknown shape" } } });
  assert.equal(r.source, "unknown");
  assert.equal(r.status, "unknown");
  assert.equal(r.message, "totally unknown shape");
});

test("JSON string body is parsed before detectors run", () => {
  const r = normalizeStripeResponse('{"id":"pi_str","status":"succeeded"}');
  assert.equal(r.source, "stripe-native");
  assert.equal(r.status, "succeeded");
});

test("null body does not throw", () => {
  const r = normalizeStripeResponse(null);
  assert.equal(r.source, "unknown");
});
