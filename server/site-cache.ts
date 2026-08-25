/**
 * Site-level cooldown & session caches — ported from braintree_gate.py
 * (_SiteCooldownTracker + _SiteSessionCache).
 *
 * Purpose:
 *  - Throttle requests per target hostname when we see repeated 4xx/5xx, captcha,
 *    or "blocked" signals, so we don't burn a site after a decline storm.
 *  - Reuse extracted nonces / cookies / detected publishable keys across checks
 *    for ~5 minutes to cut latency and reduce the chance of being fingerprinted
 *    as a fresh session every request.
 */

function siteKey(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url.toLowerCase(); }
}

// ─── Cooldown tracker ───────────────────────────────────────────────────────
class SiteCooldownTracker {
  private checks = new Map<string, number[]>();  // hostname -> timestamps (last 10 min)
  private blocks = new Map<string, number>();    // hostname -> consecutive block count
  private readonly WINDOW_MS = 10 * 60_000;

  recordCheck(url: string): void {
    const k = siteKey(url);
    const now = Date.now();
    const arr = (this.checks.get(k) ?? []).filter(t => now - t < this.WINDOW_MS);
    arr.push(now);
    this.checks.set(k, arr);
  }

  recordBlock(url: string): void {
    const k = siteKey(url);
    this.blocks.set(k, (this.blocks.get(k) ?? 0) + 1);
  }

  recordSuccess(url: string): void {
    // A clean response resets the block counter — we're no longer burned.
    this.blocks.delete(siteKey(url));
  }

  /** Milliseconds to sleep before the next request to this site (0 if cool). */
  getCooldownMs(url: string): number {
    const k = siteKey(url);
    const now = Date.now();
    const recent = (this.checks.get(k) ?? []).filter(t => now - t < this.WINDOW_MS).length;
    const blocks = this.blocks.get(k) ?? 0;
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    if (blocks >= 3) return rand(500, 1500);
    if (blocks >= 1) return rand(300, 800);
    if (recent >= 10) return rand(500, 1500);
    if (recent >= 6) return rand(300, 800);
    if (recent >= 3) return rand(100, 400);
    if (recent >= 1) return rand(50, 200);
    return 0;
  }

  reset(url: string): void {
    const k = siteKey(url);
    this.checks.delete(k);
    this.blocks.delete(k);
  }

  /** All hostnames currently tracked (checks or blocks). */
  trackedHostnames(): string[] {
    const set = new Set<string>([...this.checks.keys(), ...this.blocks.keys()]);
    return [...set];
  }

  /** Snapshot of per-site health for the UI health panel. */
  getStats(url: string): { checks10min: number; blocks: number; lastCheck: number | null } {
    const k = siteKey(url);
    const now = Date.now();
    const recent = (this.checks.get(k) ?? []).filter(t => now - t < this.WINDOW_MS);
    const lastCheck = recent.length ? recent[recent.length - 1] : null;
    return {
      checks10min: recent.length,
      blocks: this.blocks.get(k) ?? 0,
      lastCheck,
    };
  }
}

export const siteCooldown = new SiteCooldownTracker();

/** Sleep for the cooldown duration this site currently warrants. */
export async function waitSiteCooldown(url: string): Promise<void> {
  const ms = siteCooldown.getCooldownMs(url);
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
  siteCooldown.recordCheck(url);
}

// ─── Session cache (nonce / cookies / publishable key reuse) ────────────────
// NOTE: scaffold for a future optimization. The checker doesn't yet call
// saveSession() between runs, so the store stays empty and the UI panel
// always renders "No active sessions". When we wire it up, every successful
// checkout should call saveSession(url, ...) with the cookies + extracted
// pk/acct/nonces so the next attempt on the same host can skip the
// page-scrape step entirely. Until then these exports are kept so the
// future wiring lands as a no-API-change patch.
export interface CachedSession {
  cookies: string;
  publicKey?: string;
  connectedAccount?: string;
  nonces: Record<string, string>; // arbitrary nonce/csrf bag keyed by purpose
  proxy?: string;
  ua?: string;
  secChUa?: string;
  savedAt: number;
}

const SESSION_TTL_MS = 5 * 60_000;
const sessionStore = new Map<string, CachedSession>();

export function getCachedSession(url: string): CachedSession | null {
  const entry = sessionStore.get(siteKey(url));
  if (!entry) return null;
  if (Date.now() - entry.savedAt > SESSION_TTL_MS) {
    sessionStore.delete(siteKey(url));
    return null;
  }
  return entry;
}

export function saveSession(url: string, sess: Omit<CachedSession, "savedAt">): void {
  sessionStore.set(siteKey(url), { ...sess, savedAt: Date.now() });
}

export function invalidateSession(url: string): void {
  sessionStore.delete(siteKey(url));
}

/** Snapshot every cached session for the UI panel. Drops expired entries first. */
export function listCachedSessions(): Array<{ hostname: string; ageSeconds: number; hasPublicKey: boolean; hasConnectedAccount: boolean; nonceCount: number; hasProxy: boolean }> {
  const now = Date.now();
  const out: ReturnType<typeof listCachedSessions> = [];
  for (const [hostname, sess] of sessionStore) {
    if (now - sess.savedAt > SESSION_TTL_MS) {
      sessionStore.delete(hostname);
      continue;
    }
    out.push({
      hostname,
      ageSeconds: Math.round((now - sess.savedAt) / 1000),
      hasPublicKey: !!sess.publicKey,
      hasConnectedAccount: !!sess.connectedAccount,
      nonceCount: Object.keys(sess.nonces || {}).length,
      hasProxy: !!sess.proxy,
    });
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

export function clearAllSessions(): number {
  const count = sessionStore.size;
  sessionStore.clear();
  return count;
}

/** Snapshot all cooldown-tracked sites for the UI. */
export function listCooldownSites(): Array<{ hostname: string; checks10min: number; blocks: number; lastCheck: number | null }> {
  return siteCooldown.trackedHostnames()
    .map(hostname => ({ hostname, ...siteCooldown.getStats(`https://${hostname}`) }))
    .sort((a, b) => b.checks10min - a.checks10min);
}
