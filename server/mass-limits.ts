/**
 * File-backed per-tier mass-check batch limit.
 *
 * - adminMax — the maximum number of cards an admin can submit in one /mass
 *              run or .txt upload. Default 500.
 * - userMax  — same, for non-admin key-holders. Default 50.
 *
 * Owner edits via /setmasslimit or the dashboard. File-backed so no schema
 * migration; in-memory cached so the hot path doesn't touch disk.
 */
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.resolve(process.cwd(), "data", ".mass-limits.json");
const DEFAULTS = { adminMax: 500, userMax: 50 };
const HARD_MAX = 5000; // sanity cap — refuse anything beyond this so a typo
                       // can't ask the server to chew through 1M cards.

interface MassLimits {
  adminMax: number;
  userMax: number;
  updatedAt: string | null;
}

let cache: MassLimits | null = null;

function load(): MassLimits {
  if (cache) return cache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      cache = {
        adminMax: Number.isFinite(parsed.adminMax) ? parsed.adminMax : DEFAULTS.adminMax,
        userMax:  Number.isFinite(parsed.userMax)  ? parsed.userMax  : DEFAULTS.userMax,
        updatedAt: parsed.updatedAt ?? null,
      };
      return cache!;
    }
  } catch { /* fall through */ }
  cache = { ...DEFAULTS, updatedAt: null };
  return cache!;
}

function persist(): void {
  if (!cache) return;
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.error("[mass-limits] persist failed:", e?.message ?? e);
  }
}

export function getMassLimits(): MassLimits {
  return { ...load() };
}

export function getMaxCards(isAdmin: boolean): number {
  const s = load();
  return isAdmin ? s.adminMax : s.userMax;
}

export function setMassLimit(tier: "admin" | "user", value: number): MassLimits | { error: string } {
  if (!Number.isFinite(value) || value < 1) return { error: "value must be a positive integer" };
  if (value > HARD_MAX) return { error: `value must be ≤ ${HARD_MAX} (hard cap)` };
  const s = load();
  if (tier === "admin") s.adminMax = Math.floor(value);
  else                  s.userMax  = Math.floor(value);
  s.updatedAt = new Date().toISOString();
  persist();
  return { ...s };
}

export function resetMassLimits(): MassLimits {
  cache = { ...DEFAULTS, updatedAt: new Date().toISOString() };
  persist();
  return { ...cache };
}

export const MASS_LIMIT_HARD_CAP = HARD_MAX;
