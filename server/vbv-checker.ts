/**
 * VBV / 3DS pre-check.
 *
 * Goal: cheaply estimate a card's 3DS disposition BEFORE spending 15–25s on a
 * full gate flow, so the operator can route to a matching gate (and skip a
 * known hard-decline rather than burn the card with an extra auth attempt).
 *
 * History: the reference bot (Riva.py) called a single hardcoded third-party
 * service (http://72.62.16.52:8000) that has since gone dark. There is no
 * reliable free public "VBV checker" to drop in as a replacement — they appear
 * and disappear constantly — so this module no longer ships a baked-in
 * endpoint. Instead it offers two independent signals:
 *
 *   1. External endpoint (opt-in, bring-your-own): if the operator configures a
 *      working VBV service (env VBV_CHECK_ENDPOINT or per-gate vbvEndpoint),
 *      vbvCheck() queries it (GET {endpoint}?data={cc}&mode=3ds) and maps the
 *      verdict to passed/otp/declined. A "declined" verdict can short-circuit
 *      the gate. When no endpoint is configured this path is simply disabled.
 *
 *   2. BIN 3DS heuristic (built-in, no network beyond the BIN lookup we already
 *      do): infers 3DS likelihood from the issuing country. EEA + UK + a few
 *      others mandate Strong Customer Authentication (PSD2/SCA) so issuers there
 *      almost always force 3DS; the US/CA and most of the rest lean
 *      frictionless. This is a *routing hint only* — a BIN can never truthfully
 *      say a specific card is "declined", so it never auto-skips.
 *
 * Every failure path resolves cleanly (status "error" / likelihood "unknown") —
 * an unavailable service must never block or false-decline a real check.
 */

/** Bring-your-own external VBV endpoint. Empty by default — the old hardcoded
 *  IP is dead, so the endpoint path stays disabled unless the operator sets
 *  env VBV_CHECK_ENDPOINT or a per-gate vbvEndpoint. */
export const VBV_ENDPOINT = process.env.VBV_CHECK_ENDPOINT?.trim() || "";

export type VbvStatus = "passed" | "otp" | "declined" | "error";

export interface VbvResult {
  /** Canonical lowercase outcome. "error" = inconclusive (no endpoint / down / bad shape). */
  status: VbvStatus;
  /** Human-readable detail from the service, or the failure reason on error. */
  response: string;
  /** Round-trip latency in ms. */
  latency: number;
  /** Truncated raw body for debugging (≤512 chars). */
  raw?: string;
}

export interface VbvOptions {
  /** Override the service endpoint (per-gate `vbvEndpoint`). Falls back to env. */
  endpoint?: string;
  /** Abort the request after this many ms (default 12000). */
  timeout?: number;
  /** `mode` query param — defaults to "3ds". */
  mode?: string;
}

/** Map a VBV service's free-form `status` string to our canonical enum. Pure —
 *  factored out so it can be unit-tested without touching the network. Anything
 *  unrecognized maps to "error" (inconclusive), never a false decline. */
export function mapVbvStatus(raw: unknown): VbvStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "passed" || s === "pass" || s === "approved" || s === "live") return "passed";
  if (s === "otp" || s === "3ds" || s === "enrolled" || s === "challenge") return "otp";
  if (s === "declined" || s === "decline" || s === "dead" || s === "failed") return "declined";
  return "error";
}

/**
 * Query an external VBV/3DS service for a single card. Disabled (returns
 * "error") when no endpoint is configured.
 *
 * @param cardStr  "PAN|MM|YY|CVC" (already-normalized by parseCardInput).
 * @returns Always resolves; missing endpoint / network / parse failures → "error".
 */
export async function vbvCheck(cardStr: string, opts: VbvOptions = {}): Promise<VbvResult> {
  const start = Date.now();
  const endpoint = (opts.endpoint || VBV_ENDPOINT).trim().replace(/\/+$/, "");
  if (!endpoint) {
    return { status: "error", response: "no VBV endpoint configured", latency: 0 };
  }
  const mode = opts.mode || "3ds";
  const timeout = opts.timeout && opts.timeout > 0 ? opts.timeout : 12000;

  const url = `${endpoint}?data=${encodeURIComponent(cardStr)}&mode=${encodeURIComponent(mode)}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    const body = await resp.text();
    const raw = body.slice(0, 512);

    if (!resp.ok) {
      return { status: "error", response: `VBV service HTTP ${resp.status}`, latency: Date.now() - start, raw };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: "error", response: "VBV service returned non-JSON", latency: Date.now() - start, raw };
    }

    const status = mapVbvStatus(parsed?.status);
    const response = String(parsed?.response || parsed?.message || parsed?.status || "").slice(0, 200) || status;
    return { status, response, latency: Date.now() - start, raw };
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? `VBV timeout after ${timeout}ms` : `VBV error: ${e?.message || e}`;
    return { status: "error", response: reason, latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ─── BIN-based 3DS heuristic (no external dependency) ────────────────────────

/** Countries that enforce Strong Customer Authentication, so issuers there
 *  almost always require a 3DS challenge:
 *   - EEA (EU 27 + Iceland, Liechtenstein, Norway) under PSD2/SCA
 *   - United Kingdom (UK SCA, post-Brexit equivalent)
 *   - India (RBI mandates 3DS / additional-factor auth on card-not-present)
 *  ISO-3166 alpha-2. */
const SCA_COUNTRIES = new Set([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
  // EEA non-EU
  "IS", "LI", "NO",
  // UK + India
  "GB", "IN",
]);

export type ThreeDsLikelihood = "likely_3ds" | "likely_frictionless" | "unknown";

/**
 * Estimate 3DS likelihood from BIN data. Pure & synchronous — feed it the
 * BinInfo we already fetch. Returns a routing hint only; it never claims a
 * card is declined.
 */
export function binThreeDsHeuristic(
  info: { country?: string; level?: string; type?: string } | null | undefined,
): { likelihood: ThreeDsLikelihood; reason: string } {
  const country = (info?.country || "").toUpperCase();
  if (!country) return { likelihood: "unknown", reason: "no issuer country" };

  if (SCA_COUNTRIES.has(country)) {
    // Commercial/corporate cards are sometimes SCA-exempt, but we can't be sure
    // from the BIN alone — still flag as likely 3DS so the operator routes safe.
    return { likelihood: "likely_3ds", reason: `${country} enforces SCA` };
  }
  // US/CA and most other regions lean frictionless for card-not-present.
  return { likelihood: "likely_frictionless", reason: `${country} typically frictionless` };
}
