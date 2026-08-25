/**
 * Form Parser - Robust HTML form extraction using cheerio.
 * Replaces fragile regex-based parsing with DOM-aware extraction.
 */
import { load } from "cheerio";

/**
 * Safely get a string value from cheerio element (handles string | string[]).
 */
function getVal($el: any): string {
  const val = $el.val();
  if (Array.isArray(val)) return val[0] || "";
  return val || "";
}

export interface GiveWPFormData {
  formHash: string;
  formIdPrefix: string;
  formId: string;
  formTitle: string;
  minimumAmount: string;
  maximumAmount: string;
  clientToken: string;
  actionUrl: string;
}

export interface WooCommerceFormData {
  ppcNonce: string;
  wcAjaxUrl: string;
}

export interface FormParseResult {
  type: "givewp" | "woocommerce" | "unknown";
  data: GiveWPFormData | WooCommerceFormData | null;
  rawHtml: string;
}

/**
 * Parse GiveWP PayPal Commerce donation form.
 * Extracts all fields needed for the create_order → confirm → approve flow.
 */
export function parseGiveWPForm(html: string, baseUrl: string): GiveWPFormData {
  const $ = load(html);

  // Multiple selector strategies for resilience
  const formHash =
    getVal($('input[name="give-form-hash"]')) ||
    getVal($('input[name="give_form_hash"]')) ||
    $('[data-give-form-hash]').attr("data-give-form-hash") ||
    "";

  const formIdPrefix =
    getVal($('input[name="give-form-id-prefix"]')) ||
    getVal($('input[name="give_form_id_prefix"]')) ||
    "";

  const formId =
    getVal($('input[name="give-form-id"]')) ||
    getVal($('input[name="give_form_id"]')) ||
    $('[data-give-form-id]').attr("data-give-form-id") ||
    "";

  const formTitle =
    getVal($('input[name="give-form-title"]')) ||
    getVal($('input[name="give_form_title"]')) ||
    "Donation Form";

  const minimumAmount =
    getVal($('input[name="give-form-minimum"]')) ||
    getVal($('input[name="give_form_minimum"]')) ||
    $('[data-minimum-amount]').attr("data-minimum-amount") ||
    "1.00";

  const maximumAmount =
    getVal($('input[name="give-form-maximum"]')) ||
    getVal($('input[name="give_form_maximum"]')) ||
    "10000.00";

  // Extract client token from various locations
  let clientToken = "";
  const scriptContent = $("script").text();

  // Pattern 1: data-client-token attribute
  const tokenMatch = scriptContent.match(/"data-client-token"\s*:\s*"([^"]+)"/);
  if (tokenMatch) clientToken = tokenMatch[1];

  // Pattern 2: data-client-token in HTML attribute
  if (!clientToken) {
    const attrMatch = scriptContent.match(/data-client-token=["']([^"']+)["']/);
    if (attrMatch) clientToken = attrMatch[1];
  }

  // Pattern 3: Look for base64 encoded token in page
  if (!clientToken) {
    const base64Match = scriptContent.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (base64Match) clientToken = base64Match[0];
  }

  const cleanBase = baseUrl.replace(/\/+$/, "");
  return {
    formHash,
    formIdPrefix,
    formId,
    formTitle,
    minimumAmount,
    maximumAmount,
    clientToken,
    actionUrl: `${cleanBase}/wp-admin/admin-ajax.php`,
  };
}

/**
 * Parse WooCommerce PPCP (PayPal Payments) form.
 */
export function parseWooCommerceForm(html: string, baseUrl: string): WooCommerceFormData {
  const $ = load(html);

  const ppcNonce =
    getVal($('input[name="ppc_nonce"]')) ||
    getVal($('input[name="woocommerce-process-checkout-nonce"]')) ||
    $('[data-ppc-nonce]').attr("data-ppc-nonce") ||
    "";

  const cleanBase = baseUrl.replace(/\/+$/, "");
  return {
    ppcNonce,
    wcAjaxUrl: `${cleanBase}/?wc-ajax=ppc_create_order`,
  };
}

/**
 * Auto-detect form type and parse accordingly.
 */
export function parseFormAuto(html: string, baseUrl: string): FormParseResult {
  const $ = load(html);
  const scriptContent = $("script").text();

  // Check for GiveWP markers
  const hasGiveWP =
    $('input[name="give-form-hash"]').length > 0 ||
    $('input[name="give_form_hash"]').length > 0 ||
    scriptContent.includes("give-form-hash") ||
    scriptContent.includes('data-client-token');

  if (hasGiveWP) {
    return {
      type: "givewp",
      data: parseGiveWPForm(html, baseUrl),
      rawHtml: html,
    };
  }

  // Check for WooCommerce PPCP markers
  const hasPPCP =
    $('input[name="ppc_nonce"]').length > 0 ||
    html.includes("ppc_nonce") ||
    html.includes("ppc_create_order");

  if (hasPPCP) {
    return {
      type: "woocommerce",
      data: parseWooCommerceForm(html, baseUrl),
      rawHtml: html,
    };
  }

  return { type: "unknown", data: null, rawHtml: html };
}