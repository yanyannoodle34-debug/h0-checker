/**
 * Sensitive-data masking for outbound Telegram / dashboard renders.
 *
 * When the operator turns on the mask (per-user via /maskcc, globally via the
 * dashboard), live-card responses still surface the *outcome* (LIVE/CCN/3DS,
 * decline reason, address, bank) but redact:
 *   - the PAN body (first 6 + last 4 only — BIN+last4 is industry standard)
 *   - the CVV (always masked when masking is on)
 *   - Stripe charge ids (ch_…)
 *   - Stripe intent ids  (pi_…, seti_…)
 *
 * Pure: no IO, no fetch. Caller decides when to apply.
 */

/** Mask a full card line `4111111111111111|12|26|123` →
 *  `411111******1111|12|26|***`. Preserves the pipe layout so it still
 *  round-trips through anything that splits on "|". Tolerant of bare PANs and
 *  short / malformed strings. */
export function maskCardLine(line: string): string {
  if (!line) return line;
  const parts = line.split("|");
  parts[0] = maskPan(parts[0]);
  // CVV is the 4th segment when present; mask it to the right length.
  if (parts.length >= 4 && parts[3]) {
    parts[3] = "*".repeat(Math.max(3, parts[3].length));
  }
  return parts.join("|");
}

/** Bare-PAN mask: keep first 6 + last 4. Anything shorter than 10 chars is
 *  returned untouched (already not a real PAN). */
export function maskPan(panOrCard: string): string {
  const digits = (panOrCard || "").replace(/\D/g, "");
  if (digits.length < 10) return panOrCard;
  return digits.slice(0, 6) + "*".repeat(digits.length - 10) + digits.slice(-4);
}

/** Stripe charge id → `ch_***last4`. Empty / non-charge ids returned as-is. */
export function maskChargeId(id: string): string {
  if (!id || !/^ch_/.test(id)) return id;
  if (id.length <= 8) return id;
  return `ch_***${id.slice(-4)}`;
}

/** Stripe intent id (pi_ or seti_) → `pi_***last4`. */
export function maskIntentId(id: string): string {
  if (!id) return id;
  if (/^pi_/.test(id))   return id.length > 8 ? `pi_***${id.slice(-4)}`   : id;
  if (/^seti_/.test(id)) return id.length > 10 ? `seti_***${id.slice(-4)}` : id;
  return id;
}
