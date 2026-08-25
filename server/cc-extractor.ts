/**
 * Extract credit-card data from messy text — emails, logs, screenshots
 * (after OCR), gist dumps, etc.
 *
 * extractCards(text)   → array of "PAN|MM|YY|CVV" strings, Luhn-validated,
 *                        de-duplicated. Recognizes expiry/CVV when present.
 * extractBins(text)    → array of unique 6-digit BIN prefixes from any valid
 *                        PAN found, regardless of whether expiry/CVV exists.
 *
 * Pure utility module — no DB, no fetch, no side effects.
 */

/** Strip everything that isn't a digit, then test Luhn. */
function luhn(s: string): boolean {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = parseInt(s[i], 10);
    if (Number.isNaN(n)) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum > 0 && sum % 10 === 0;
}

/** Find every 13–19 digit sequence in the text and Luhn-validate.
 *  Allows spaces/dashes inside the candidate (4111 1111 1111 1111). */
function findPans(text: string): string[] {
  const out = new Set<string>();
  // The PAN regex tolerates one space or dash between digit groups; we strip
  // them before validating. Anchored on word boundaries so a 20-digit
  // transaction id doesn't sneak in.
  const re = /\b(?:\d[ -]?){12,18}\d\b/g;
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      out.add(digits);
    }
  }
  return [...out];
}

interface Expiry { month: string; year: string; }

/** Look for MM/YY, MM/YYYY, MM-YY, MM|YY etc. within a window around the PAN. */
function findExpiryNear(text: string, panEnd: number): Expiry | null {
  const window = text.slice(panEnd, panEnd + 80);
  // Common shapes: 12/26, 12/2026, 12-26, 12|26, exp: 12/26, expiry 12/2026
  const m = window.match(/(?:exp(?:iry|ires?)?[:\s]*)?\b(0?[1-9]|1[0-2])[\s|/.\-]\s*(\d{2}|\d{4})\b/i);
  if (!m) return null;
  const mm = m[1].padStart(2, "0");
  const yy = m[2].length === 4 ? m[2].slice(2) : m[2];
  return { month: mm, year: yy };
}

/** CVV right after the expiry, or in a CVV/CVC labelled position. */
function findCvvNear(text: string, expiryEnd: number, panLength: number): string | null {
  const window = text.slice(expiryEnd, expiryEnd + 60);
  const labelled = window.match(/cv[cv]2?[:\s]*(\d{3,4})/i);
  if (labelled) return labelled[1];
  // Loose: a 3- or 4-digit number floating near the expiry
  const loose = window.match(/\b(\d{3,4})\b/);
  if (loose) {
    const v = loose[1];
    // AMEX (15-digit) wants 4-digit CVV; everyone else wants 3
    if (panLength === 15 && v.length === 4) return v;
    if (panLength !== 15 && v.length === 3) return v;
  }
  return null;
}

export function extractCards(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /\b(?:\d[ -]?){12,18}\d\b/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const digits = raw.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue;
    const panEnd = (m.index ?? 0) + raw.length;
    const expiry = findExpiryNear(text, panEnd);
    if (!expiry) {
      out.add(digits); // bare PAN — caller can still use the BIN
      continue;
    }
    // Re-locate expiry end so CVV search starts after it
    const expMatch = text.slice(panEnd).match(/(?:exp(?:iry|ires?)?[:\s]*)?\b(0?[1-9]|1[0-2])[\s|/.\-]\s*(\d{2}|\d{4})\b/i);
    const expiryEnd = expMatch ? panEnd + (expMatch.index ?? 0) + expMatch[0].length : panEnd;
    const cvv = findCvvNear(text, expiryEnd, digits.length);
    if (cvv) {
      out.add(`${digits}|${expiry.month}|${expiry.year}|${cvv}`);
    } else {
      // Expiry but no CVV — still emit, callers can decide what to do
      out.add(`${digits}|${expiry.month}|${expiry.year}|`);
    }
  }
  return [...out];
}

export function extractBins(text: string, length: 6 | 8 = 6): string[] {
  const pans = findPans(text);
  const set = new Set<string>();
  for (const p of pans) set.add(p.slice(0, length));
  return [...set];
}

export function summarizeExtraction(cards: string[]) {
  // Shapes emitted by extractCards():
  //   "PAN"                    bare PAN, no expiry / CVV found
  //   "PAN|MM|YY|"             expiry found, CVV missing (trailing pipe)
  //   "PAN|MM|YY|CVV"          full card
  const withCvv = cards.filter(c => {
    const parts = c.split("|");
    return parts.length === 4 && !!parts[3];
  }).length;
  const withExpiryOnly = cards.filter(c => {
    const parts = c.split("|");
    return parts.length === 4 && !parts[3];
  }).length;
  const bareBins = cards.filter(c => !c.includes("|")).length;
  return { total: cards.length, withCvv, withExpiryOnly, bareBins };
}
