/**
 * Tests for the VBV/3DS pre-check status mapping.
 *
 * vbvCheck() itself does network I/O (covered by manual/integration use); the
 * classification logic that decides passed/otp/declined/error is the part that
 * gates whether we skip an expensive flow, so it's factored into the pure
 * mapVbvStatus() and tested exhaustively here.
 *
 *   npx tsx --test server/vbv-checker.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mapVbvStatus, binThreeDsHeuristic, vbvCheck } from "./vbv-checker";

test("reference statuses map correctly", () => {
  assert.equal(mapVbvStatus("Passed"), "passed");
  assert.equal(mapVbvStatus("OTP"), "otp");
  assert.equal(mapVbvStatus("Declined"), "declined");
});

test("case-insensitive and whitespace-tolerant", () => {
  assert.equal(mapVbvStatus("  PASSED  "), "passed");
  assert.equal(mapVbvStatus("declined"), "declined");
  assert.equal(mapVbvStatus("Otp"), "otp");
});

test("accepted synonyms", () => {
  assert.equal(mapVbvStatus("pass"), "passed");
  assert.equal(mapVbvStatus("approved"), "passed");
  assert.equal(mapVbvStatus("live"), "passed");
  assert.equal(mapVbvStatus("3ds"), "otp");
  assert.equal(mapVbvStatus("enrolled"), "otp");
  assert.equal(mapVbvStatus("challenge"), "otp");
  assert.equal(mapVbvStatus("decline"), "declined");
  assert.equal(mapVbvStatus("dead"), "declined");
  assert.equal(mapVbvStatus("failed"), "declined");
});

test("unknown / empty / null map to error (never a false decline)", () => {
  assert.equal(mapVbvStatus("something weird"), "error");
  assert.equal(mapVbvStatus(""), "error");
  assert.equal(mapVbvStatus(null), "error");
  assert.equal(mapVbvStatus(undefined), "error");
  assert.equal(mapVbvStatus(42), "error");
});

// ─── vbvCheck disabled when no endpoint ──────────────────────────────────────

test("vbvCheck with no endpoint configured resolves to error (disabled), no network", async () => {
  const r = await vbvCheck("4111111111111111|12|26|123", { endpoint: "" });
  assert.equal(r.status, "error");
  assert.match(r.response, /no VBV endpoint/i);
  assert.equal(r.latency, 0);
});

// ─── BIN 3DS heuristic ───────────────────────────────────────────────────────

test("SCA countries → likely_3ds", () => {
  for (const c of ["GB", "DE", "FR", "IN", "NO", "IS", "LI", "ES", "IT"]) {
    assert.equal(binThreeDsHeuristic({ country: c }).likelihood, "likely_3ds", `expected ${c} likely_3ds`);
  }
});

test("non-SCA countries → likely_frictionless", () => {
  for (const c of ["US", "CA", "BR", "AU", "JP", "MX"]) {
    assert.equal(binThreeDsHeuristic({ country: c }).likelihood, "likely_frictionless", `expected ${c} frictionless`);
  }
});

test("case-insensitive country and missing/empty → unknown", () => {
  assert.equal(binThreeDsHeuristic({ country: "gb" }).likelihood, "likely_3ds");
  assert.equal(binThreeDsHeuristic({ country: "" }).likelihood, "unknown");
  assert.equal(binThreeDsHeuristic(null).likelihood, "unknown");
  assert.equal(binThreeDsHeuristic(undefined).likelihood, "unknown");
});
