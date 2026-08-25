import test from "node:test";
import assert from "node:assert/strict";
import { recordCheck, checkVelocity, dedupCardList, pruneOld, velocityGuardSize, clearVelocityGuard } from "./velocity-guard";

test("after recordCheck, same card is blocked within the window", () => {
  clearVelocityGuard();
  recordCheck("4111111111111111|12|26|123");
  const r = checkVelocity("4111111111111111|12|26|123", 60_000);
  assert.equal(r.blocked, true);
  assert.ok(r.msSince < 1000);
});

test("different PAN is not blocked", () => {
  clearVelocityGuard();
  recordCheck("4111111111111111|12|26|123");
  const r = checkVelocity("5500005555555559|01|27|456", 60_000);
  assert.equal(r.blocked, false);
});

test("card is not blocked after the window expires", async () => {
  clearVelocityGuard();
  recordCheck("4111111111111111|12|26|123");
  // Wait 10ms then check with a 5ms window — entry is definitely expired.
  await new Promise(r => setTimeout(r, 10));
  const r = checkVelocity("4111111111111111|12|26|123", 5);
  assert.equal(r.blocked, false);
});

test("bare PAN works the same as pipe-separated card string", () => {
  clearVelocityGuard();
  recordCheck("4111111111111111");
  const r = checkVelocity("4111111111111111|01|27|999", 60_000);
  assert.equal(r.blocked, true);
});

test("dedupCardList removes duplicate PANs, keeps first occurrence", () => {
  const cards = [
    "4111111111111111|01|26|123",
    "5500005555555559|02|27|456",
    "4111111111111111|03|28|789",  // dupe PAN
    "4111111111111111|04|29|000",  // dupe PAN again
  ];
  const { unique, dupeCount } = dedupCardList(cards);
  assert.equal(dupeCount, 2);
  assert.equal(unique.length, 2);
  assert.equal(unique[0], cards[0]);
  assert.equal(unique[1], cards[1]);
});

test("dedupCardList treats short/invalid strings as non-card passthrough", () => {
  const { unique, dupeCount } = dedupCardList(["short", "5500005555555559|01|26|123"]);
  assert.equal(unique.length, 2);
  assert.equal(dupeCount, 0);
});

test("pruneOld removes expired entries and returns count", async () => {
  clearVelocityGuard();
  recordCheck("4111111111111111|01|26|111");
  recordCheck("5500005555555559|02|27|222");
  assert.equal(velocityGuardSize(), 2);
  // Wait so entries are definitely older than the 5ms window.
  await new Promise(r => setTimeout(r, 10));
  const removed = pruneOld(5);
  assert.equal(removed, 2);
  assert.equal(velocityGuardSize(), 0);
});

test("clearVelocityGuard wipes all entries", () => {
  recordCheck("4111111111111111|01|26|111");
  assert.ok(velocityGuardSize() >= 1);
  clearVelocityGuard();
  assert.equal(velocityGuardSize(), 0);
});
