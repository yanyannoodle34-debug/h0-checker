/**
 * FormData Helpers - Clean multipart/form-data construction using form-data package.
 * Replaces manual boundary string concatenation.
 */
import FormData from "form-data";

export interface GiveWPCreateOrderParams {
  formIdPrefix: string;
  formId: string;
  formTitle: string;
  siteUrl: string;
  formHash: string;
  minimumAmount: string;
  maximumAmount: string;
  amount: string;
  firstName: string;
  lastName: string;
  email: string;
  billing: {
    line1: string;
    city: string;
    stateCode: string;
    zip: string;
    country: string;
  };
}

export interface GiveWPApproveOrderParams extends GiveWPCreateOrderParams {
  orderId: string;
}

/**
 * Build multipart body for GiveWP create_order request.
 */
export function buildGiveWPCreateOrderBody(params: GiveWPCreateOrderParams): FormData {
  const form = new FormData();

  form.append("give-honeypot", "");
  form.append("give-form-id-prefix", params.formIdPrefix);
  form.append("give-form-id", params.formId);
  form.append("give-form-title", params.formTitle);
  form.append("give-current-url", params.siteUrl);
  form.append("give-form-url", params.siteUrl);
  form.append("give-form-minimum", params.minimumAmount);
  form.append("give-form-maximum", params.maximumAmount);
  form.append("give-form-hash", params.formHash);
  form.append("give-price-id", "0");
  form.append("give-amount", params.amount);
  form.append("give_first", params.firstName);
  form.append("give_last", params.lastName);
  form.append("give_email", params.email);
  form.append("give_comment", "");
  form.append("payment-mode", "paypal-commerce");
  form.append("card_name", `${params.firstName} ${params.lastName}`);
  form.append("billing_country", params.billing.country);
  form.append("card_address", params.billing.line1);
  form.append("card_city", params.billing.city);
  form.append("card_state", params.billing.stateCode);
  form.append("card_zip", params.billing.zip);
  form.append("give-gateway", "paypal-commerce");
  form.append("give_embed_form", "1");

  return form;
}

/**
 * Build multipart body for GiveWP approve_order request.
 * Reuses the same fields as create_order.
 */
export function buildGiveWPApproveOrderBody(params: GiveWPApproveOrderParams): FormData {
  return buildGiveWPCreateOrderBody(params);
}

/**
 * Get headers from FormData for fetch requests.
 */
export function getFormDataHeaders(form: FormData): Record<string, string> {
  return form.getHeaders();
}

/**
 * Convert FormData to string for fetch body.
 */
export async function formDataToString(form: FormData): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of form) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}