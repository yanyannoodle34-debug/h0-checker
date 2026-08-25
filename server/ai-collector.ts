/**
 * AI Website Collector — uses LLM to discover websites that support specific
 * payment gateways. Accepts keywords and returns structured lists of sites
 * with their gate types, checkout URLs, and supported card methods.
 */
import { aiChat, type AIChatMessage } from "./ai-chat";
import { gateTypesForPrompt, GATE_TYPE_IDS } from "@shared/gate-types";

export interface CollectedSite {
  url:           string;
  name:          string;
  gateType:      string;
  subType?:      string;
  country?:      string;
  notes?:        string;
  confidence:    number;
}

export interface CollectResult {
  keyword:       string;
  sites:         CollectedSite[];
  provider:      string;
  model:         string;
  raw?:          string;
}

// The AI "learns" the catalog of gate types the system can actually configure,
// so it only emits valid types (and knows each type's available subtypes).
const GATE_TYPE_LIST = GATE_TYPE_IDS.join(", ");
const SYSTEM_PROMPT = `You are an expert in payment gateways and checkout systems. Your job is to discover and list websites that support specific payment gateways.

For each keyword the user provides, you will return a JSON array of websites that use that payment gateway or are related to it.

Rules:
1. Return ONLY valid JSON — no markdown, no explanation outside the JSON.
2. Each entry must have: url, name, gateType, country (ISO-2 code), confidence (0-1).
3. Optional fields: subType (the gateway's specific sub-type), notes.
4. gateType MUST be one of: ${GATE_TYPE_LIST}. Never invent a type outside this list.
5. When you know the exact sub-type, set "subType" to one of the allowed values for that gateType. Known gate types and their sub-types:
   ${gateTypesForPrompt()}
6. Include well-known sites AND smaller sites that are more likely to work.
7. If the keyword is a brand name, find their checkout/payment page.
8. If the keyword is a payment type, find sites that accept it.
9. Return max 20 sites, sorted by confidence descending.

Return format (JSON only):
[
  {
    "url": "https://example.com/checkout",
    "name": "Example Store",
    "gateType": "stripe",
    "subType": "checkout_session",
    "country": "US",
    "confidence": 0.9,
    "notes": "WooCommerce with Stripe checkout"
  }
]`;

/** Ask AI to collect websites for a given keyword. */
export async function collectWebsites(
  keyword: string,
  opts?: { provider?: "nvidia" | "deepseek"; model?: string },
): Promise<CollectResult> {
  const messages: AIChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: `Find websites related to: ${keyword}\n\nFocus on sites with Stripe, Braintree, PayPal, or Shopify checkout. Return JSON array only.` },
  ];

  const result = await aiChat({
    provider:  opts?.provider,
    model:     opts?.model,
    messages,
    maxTokens: 4096,
    temperature: 0.3,
  });

  // Parse JSON from response (handle markdown code blocks)
  let raw = result.content.trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) raw = jsonMatch[1].trim();

  let sites: CollectedSite[] = [];
  try {
    const parsed = JSON.parse(raw);
    sites = Array.isArray(parsed) ? parsed.map((s: any) => ({
      url:        String(s.url || ""),
      name:       String(s.name || ""),
      gateType:   String(s.gateType || "unknown"),
      subType:    s.subType ? String(s.subType) : undefined,
      country:    s.country ? String(s.country) : undefined,
      notes:      s.notes ? String(s.notes) : undefined,
      confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
    })).filter((s: CollectedSite) => s.url) : [];
  } catch {
    // JSON parse failed — return empty
  }

  return {
    keyword,
    sites,
    provider: result.provider,
    model:    result.model,
    raw:      result.content,
  };
}

/** Collect websites for multiple keywords in sequence. */
export async function collectWebsitesBatch(
  keywords: string[],
  opts?: { provider?: "nvidia" | "deepseek"; model?: string },
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<CollectResult[]> {
  const results: CollectResult[] = [];

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i].trim();
    if (!kw) continue;
    onProgress?.(i, keywords.length, kw);
    try {
      const result = await collectWebsites(kw, opts);
      results.push(result);
    } catch (err: any) {
      results.push({
        keyword: kw,
        sites:   [],
        provider: opts?.provider || "unknown",
        model:    opts?.model || "unknown",
      });
    }
    // Small delay between requests to avoid rate limiting
    if (i < keywords.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  onProgress?.(keywords.length, keywords.length, "");
  return results;
}

/** Ask AI to analyze a URL and identify its payment gateway. */
export async function analyzeSiteGateway(
  url: string,
  opts?: { provider?: "nvidia" | "deepseek"; model?: string },
): Promise<{ gateType: string; subType?: string; confidence: number; analysis: string }> {
  const messages: AIChatMessage[] = [
    { role: "system", content: "You are a payment gateway detection expert. Analyze the given URL and identify what payment gateway it uses. Return JSON only." },
    { role: "user",   content: `Analyze this URL and identify its payment gateway: ${url}\n\nReturn JSON: { "gateType": "${GATE_TYPE_LIST}", "subType": "optional (use an allowed sub-type for the detected type)", "confidence": 0.0-1.0, "analysis": "brief explanation" }` },
  ];

  const result = await aiChat({ provider: opts?.provider, model: opts?.model, messages, maxTokens: 512, temperature: 0.1 });

  let raw = result.content.trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) raw = jsonMatch[1].trim();

  try {
    const parsed = JSON.parse(raw);
    return {
      gateType:   String(parsed.gateType || "unknown"),
      subType:    parsed.subType ? String(parsed.subType) : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      analysis:   String(parsed.analysis || ""),
    };
  } catch {
    return { gateType: "unknown", confidence: 0, analysis: raw.slice(0, 500) };
  }
}
