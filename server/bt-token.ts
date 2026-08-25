/**
 * Standalone Braintree client-token decoder.
 *
 * Extracted from braintree-checker so it can be unit-tested without dragging
 * the whole DB/storage import graph along. Pure: no fetch, no IO, no fs.
 *
 * BT client tokens are base64(JSON). In transit they pick up four common
 * mutations that the naïve decoder couldn't handle:
 *   1. URL-encoded "=" / "+" / "/" — `decodeURIComponent` fixes this.
 *   2. JSON-escaped slashes ("\/") — string replace.
 *   3. Unicode-escaped padding ("=" for "=", etc.) — string replace.
 *   4. Stripped trailing padding ("=" removed) — base64 length-pad.
 *
 * Some newer BT tokens are also wrapped: `{ data: "<inner base64 token>" }`.
 * One level of unwrapping is handled.
 *
 * The decoder returns step-by-step error names so the caller can show the
 * operator *which* step failed instead of a generic "decode failed".
 */

export type BtDecode =
  | { ok: true; authFingerprint: string; merchantId: string; clientApiUrl?: string }
  | { ok: false; error: "empty" | "not_base64" | "not_json" | "no_auth_fingerprint" };

export function decodeBtTokenStrict(raw: string): BtDecode {
  if (!raw || typeof raw !== "string") return { ok: false, error: "empty" };

  const trimmed = raw.trim();
  const urlDecoded = (() => { try { return decodeURIComponent(trimmed); } catch { return trimmed; } })();
  const unescaped  = urlDecoded
    .replace(/\\u003[Dd]/g, "=")
    .replace(/\\u002[Ff]/g, "/")
    .replace(/\\u002[Bb]/g, "+")
    .replace(/\\\//g, "/");
  const candidates = [trimmed, urlDecoded, unescaped];

  let lastBase64Ok = false;
  for (const candidate of candidates) {
    const base64Like = /^[A-Za-z0-9+/]+={0,2}$/.test(candidate);
    if (!base64Like) continue;
    const padded = candidate + "=".repeat((4 - (candidate.length % 4)) % 4);
    let buf: Buffer;
    try { buf = Buffer.from(padded, "base64"); } catch { continue; }
    if (buf.length < 8) continue;
    lastBase64Ok = true;
    let text: string;
    try { text = buf.toString("utf-8"); } catch { continue; }
    let json: any;
    try { json = JSON.parse(text); } catch { continue; }

    // One level of envelope unwrap: { data: "<inner base64>" }.
    if (json && typeof json === "object" && typeof json.data === "string" && !json.authorizationFingerprint) {
      const inner = decodeBtTokenStrict(json.data);
      if (inner.ok) return inner;
    }

    const authFingerprint: string = json?.authorizationFingerprint || "";
    const merchantId: string = json?.merchantId || "";
    const clientApiUrl: string | undefined = typeof json?.clientApiUrl === "string" ? json.clientApiUrl : undefined;
    if (!authFingerprint) return { ok: false, error: "no_auth_fingerprint" };
    return { ok: true, authFingerprint, merchantId, clientApiUrl };
  }
  return { ok: false, error: lastBase64Ok ? "not_json" : "not_base64" };
}
