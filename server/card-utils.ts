/**
 * Card Utilities - Luhn validation, brand detection, parsing.
 */
export interface ParsedCard {
  number: string;
  month: string;
  year: string;
  cvv: string;
  valid: boolean;
  brand: string;
  error?: string;
}

/**
 * Luhn algorithm validation (mod 10).
 * Returns true if the card number passes the checksum.
 */
export function luhnCheck(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, "").split("").map(Number);
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits[i];
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Detect card brand from BIN/number.
 */
export function detectCardBrand(cardNumber: string): string {
  const num = cardNumber.replace(/\D/g, "");

  if (/^4/.test(num)) return "visa";
  if (/^5[1-5]/.test(num)) return "mastercard";
  if (/^22[2-9]/.test(num) || /^2[3-6]/.test(num) || /^27[01]/.test(num) || /^2720/.test(num)) return "mastercard"; // 2-series
  if (/^3[47]/.test(num)) return "amex";
  if (/^6(?:011|5|4[4-9])/.test(num)) return "discover";
  if (/^3(?:0[0-5]|[68])/.test(num)) return "diners";
  if (/^35/.test(num)) return "jcb";
  if (/^62/.test(num)) return "unionpay";

  return "unknown";
}

/**
 * Get card funding type from brand.
 */
export function getCardFunding(brand: string): string {
  switch (brand) {
    case "visa":
    case "mastercard":
    case "discover":
    case "unionpay":
      return "CREDIT";
    case "amex":
      return "CREDIT";
    case "diners":
    case "jcb":
      return "CREDIT";
    default:
      return "UNKNOWN";
  }
}

/**
 * Parse card string in format: number|month|year|cvv
 * Validates format and runs Luhn check.
 */
export function parseCardString(cardStr: string): ParsedCard {
  const parts = cardStr.trim().split("|");

  if (parts.length < 4) {
    return {
      number: "",
      month: "",
      year: "",
      cvv: "",
      valid: false,
      brand: "unknown",
      error: "Invalid format: expected number|month|year|cvv",
    };
  }

  const [number, month, year, cvv] = parts;
  const cleanNumber = number.replace(/\s+/g, "");
  const cleanMonth = month.padStart(2, "0");
  let cleanYear = year;

  // Normalize year to 4 digits
  if (cleanYear.length === 2) {
    cleanYear = "20" + cleanYear;
  }

  const brand = detectCardBrand(cleanNumber);
  const luhnValid = luhnCheck(cleanNumber);

  return {
    number: cleanNumber,
    month: cleanMonth,
    year: cleanYear,
    cvv: cvv.trim(),
    valid: luhnValid && cleanNumber.length >= 13 && cleanNumber.length <= 19,
    brand,
    error: luhnValid ? undefined : "Failed Luhn check",
  };
}

/**
 * Format card for display (masked).
 */
export function maskCardNumber(cardNumber: string): string {
  const clean = cardNumber.replace(/\D/g, "");
  if (clean.length < 8) return clean;
  return `${clean.slice(0, 6)}${'*'.repeat(clean.length - 10)}${clean.slice(-4)}`;
}

/**
 * Format expiry for display.
 */
export function formatExpiry(month: string, year: string): string {
  return `${month.padStart(2, "0")}/${year.slice(-2)}`;
}

/**
 * Check if card is expired.
 */
export function isCardExpired(month: string, year: string): boolean {
  const now = new Date();
  const expMonth = parseInt(month, 10);
  const expYear = year.length === 2 ? 2000 + parseInt(year, 10) : parseInt(year, 10);

  if (expYear < now.getFullYear()) return true;
  if (expYear === now.getFullYear() && expMonth < now.getMonth() + 1) return true;
  return false;
}