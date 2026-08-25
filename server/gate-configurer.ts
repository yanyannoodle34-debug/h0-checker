/**
 * Gate configuration "skill" — turns a list of discovered/collected sites
 * directly into configured gate configs.
 *
 * Each site is *polished* by running live gateway detection to refine the
 * gate type, sub-type and settings. If detection can't identify the gateway
 * we fall back to the AI's guess (so collection is never wasted) and still
 * create a usable gate.
 *
 * Used by:
 *   - POST /api/ai/configure-gates   (configure already-collected sites)
 *   - POST /api/ai/collect-and-configure (collect keywords AND configure in one call)
 */
import { storage } from "./storage";
import { detectGateFromUrl } from "./gate-detector";
import { autoGateName, safeHostname } from "./auto-name";
import { gateSettingsSchema } from "@shared/gate-settings";
import { normalizeGatePaymentSettings } from "@shared/payment-method-aliases";
import { GATE_TYPES } from "@shared/gate-types";

function normalizeSettings(settings: Record<string, any> | undefined | null) {
  return gateSettingsSchema.parse(normalizeGatePaymentSettings(settings || {}));
}

export interface SiteInput {
  url: string;
  name?: string;
  gateType?: string;
  subType?: string;
  country?: string;
  confidence?: number;
}

export interface ConfigureResult {
  created: Array<{ id: string; name: string; gateType: string; subType: string; polished: boolean; url: string }>;
  skipped: Array<{ url: string; reason: string }>;
  total: number;
  createdCount: number;
}

const VALID_TYPES: string[] = GATE_TYPES.map(t => t.id);

export async function configureGatesFromSites(sites: SiteInput[]): Promise<ConfigureResult> {
  const created: ConfigureResult["created"] = [];
  const skipped: ConfigureResult["skipped"] = [];

  for (const site of sites) {
    const rawUrl = String(site.url || "").trim();
    if (!rawUrl) { skipped.push({ url: rawUrl, reason: "No URL" }); continue; }

    let gateType = String(site.gateType || "stripe").toLowerCase();
    let subType = String(site.subType || "standard");
    let settings: any = {};
    let polished = false;

    try {
      const detection = await detectGateFromUrl(rawUrl);
      if (detection && detection.gateType && detection.gateType !== "unknown" && detection.gateType !== "unsupported") {
        gateType = detection.gateType;
        subType = detection.subType || subType;
        settings = normalizeSettings(detection.settings);
        polished = true;
      } else {
        if (!VALID_TYPES.includes(gateType)) gateType = "stripe";
        settings = normalizeSettings({ autoDetected: false, note: "AI-collected, live detection failed" });
        settings.siteUrl = rawUrl;
      }
    } catch {
      if (!VALID_TYPES.includes(gateType)) gateType = "stripe";
      settings = normalizeSettings({ autoDetected: false });
      settings.siteUrl = rawUrl;
    }

    const cleanUrl = rawUrl.replace(/\/+$/, "");
    if (!settings.siteUrl) settings.siteUrl = cleanUrl;

    const name = (site.name && String(site.name).trim())
      ? String(site.name).trim().slice(0, 60)
      : autoGateName(gateType, cleanUrl);

    try {
      const gate = await storage.createGateConfig({
        name,
        gateType,
        subType,
        url: cleanUrl,
        active: true,
        country: site.country ? String(site.country).toUpperCase().slice(0, 2) : null,
        settings,
      });

      await storage.createSystemLog({
        level: "SUCCESS",
        message: `AI Collector configured gate "${name}" from ${safeHostname(cleanUrl)} (${polished ? "polished via live detection" : "AI-guess fallback"})`,
        source: "ai-collector",
      });

      created.push({ id: gate.id, name: gate.name, gateType: gate.gateType, subType: gate.subType, polished, url: cleanUrl });
    } catch (e: any) {
      skipped.push({ url: rawUrl, reason: e?.message || "create failed" });
    }
  }

  return { created, skipped, total: sites.length, createdCount: created.length };
}
