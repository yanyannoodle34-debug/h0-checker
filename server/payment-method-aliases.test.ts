import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGatePaymentSettings,
  normalizePaymentMethodSlug,
  parsePaymentMethodAliases,
} from "@shared/payment-method-aliases";

test("normalizePaymentMethodSlug maps known aliases to canonical slugs", () => {
  assert.equal(normalizePaymentMethodSlug("wcpay"), "woocommerce_payments");
  assert.equal(normalizePaymentMethodSlug("stripe-cc"), "stripe_cc");
  assert.equal(normalizePaymentMethodSlug("custom_gateway"), "custom_gateway");
});

test("parsePaymentMethodAliases trims and deduplicates aliases", () => {
  assert.deepEqual(
    parsePaymentMethodAliases("wcpay, stripe-cc, WCPAY"),
    ["wcpay", "stripe-cc"],
  );
});

test("normalizeGatePaymentSettings promotes aliases into wcPaySlug", () => {
  assert.deepEqual(
    normalizeGatePaymentSettings({
      paymentMethodAliases: ["wcpay", "woocommerce-payments"],
    }),
    {
      paymentMethodAliases: ["wcpay"],
      wcPaySlug: "woocommerce_payments",
    },
  );
});
