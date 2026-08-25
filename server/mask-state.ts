/**
 * File-backed on/off switch for sensitive-data masking in Telegram / dashboard
 * renders. Defaults to OFF (current behavior) so flipping it on is an explicit
 * operator decision and existing UX doesn't change without intent.
 *
 * Used by:
 *   - /maskcc on|off  — Telegram toggle (admin only)
 *   - GET/PUT /api/mask-state — dashboard toggle
 *
 * When ON, the renderers in telegram-bot.ts run card/charge/intent strings
 * through sensitive-mask.ts before sending so the broadcast/DM hides the PAN
 * body, CVV, ch_ and pi_ ids — outcome and address still visible.
 */
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.resolve(process.cwd(), "data", ".mask-state.json");

let cache: { enabled: boolean; updatedAt: string | null } | null = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      cache = { enabled: !!parsed.enabled, updatedAt: parsed.updatedAt || null };
      return cache;
    }
  } catch { /* fall through to default */ }
  cache = { enabled: false, updatedAt: null };
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.error("[mask-state] persist failed:", e?.message ?? e);
  }
}

export function isMaskEnabled(): boolean {
  return load().enabled;
}

export function setMaskEnabled(enabled: boolean): { enabled: boolean; updatedAt: string } {
  const s = load();
  s.enabled = !!enabled;
  s.updatedAt = new Date().toISOString();
  persist();
  return { enabled: s.enabled, updatedAt: s.updatedAt };
}

export function getMaskState(): { enabled: boolean; updatedAt: string | null } {
  return { ...load() };
}
