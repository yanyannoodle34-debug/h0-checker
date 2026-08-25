/**
 * Shared helpers for "auto-generate a gate name from a URL".
 *
 * Before this module existed the `${TYPE}-${DOMAIN}` pattern was open-coded
 * in 7 different sites (5 in telegram-bot.ts, 2 in routes.ts), each with
 * subtly different fallback behavior on URL parse failure. Centralising it
 * here ensures the dashboard and the Telegram bot produce identical names
 * for the same site — and gives one place to change the convention later
 * (e.g. add a date suffix, strip ports, append country code).
 */

/** Extract the human-readable hostname from a URL. Strips `www.`, returns
 *  a fallback string ("—" by default) when the URL is unparseable. Used
 *  for *display* (breadcrumbs, previews) — not as a stable identifier. */
export function safeHostname(url: string | undefined, fallback = "—"): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Best-effort regex fallback for inputs like "shop.example.com" (no protocol)
    const m = url.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
    return m?.[1]?.replace(/^www\./, "") || fallback;
  }
}

/** Auto-generate a gate name of the form `${GATETYPE}-${SHORTDOMAIN}` —
 *  the short domain is just the first label of the hostname, uppercased
 *  (so `shop.example.co.uk` becomes `SHOP`). On any parse failure, falls
 *  back to `${GATETYPE}-GATE`. Used everywhere a gate is created from a
 *  URL without an explicit user-provided name. */
export function autoGateName(gateType: string | undefined, url: string | undefined): string {
  const type = (gateType || "GATE").toUpperCase();
  const host = safeHostname(url, "");
  const short = host ? host.split(".")[0].toUpperCase() : "GATE";
  return `${type}-${short || "GATE"}`;
}
