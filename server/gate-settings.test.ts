import test from "node:test";
import assert from "node:assert/strict";

import {
  gateCreateSchema,
  gatePatchSchema,
  gateSettingsSchema,
} from "@shared/gate-settings";

test("gateSettingsSchema normalizes slugs, aliases, booleans, arrays, and countries", () => {
  const parsed = gateSettingsSchema.parse({
    wcPaySlug: "wcpay",
    paymentMethodAliases: "stripe-cc, woocommerce-payments, stripe-cc",
    proxyCountry: "us",
    autoValidate: "true",
    liveOverrides: "insufficient_funds, do_not_honor",
  });

  assert.deepEqual(parsed, {
    wcPaySlug: "woocommerce_payments",
    paymentMethodAliases: ["stripe-cc", "woocommerce-payments"],
    proxyCountry: "US",
    autoValidate: true,
    liveOverrides: ["insufficient_funds", "do_not_honor"],
  });
});

test("gateCreateSchema requires core top-level fields", () => {
  const parsed = gateCreateSchema.parse({
    name: "Stripe Demo",
    gateType: "stripe",
    url: "https://example.test/checkout",
  });

  assert.equal(parsed.name, "Stripe Demo");
  assert.equal(parsed.gateType, "stripe");
  assert.equal(parsed.url, "https://example.test/checkout");
});

test("gatePatchSchema rejects empty payloads", () => {
  assert.throws(() => gatePatchSchema.parse({}), /No gate fields provided/);
});
