import { z } from "zod";

import {
  normalizeGatePaymentSettings,
  normalizePaymentMethodSlug,
  parsePaymentMethodAliases,
} from "./payment-method-aliases";

const optionalTrimmedString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().optional());

const optionalUpperString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.toUpperCase();
}, z.string().optional());

const optionalBoolean = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") return true;
    if (lowered === "false" || lowered === "0") return false;
  }
  return value;
}, z.boolean().optional());

const optionalNumber = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().optional());

const optionalStringArray = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,;|]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return value;
}, z.array(z.string()).optional());

export const gateSettingsSchema = z.object({
  siteUrl: optionalTrimmedString,
  publicKey: optionalTrimmedString,
  btClientToken: optionalTrimmedString,
  donateAmount: optionalTrimmedString,
  chargeAmount: optionalTrimmedString,
  amount: optionalTrimmedString,
  currency: optionalUpperString,
  wcNonce: optionalTrimmedString,
  wcStoreNonce: optionalTrimmedString,
  ajaxNonce: optionalTrimmedString,
  gfPiNonce: optionalTrimmedString,
  gfPaymentIntentNonce: optionalTrimmedString,
  connectedAccount: optionalTrimmedString,
  stripeAccount: optionalTrimmedString,
  billingFirstName: optionalTrimmedString,
  billingLastName: optionalTrimmedString,
  billingEmail: optionalTrimmedString,
  billingPhone: optionalTrimmedString,
  billingAddress: optionalTrimmedString,
  billingCity: optionalTrimmedString,
  billingState: optionalTrimmedString,
  billingZip: optionalTrimmedString,
  billingCountry: optionalUpperString,
  timeout: optionalNumber,
  platform: optionalTrimmedString,
  checkoutPath: optionalTrimmedString,
  shopPath: optionalTrimmedString,
  productId: optionalNumber,
  wcPaySlug: z.preprocess((value) => {
    if (value === "" || value === null || value === undefined) return undefined;
    return normalizePaymentMethodSlug(typeof value === "string" ? value : String(value));
  }, z.string().optional()),
  paymentMethodAliases: z.preprocess((value) => {
    const parsed = parsePaymentMethodAliases(value);
    return parsed.length > 0 ? parsed : undefined;
  }, z.array(z.string()).optional()),
  proxyCountry: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? trimmed.toUpperCase() : undefined;
  }, z.string().length(2).optional()),
  donationType: z.enum(["single", "subscription"]).optional(),
  captchaProvider: z.enum(["2captcha", "anticaptcha"]).optional(),
  captchaApiKey: optionalTrimmedString,
  captchaType: optionalTrimmedString,
  captchaSiteKey: optionalTrimmedString,
  walletConfigId: optionalTrimmedString,
  rawCookies: optionalTrimmedString,
  giveFormId: optionalTrimmedString,
  giveFormIdPrefix: optionalTrimmedString,
  giveFormHash: optionalTrimmedString,
  charitableFormId: optionalTrimmedString,
  wpFsFormName: optionalTrimmedString,
  wpfsCustomInputCount: optionalNumber,
  ajaxUrl: optionalTrimmedString,
  liveOverrides: optionalStringArray,
  deadOverrides: optionalStringArray,
  proxyOverride: optionalTrimmedString,
  testCardOverride: optionalTrimmedString,
  autoValidate: optionalBoolean,
  autoDetected: optionalBoolean,
  subtypes: optionalStringArray,
  importedFrom: optionalTrimmedString,
  addPmPath: optionalTrimmedString,
  btMerchantId: optionalTrimmedString,
}).passthrough().transform((settings) => {
  const normalized = normalizeGatePaymentSettings(settings);
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  );
});

export const gateCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  gateType: z.string().trim().min(1, "Gate type is required"),
  subType: optionalTrimmedString,
  url: z.string().trim().min(1, "URL is required"),
  active: optionalBoolean,
  country: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? trimmed.toUpperCase() : undefined;
  }, z.string().length(2).optional()),
  settings: z.unknown().optional(),
});

export const gatePatchSchema = z.object({
  name: optionalTrimmedString,
  gateType: optionalTrimmedString,
  subType: optionalTrimmedString,
  url: optionalTrimmedString,
  active: optionalBoolean,
  country: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? trimmed.toUpperCase() : null;
  }, z.union([z.string().length(2), z.null()]).optional()),
  settings: z.unknown().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "No gate fields provided",
});

export const gateImportCommitSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  gateType: z.string().trim().min(1, "Gate type is required"),
  subType: optionalTrimmedString,
  url: optionalTrimmedString,
  active: optionalBoolean,
  settings: z.unknown().optional(),
});

export const gateImportEntrySchema = z.object({
  name: z.string().trim().min(1),
  gateType: z.string().trim().min(1),
  subType: optionalTrimmedString,
  url: z.string().trim().min(1),
  active: optionalBoolean,
  settings: z.unknown().optional(),
});

export type GateSettings = z.infer<typeof gateSettingsSchema>;
