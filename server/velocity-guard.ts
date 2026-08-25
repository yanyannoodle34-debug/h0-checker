/**
 * Velocity / dedup guard for mass card checks.
 *
 * Maintains an in-memory TTL map of recently-checked PANs so mass runs can:
 *   1. Dedup their own list (same PAN appearing twice in one .txt file)
 *   2. Skip re-checking a card that was already checked in a recent prior run
 *      (velocity burn: each extra auth attempt increases fraud-flag risk)
 *
 * Purely in-memory — intentionally not persisted. The purpose is short-term
 * burn prevention (minutes, not days). A server restart resets it, which is
 * fine for this use case.
 */

/** Map: PAN → Unix-ms timestamp of most-recent check. */
const _seen = new Map<string, number>();

/** Normalise a card string to a bare PAN for keying purposes. Accepts either
 *  a raw PAN or a "PAN|MM|YY|CVV" pipe-separated string. */
function normalisePan(cardOrPan: string): string {
  const pan = cardOrPan.split("|")[0].trim().replace(/\D/g, "");
  return pan;
}

/**
 * Record that a card was just checked. Call after (not before) the gate hit
 * so a failed parse never poisons the guard.
 */
export function recordCheck(cardOrPan: string): void {
  const pan = normalisePan(cardOrPan);
  if (pan.length >= 13) _seen.set(pan, Date.now());
}

/**
 * Check whether a card is within the velocity window.
 *
 * @param cardOrPan   Full card string or bare PAN.
 * @param windowMs    Cooldown window in milliseconds.
 * @returns `{ blocked: true, msSince }` if within the window, else `{ blocked: false }`.
 */
export function checkVelocity(
  cardOrPan: string,
  windowMs: number,
): { blocked: boolean; msSince: number } {
  const pan = normalisePan(cardOrPan);
  if (pan.length < 13) return { blocked: false, msSince: 0 };
  const last = _seen.get(pan);
  if (last === undefined) return { blocked: false, msSince: 0 };
  const msSince = Date.now() - last;
  if (msSince < windowMs) return { blocked: true, msSince };
  // Expired — clean up so the map stays small.
  _seen.delete(pan);
  return { blocked: false, msSince };
}

/**
 * Deduplicate a list of card strings (PAN|MM|YY|CVV format) by PAN,
 * keeping the first occurrence. Returns a new array; the original is unchanged.
 */
export function dedupCardList(cards: string[]): { unique: string[]; dupeCount: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  let dupeCount = 0;
  for (const c of cards) {
    const pan = normalisePan(c);
    if (pan.length < 13) { unique.push(c); continue; }
    if (seen.has(pan)) { dupeCount++; continue; }
    seen.add(pan);
    unique.push(c);
  }
  return { unique, dupeCount };
}

/**
 * Prune entries older than `windowMs` from the map. Called at the start of
 * each mass run to keep memory bounded without a separate timer.
 */
export function pruneOld(windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  let removed = 0;
  for (const [pan, ts] of _seen) {
    if (ts < cutoff) { _seen.delete(pan); removed++; }
  }
  return removed;
}

/** How many PANs are currently tracked (for the /massdedup status reply). */
export function velocityGuardSize(): number {
  return _seen.size;
}

/** Wipe the entire guard (for tests or /massdedup clear). */
export function clearVelocityGuard(): void {
  _seen.clear();
}
