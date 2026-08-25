import test from "node:test";
import assert from "node:assert/strict";
import { maskCardLine, maskPan, maskChargeId, maskIntentId } from "./sensitive-mask";

test("maskPan keeps first 6 + last 4, masks the middle", () => {
  assert.equal(maskPan("4111111111111111"), "411111******1111");
  assert.equal(maskPan("371449635398431"), "371449*****8431"); // 15-digit AmEx
});

test("maskPan leaves short inputs untouched", () => {
  assert.equal(maskPan("123"), "123");
  assert.equal(maskPan(""), "");
});

test("maskCardLine masks PAN and CVV but preserves expiry", () => {
  assert.equal(maskCardLine("4111111111111111|12|26|123"), "411111******1111|12|26|***");
  assert.equal(maskCardLine("371449635398431|01|27|1234"), "371449*****8431|01|27|****");
});

test("maskCardLine handles bare PAN (no pipes)", () => {
  assert.equal(maskCardLine("4111111111111111"), "411111******1111");
});

test("maskChargeId only masks ch_*", () => {
  assert.equal(maskChargeId("ch_3OqWqW2eZvKYlo2C1abc1234"), "ch_***1234");
  assert.equal(maskChargeId("pi_3OqWqW2eZvKYlo2C1abc1234"), "pi_3OqWqW2eZvKYlo2C1abc1234"); // not a charge
  assert.equal(maskChargeId(""), "");
});

test("maskIntentId masks pi_ and seti_", () => {
  assert.equal(maskIntentId("pi_3OqWqW2eZvKYlo2Cabcd"), "pi_***abcd");
  assert.equal(maskIntentId("seti_1OqWqW2eZvKYlo2Cabcd"), "seti_***abcd");
  assert.equal(maskIntentId("ch_someid_1234"), "ch_someid_1234"); // not an intent
});
