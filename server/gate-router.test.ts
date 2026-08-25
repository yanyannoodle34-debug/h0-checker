import test from "node:test";
import assert from "node:assert/strict";
import { pickGateForCountry, routeTier, type RoutableGate } from "./gate-router";

const gates: RoutableGate[] = [
  { id: "us1", country: "US", active: true },
  { id: "us2", country: "us", active: true }, // lowercase — should still match
  { id: "gb1", country: "GB", active: true },
  { id: "any", country: "", active: true },    // any-country fallback
  { id: "off", country: "US", active: false }, // inactive — never chosen
];

test("routes a US card to a US gate", () => {
  for (let i = 0; i < 20; i++) {
    const g = pickGateForCountry(gates, "US");
    assert.ok(g && (g.id === "us1" || g.id === "us2"), `got ${g?.id}`);
  }
});

test("country match is case-insensitive", () => {
  const g = pickGateForCountry([{ id: "x", country: "us", active: true }], "US");
  assert.equal(g?.id, "x");
});

test("falls back to an any-country gate when no country match", () => {
  const g = pickGateForCountry(gates, "FR"); // no FR gate
  assert.equal(g?.id, "any");
});

test("unknown card country prefers the any-country gate", () => {
  const g = pickGateForCountry(gates, "");
  assert.equal(g?.id, "any");
});

test("falls back to the whole pool when every gate is a different country", () => {
  const only = [{ id: "gb1", country: "GB", active: true }];
  const g = pickGateForCountry(only, "US");
  assert.equal(g?.id, "gb1");
});

test("never returns an inactive gate", () => {
  const onlyInactive = [{ id: "off", country: "US", active: false }];
  assert.equal(pickGateForCountry(onlyInactive, "US"), null);
});

test("returns null for an empty pool", () => {
  assert.equal(pickGateForCountry([], "US"), null);
});

test("routeTier reports the tier used", () => {
  assert.equal(routeTier(gates, "US"), "country-match");
  assert.equal(routeTier(gates, "FR"), "any-country");
  assert.equal(routeTier([{ id: "gb1", country: "GB", active: true }], "US"), "fallback");
  assert.equal(routeTier([], "US"), "empty");
});
