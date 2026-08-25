/**
 * Canonical catalog of supported payment gate types and their subtypes.
 *
 * Single source of truth consumed by:
 *   - server/routes.ts  (gate-type dropdown, validation, config flow)
 *   - server/ai-collector.ts (AI "learns" this list so it only emits
 *     gate types the system can actually configure)
 *
 * When adding a new gate flow, add it here once.
 */
export const GATE_TYPES = [
  { id: "stripe",    name: "Stripe",    subtypes: ["auth", "charges", "charitable", "givewp", "givewp_v3", "gravityforms", "wp_full_stripe", "payment_intents", "tokenize", "standard", "3d_secure", "checkout_session", "wc_stripe_confirm_setup_intent", "stripe_page_confirm"] },
  { id: "shopify",   name: "Shopify",   subtypes: ["pci", "standard"] },
  { id: "braintree", name: "Braintree", subtypes: ["standard", "graphql", "drop_in", "hosted_fields", "bigcommerce_stencil"] },
  { id: "payeezy",   name: "First Data Payeezy", subtypes: ["standard"] },
  { id: "paypal",    name: "PayPal",    subtypes: ["standard", "express", "advanced", "givewp_commerce", "paypal_commerce"] },
  { id: "adyen",     name: "Adyen",     subtypes: ["standard", "drop_in", "components"] },
] as const;

export type GateTypeId = (typeof GATE_TYPES)[number]["id"];

export const GATE_TYPE_IDS = GATE_TYPES.map(t => t.id) as string[];

/** A human-readable list for prompts, e.g. "stripe (auth, charges, ...), shopify (...)". */
export function gateTypesForPrompt(): string {
  return GATE_TYPES
    .map(t => `${t.id} (subtypes: ${t.subtypes.join(", ")})`)
    .join("; ");
}
