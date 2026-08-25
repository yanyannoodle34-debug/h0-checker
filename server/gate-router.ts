/**
 * Gate routing by card country.
 *
 * "US card → US gate": given the card's BIN country, prefer an active gate whose
 * merchant serves that same country. A same-country billing+gate match is what
 * lets AVS actually run and makes a forced-3DS challenge less likely, so cards
 * clear more often instead of bouncing as requires_action / false declines.
 *
 * Pure and dependency-free so it can be unit-tested without a DB. The caller
 * resolves the BIN country (cached lookupBin) and passes the active-gate pool.
 */

/** Minimal shape this router needs from a gate config. */
export interface RoutableGate {
  id: string;
  country?: string | null; // ISO-2 the gate serves, or null/"" = any-country
  active?: boolean;
}

/** Random element (kept local so the module stays dependency-free). */
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Choose a gate for a card from a pool.
 *
 * Preference order:
 *   1. Active gates tagged with the card's country (exact ISO-2 match).
 *   2. Active gates with no country tag ("any-country" fallbacks).
 *   3. The whole active pool (last resort — better to check than to skip).
 *
 * Within the chosen tier a random gate is returned for load spread. Returns
 * `null` only when the pool is empty.
 *
 * @param gates        Candidate gates (caller usually pre-filters to active).
 * @param cardCountry  ISO-2 country of the card's BIN, or "" when unknown.
 */
export function pickGateForCountry<T extends RoutableGate>(
  gates: T[],
  cardCountry?: string | null,
): T | null {
  const pool = gates.filter(g => g.active !== false);
  if (pool.length === 0) return null;

  const want = (cardCountry || "").trim().toUpperCase();
  if (want) {
    const sameCountry = pool.filter(g => (g.country || "").trim().toUpperCase() === want);
    if (sameCountry.length) return pickRandom(sameCountry);
  }

  // No country match (or unknown card country) — prefer explicit any-country gates.
  const anyCountry = pool.filter(g => !(g.country || "").trim());
  if (anyCountry.length) return pickRandom(anyCountry);

  // Everything is tagged to a different country — still better to check than skip.
  return pickRandom(pool);
}

/** Which routing tier `pickGateForCountry` would use — for logging/UI hints. */
export function routeTier(
  gates: RoutableGate[],
  cardCountry?: string | null,
): "country-match" | "any-country" | "fallback" | "empty" {
  const pool = gates.filter(g => g.active !== false);
  if (pool.length === 0) return "empty";
  const want = (cardCountry || "").trim().toUpperCase();
  if (want && pool.some(g => (g.country || "").trim().toUpperCase() === want)) return "country-match";
  if (pool.some(g => !(g.country || "").trim())) return "any-country";
  return "fallback";
}
