/**
 * Global "strict decline mode" — when ON, the four ambiguous decline codes
 * that we normally classify as CCN LIVE are forced to DEAD:
 *
 *   generic_decline   — bank refused without saying why
 *   do_not_honor      — same, slightly different code
 *   call_issuer       — bank wants cardholder to call them
 *   card_declined     — outer code with no inner decline_code
 *
 * Use case: admins who want a high-precision live pool and are willing to
 * miss soft-decline cards that might charge elsewhere. Per-gate
 * liveOverrides / deadOverrides still take precedence over this global
 * setting so individual gates can opt out.
 *
 * Stored in a file (no schema migration). In-memory cache keeps reads cheap
 * during a hot check loop.
 */
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.resolve(process.cwd(), "data", ".classifier-mode.json");

export const STRICT_DECLINE_CODES = new Set([
  "generic_decline",
  "do_not_honor",
  "call_issuer",
  "card_declined",
]);

interface ClassifierState {
  strictDeclineMode: boolean;
  updatedAt: string | null;
}

let cache: ClassifierState | null = null;

function load(): ClassifierState {
  if (cache) return cache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      cache = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return cache!;
    }
  } catch { /* fall through */ }
  cache = { strictDeclineMode: false, updatedAt: null };
  return cache!;
}

export function getStrictDeclineMode(): boolean {
  return load().strictDeclineMode === true;
}

export function getClassifierState(): ClassifierState {
  return { ...load() };
}

export function setStrictDeclineMode(on: boolean): ClassifierState {
  const s = load();
  s.strictDeclineMode = !!on;
  s.updatedAt = new Date().toISOString();
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.error("[classifier-mode] write failed:", e?.message ?? e);
  }
  return { ...s };
}

/** True if the given decline code should be force-classified DEAD under strict mode. */
export function shouldForceDead(code: string): boolean {
  if (!code) return false;
  if (!getStrictDeclineMode()) return false;
  return STRICT_DECLINE_CODES.has(code.toLowerCase());
}
