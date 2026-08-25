/**
 * File-backed on/off toggles for Telegram bot commands and major features.
 * The owner can enable/disable any feature without a server restart and
 * without a schema migration.
 *
 * State at data/.feature-toggles.json (mode 0600); in-memory cached for
 * cheap hot-path reads.
 *
 * Use:
 *   if (!isFeatureEnabled("ai_chat")) { bot.sendMessage(chatId, "Disabled"); return; }
 *
 * Defaults: everything ON. The toggles only matter once an admin explicitly
 * turns one off.
 */
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.resolve(process.cwd(), "data", ".feature-toggles.json");

/** Canonical list of feature keys. Add a new entry here when you wire up
 *  a new command and want it to respect the toggle system. The order is
 *  the order shown in the /features admin command. */
export const FEATURE_KEYS = [
  "chk",            // /chk single card check
  "mass",           // /mass + .txt upload mass check
  "hit",            // /hit single Stripe checkout hit
  "autohit",        // /autohit recurring hit loop
  "gen",            // /gen card generator
  "miner",          // /miner server-side mining
  "ccex",           // /ccex extract cards from text
  "binex",          // /binex extract BINs from text
  "ai_chat",        // /ai admin chat
  "ai_config",      // /aiconfig auto-configurator
  "ai_analyzer",    // background failure analyzer (also gated by its own switch)
  "editgate",       // /editgate inline editor
  "threeds_inspect",// /3ds challenge inspector
  "watch",          // /watch gate DM subscriptions
  "channel_post",   // live-card broadcast to main channel
  "mine",           // /mine range-based CC miner
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

interface ToggleState {
  /** Map of feature → enabled. Missing key = enabled by default. */
  features: Partial<Record<FeatureKey, boolean>>;
  updatedAt: string | null;
}

let cache: ToggleState | null = null;

function load(): ToggleState {
  if (cache) return cache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      cache = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return cache!;
    }
  } catch { /* fall through */ }
  cache = { features: {}, updatedAt: null };
  return cache!;
}

function persist(): void {
  if (!cache) return;
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.error("[feature-toggles] persist failed:", e?.message ?? e);
  }
}

export function isFeatureEnabled(key: FeatureKey): boolean {
  const s = load();
  // Missing = enabled by default (admins only see what they explicitly turned off)
  return s.features[key] !== false;
}

export function setFeatureEnabled(key: FeatureKey, enabled: boolean): ToggleState {
  const s = load();
  s.features[key] = !!enabled;
  s.updatedAt = new Date().toISOString();
  persist();
  return { ...s };
}

export function getAllFeatureStates(): Array<{ key: FeatureKey; enabled: boolean }> {
  const s = load();
  return FEATURE_KEYS.map(k => ({ key: k, enabled: s.features[k] !== false }));
}

export function resetAllFeatures(): void {
  const s = load();
  s.features = {};
  s.updatedAt = new Date().toISOString();
  persist();
}
