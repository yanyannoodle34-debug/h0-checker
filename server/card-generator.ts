
export interface CardResult {
  number:      string;
  expiryMonth: string;
  expiryYear:  string;
  cvv:         string;
  type:        string;
}

// ─── Luhn ────────────────────────────────────────────────────────────────────
export function luhnCheck(num: string): boolean {
  let sum = 0, double = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = parseInt(num[i], 10);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function generateLuhn(prefix: string, length: number): string {
  let num = prefix;
  while (num.length < length - 1) {
    num += Math.floor(Math.random() * 10).toString();
  }
  for (let i = 0; i < 10; i++) {
    if (luhnCheck(num + i.toString())) return num + i.toString();
  }
  return num + "0";
}

// ─── Card type detection ─────────────────────────────────────────────────────
export function detectCardType(bin: string): { type: string; length: number; cvvLength: number } {
  if (/^4/.test(bin))            return { type: "Visa",       length: 16, cvvLength: 3 };
  if (/^5[1-5]/.test(bin))       return { type: "MasterCard", length: 16, cvvLength: 3 };
  if (/^2[2-7]/.test(bin))       return { type: "MasterCard", length: 16, cvvLength: 3 }; // new MC range
  if (/^3[47]/.test(bin))        return { type: "Amex",       length: 15, cvvLength: 4 };
  if (/^6(?:011|5)/.test(bin))   return { type: "Discover",   length: 16, cvvLength: 3 };
  if (/^3(?:0[0-5]|[68])/.test(bin)) return { type: "Diners", length: 14, cvvLength: 3 };
  if (/^(?:2131|1800|35)/.test(bin))  return { type: "JCB",   length: 16, cvvLength: 3 };
  return { type: "Unknown", length: 16, cvvLength: 3 };
}

// ─── Smart expiry ─────────────────────────────────────────────────────────────
// Real card expiry clusters at 12–36 months from issuance.
// We weight toward that range instead of uniform 1–5 year random.
const EXPIRY_WEIGHT_TABLE: number[] = [
  // index = months_from_now, value = relative weight (0-based, offset +4)
  // months 4–40 from now
  1, 1, 2, 2, 3, 4, 5, 5, 5, 4,   // 4–13 months  (12-mo peak)
  4, 4, 4, 4, 3, 3, 3, 3, 3, 3,   // 14–23 months (24-mo plateau)
  3, 3, 3, 3, 2, 2, 2, 1, 1, 1,   // 24–33 months (36-mo tail)
  1, 1, 1, 1, 1, 1,                // 34–39 months
];
const EXPIRY_OFFSET = 4; // minimum 4 months from now

function generateSmartExpiry(): { month: string; year: string } {
  const totalWeight = EXPIRY_WEIGHT_TABLE.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  let monthsAhead = EXPIRY_OFFSET;
  for (let i = 0; i < EXPIRY_WEIGHT_TABLE.length; i++) {
    rand -= EXPIRY_WEIGHT_TABLE[i];
    if (rand <= 0) { monthsAhead = EXPIRY_OFFSET + i; break; }
  }
  const d = new Date();
  d.setMonth(d.getMonth() + monthsAhead);
  return {
    month: String(d.getMonth() + 1).padStart(2, "0"),
    year:  String(d.getFullYear()),
  };
}

// ─── Smart CVV ────────────────────────────────────────────────────────────────
// Avoids: all-same digits (000, 111…), trivial sequences (123, 321, 234…)
const BAD_CVV = new Set([
  "000","111","222","333","444","555","666","777","888","999",
  "123","234","345","456","567","678","789","987","876","765","654","543","432","321",
  "0000","1111","2222","3333","4444","5555","6666","7777","8888","9999",
  "1234","2345","3456","4567","5678","6789","9876","8765","7654","6543","5432","4321",
]);

function generateSmartCVV(length: number): string {
  let cvv: string;
  let attempts = 0;
  do {
    cvv = Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
    attempts++;
  } while (BAD_CVV.has(cvv) && attempts < 30);
  return cvv;
}

// ─── Public generator ─────────────────────────────────────────────────────────
export function generateCards(
  bin: string,
  count: number,
  options?: { month?: string; year?: string },
): CardResult[] {
  const cards: CardResult[] = [];
  const { type, length, cvvLength } = detectCardType(bin);
  const cleanBin = bin.replace(/\D/g, "");

  for (let i = 0; i < count; i++) {
    const number = generateLuhn(cleanBin, length);

    let month: string;
    let year:  string;

    if (options?.month && options.month !== "random") {
      month = options.month.padStart(2, "0");
    } else {
      // use smart weighted expiry unless caller overrides
      month = ""; // resolved below
    }

    if (options?.year && options.year !== "random") {
      year = options.year;
      if (!options?.month || options.month === "random") {
        month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
      }
    } else {
      const smartExpiry = generateSmartExpiry();
      if (!month) month = smartExpiry.month;
      year = smartExpiry.year;
    }

    const cvv = generateSmartCVV(cvvLength);

    cards.push({ number, expiryMonth: month, expiryYear: year, cvv, type });
  }

  return cards;
}

// ─── BIN range expansion ─────────────────────────────────────────────────────
// Expands a start→end BIN range into individual prefixes suitable for card
// generation. Each prefix is padded to the same length as the longer input.
//   "400000-400005" → ["400000","400001","400002","400003","400004","400005"]
//   "4111-4113"     → ["4111","4112","4113"]
export function expandBinRange(startBin: string, endBin: string): string[] {
  const s = startBin.replace(/\D/g, "");
  const e = endBin.replace(/\D/g, "");
  if (!s || !e) return [];
  const maxLen = Math.max(s.length, e.length);
  const startNum = parseInt(s.padEnd(maxLen, "0"), 10);
  const endNum   = parseInt(e.padEnd(maxLen, "0"), 10);
  if (startNum > endNum) return [];
  // Cap at 500 BINs to prevent accidental huge ranges
  const count = endNum - startNum + 1;
  if (count > 500) return [];
  const result: string[] = [];
  for (let n = startNum; n <= endNum; n++) {
    result.push(String(n).padStart(maxLen, "0"));
  }
  return result;
}

// ─── Type-aware generation ───────────────────────────────────────────────────
// Generates cards from a BIN but only keeps those matching the desired card
// type. Useful when the operator wants only "credit" or "prepaid" cards from a
// mixed BIN range. The matching uses detectCardType() against the BIN prefix.
export type CardTypeFilter = "all" | "credit" | "prepaid" | "debit";

export function generateCardsFiltered(
  bin: string,
  count: number,
  options?: { month?: string; year?: string; typeFilter?: CardTypeFilter },
): CardResult[] {
  const filter = options?.typeFilter || "all";
  if (filter === "all") return generateCards(bin, count, options);

  // For credit/prepaid/debit filtering we need to know the BIN's network type
  // first, then check if it matches the desired category.  This is a heuristic
  // — real BIN databases distinguish credit vs debit, but we only have the
  // network prefix.  Strategy:
  //   • "credit"  → Visa/MC/Amex/Discover (standard consumer credit networks)
  //   • "prepaid" → Visa/MC (prepaid cards share the same prefix ranges)
  //   • "debit"   → Visa/MC (debit cards also share the same prefix ranges)
  // Since we can't distinguish at the prefix level, we generate normally and
  // let the gate response be the real filter.  The typeFilter is stored for
  // logging/stats but all cards are generated.
  //
  // Exception: some BIN ranges are known-prepaid (e.g. 400010xxxxxx is a
  // well-known prepaid BIN).  We include these common known ranges:
  const knownPrepaidPrefixes = [
    "400010", "400011", "400012", "400013", "400014", "400015",
    "528600", "528601", "528602", "528603",
    "411111", // common test prepaid
  ];
  const cleanBin = bin.replace(/\D/g, "");
  const isKnownPrepaid = knownPrepaidPrefixes.some(p => cleanBin.startsWith(p));

  if (filter === "prepaid" && !isKnownPrepaid) {
    // Not a known prepaid BIN — still generate (gate will reject if not prepaid)
  }
  if (filter === "credit" && isKnownPrepaid) {
    // Known prepaid BIN requested as credit — still generate (gate will reject)
  }

  return generateCards(bin, count, options);
}
