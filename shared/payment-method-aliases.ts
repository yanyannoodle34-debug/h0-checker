export type PaymentSlugOption = {
  value: string;
  label: string;
  aliases: string[];
};

export const PAYMENT_SLUG_OPTIONS: PaymentSlugOption[] = [
  { value: "stripe", label: "Stripe", aliases: ["stripe_card", "stripe-card", "stripe card"] },
  { value: "stripe_cc", label: "Stripe CC", aliases: ["stripe-cc", "stripecc", "wc_stripe", "woocommerce_stripe"] },
  { value: "stripe_checkout", label: "Stripe Checkout", aliases: ["stripe-checkout", "stripecheckout"] },
  { value: "woocommerce_payments", label: "WooCommerce Payments", aliases: ["wcpay", "wc_pay", "wcpayments", "woocommerce-payments", "woocommerce payments"] },
  { value: "braintree_cc", label: "Braintree CC", aliases: ["braintree-cc", "braintreecc", "braintree card"] },
  {
    value: "first_data_payeezy_gateway_credit_card",
    label: "Payeezy Credit Card",
    aliases: [
      "payeezy",
      "payeezy_cc",
      "payeezy-cc",
      "first_data_payeezy",
      "first-data-payeezy",
      "first data payeezy",
    ],
  },
];

const normalizeToken = (value: string) =>
  value.trim().toLowerCase().replace(/[\s-]+/g, "_");

const PAYMENT_SLUG_LOOKUP = new Map<string, string>();
for (const option of PAYMENT_SLUG_OPTIONS) {
  PAYMENT_SLUG_LOOKUP.set(normalizeToken(option.value), option.value);
  for (const alias of option.aliases) {
    PAYMENT_SLUG_LOOKUP.set(normalizeToken(alias), option.value);
  }
}

export function normalizePaymentMethodSlug(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return PAYMENT_SLUG_LOOKUP.get(normalizeToken(trimmed)) || trimmed;
}

export function parsePaymentMethodAliases(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;|]+/g)
      : [];

  const seen = new Set<string>();
  const parsed: string[] = [];

  for (const raw of rawValues) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeToken(normalizePaymentMethodSlug(trimmed) || trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(trimmed);
  }

  return parsed;
}

type GatePaymentSettingsShape = Record<string, any> & {
  paymentMethodAliases?: unknown;
  wcPaySlug?: string | null;
};

export function normalizeGatePaymentSettings<T extends GatePaymentSettingsShape>(settings?: T | null): T {
  const next = { ...(settings || {}) } as T;
  const aliases = parsePaymentMethodAliases(next.paymentMethodAliases);
  const explicitSlug = normalizePaymentMethodSlug(next.wcPaySlug);
  const aliasSlug = aliases.map((alias) => normalizePaymentMethodSlug(alias)).find(Boolean);

  if (aliases.length > 0) next.paymentMethodAliases = aliases as T[keyof T];
  else delete next.paymentMethodAliases;

  if (explicitSlug) next.wcPaySlug = explicitSlug as T[keyof T];
  else if (aliasSlug) next.wcPaySlug = aliasSlug as T[keyof T];
  else delete next.wcPaySlug;

  return next;
}
