export interface DetectedGate {
  gateType: string;
  subType: string;
  settings: Record<string, any>;
  confidence: number;
  signals: string[];
  siteUrl: string;
  crawledPaths: string[];
}

const CRAWL_PATHS = [
  "/",
  "/checkout/",
  "/my-account/",
  "/my-account/add-payment-method/",
  "/my-account-2/",
  "/my-account/verified-payment/",
  "/secure-checkout/finalize/",
  "/donate/make-an-impact/",
  "/cart/view-summary/",
  "/account/secure-billing/add-card/",
  "/checkout/finish-order/",
  "/support-the-cause/",
  "/review-your-selections/",
  "/settings/payment/new/",
  "/pay/",
  "/impact/",
  "/bag/",
  "/home/",
  "/cart/",
  "/shop/",
  "/donate/",
  "/payment/",
  "/billing/",
  "/subscription/",
  "/?wc-ajax=update_order_review",
  "/wp-json/wc/store/v1/checkout",
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

let detectorCookies = "";

// ─── Detection result cache — 30-min TTL per normalized base URL ──────────────
const DETECTION_CACHE_TTL = 30 * 60 * 1000;
const _detectionCache = new Map<string, { result: DetectedGate; cachedAt: number }>();

function mergeDetectorCookies(existing: string, headers: Headers): string {
  const map = new Map<string, string>();
  if (existing) {
    for (const c of existing.split("; ")) {
      const [k] = c.split("=");
      if (k) map.set(k.trim(), c);
    }
  }
  const setCookies = (headers as any).getSetCookie?.() || [];
  const rawCookies = Array.isArray(setCookies) && setCookies.length > 0
    ? setCookies
    : (headers.get("set-cookie") || "").split(/,(?=[^ ])/).filter(Boolean);
  for (const h of rawCookies) {
    const name = h.split(";")[0].trim();
    if (name) {
      const [k] = name.split("=");
      if (k) map.set(k.trim(), name);
    }
  }
  return Array.from(map.values()).join("; ");
}

async function fetchPage(url: string, retries = 2): Promise<string | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const reqHeaders: Record<string, string> = { ...HEADERS };
      if (detectorCookies) reqHeaders["Cookie"] = detectorCookies;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const resp = await fetch(url, { headers: reqHeaders, signal: controller.signal, redirect: "follow" });
      clearTimeout(timeout);

      detectorCookies = mergeDetectorCookies(detectorCookies, resp.headers);
      const finalUrl = resp.url || url;

      if (/sgcaptcha|\.well-known\/sgcaptcha/i.test(finalUrl)) {
        if (attempt < retries) {
          const challengeHtml = await resp.text();
          const cookieMatch = challengeHtml.match(/document\.cookie\s*=\s*["']([^"']+)/);
          if (cookieMatch) {
            detectorCookies = mergeDetectorCookies(detectorCookies, new Headers());
            const [, val] = [null, cookieMatch[1].split(";")[0].trim()];
            const existing = detectorCookies ? detectorCookies + "; " : "";
            detectorCookies = existing + val;
            continue;
          }
          const formMatch = challengeHtml.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
          if (formMatch) {
            const formUrl = new URL(formMatch[1], finalUrl).href;
            const hiddenInputs = formMatch[2].matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi);
            const formData = new URLSearchParams();
            for (const inp of hiddenInputs) formData.append(inp[1], inp[2]);
            try {
              const fResp = await fetch(formUrl, {
                method: "POST",
                headers: { ...reqHeaders, "Content-Type": "application/x-www-form-urlencoded" },
                body: formData.toString(),
                redirect: "follow",
              });
              detectorCookies = mergeDetectorCookies(detectorCookies, fResp.headers);
              continue;
            } catch {}
          }
        }
        return `<captcha_detected type="sgcaptcha" url="${finalUrl}" />`;
      }

      if (resp.status === 403 || resp.status === 503) {
        const text = await resp.text();
        if (text.length < 5000 && (text.includes("challenge-platform") || text.includes("cf-turnstile") || text.includes("challenges.cloudflare.com"))) {
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          return `<captcha_detected type="cloudflare" />${text}`;
        }
        if (text.length < 3000 && /hcaptcha\.com/i.test(text)) {
          return `<captcha_detected type="hcaptcha" />${text}`;
        }
        return null;
      }

      if (!resp.ok) return null;
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("text/html") && !ct.includes("application/json") && !ct.includes("text/plain")) return null;
      const text = await resp.text();
      if (text.length < 1500 && /sgcaptcha|\.well-known\/sgcaptcha/i.test(text)) {
        if (attempt < retries) {
          const cookieMatch = text.match(/document\.cookie\s*=\s*["']([^"']+)/);
          if (cookieMatch) {
            const existing = detectorCookies ? detectorCookies + "; " : "";
            detectorCookies = existing + cookieMatch[1].split(";")[0].trim();
            continue;
          }
        }
        return `<captcha_detected type="sgcaptcha" />${text}`;
      }
      return text;
    } catch {
      if (attempt < retries) continue;
      return null;
    }
  }
  return null;
}

function extractDeepLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const patterns = [
    /href=["']([^"']*(?:donat|give|contribut|support|checkout|pay|billing|cart|shop)[^"']*)/gi,
    /href=["']([^"']*(?:\/pay\/|\/payment\/|\/order\/|\/subscribe\/|\/join\/)[^"']*)/gi,
    /<a[^>]*class=["'][^"']*(?:donate|give|support|pay|checkout)[^"']*["'][^>]*href=["']([^"']+)/gi,
    /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*(?:donate|give|support|pay|checkout)/gi,
    /data-form-url=["']([^"']+)/gi,
    /window\.location(?:\.href)?\s*=\s*["']([^"']*(?:donat|checkout|pay)[^"']*)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const href = match[1];
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
      try {
        const u = new URL(href, baseUrl);
        if (u.hostname === new URL(baseUrl).hostname) {
          const path = u.pathname + u.search;
          if (!links.includes(path) && path.length > 1) links.push(path);
        }
      } catch {}
    }
  }
  return links;
}

function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  if (!url.startsWith("http")) url = "https://" + url;
  url = url.replace(/\/+$/, "");
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

function extractStripeKeys(html: string): string[] {
  const keys: string[] = [];
  const liveMatches = html.matchAll(/pk_live_[a-zA-Z0-9_-]{10,}/g);
  for (const m of liveMatches) {
    if (!keys.includes(m[0])) keys.push(m[0]);
  }
  const testMatches = html.matchAll(/pk_test_[a-zA-Z0-9_-]{10,}/g);
  for (const m of testMatches) {
    if (!keys.includes(m[0])) keys.push(m[0]);
  }
  return keys;
}

function analyzeHtml(html: string, signals: string[], settings: Record<string, any>): {
  stripeScore: number;
  braintreeScore: number;
  paypalScore: number;
  squareScore: number;
  adyenScore: number;
} {
  let stripeScore = 0;
  let braintreeScore = 0;
  let paypalScore = 0;
  let squareScore = 0;
  let adyenScore = 0;

  // Auth-wall sniff — if the page rendered as a login/register surface instead
  // of the payment form, no scraping will succeed regardless of selectors. The
  // operator needs to paste a logged-in session cookie (rawCookies) in gate
  // settings, or pick a public donate URL.
  //
  // Three independent signals (any one is enough):
  //   1. <title> contains "Login" / "Register" / "Sign In"
  //   2. URL redirect with ?after=... pattern (battlemetrics et al.)
  //   3. WooCommerce-specific login form class (woocommerce-form-login) — fires
  //      even when the underlying payment form is also in the HTML because the
  //      WC pattern is to render the login form FIRST and only swap in the
  //      payment form after auth.
  const titleAuthWall = /<title>[^<]*\b(login|register|sign[-_\s]?in)\b/i.test(html);
  const wcLoginForm  = /class=["'][^"']*\bwoocommerce-form-login\b/i.test(html);
  const looksLoginOnly = titleAuthWall || wcLoginForm;
  if (looksLoginOnly && !settings.authWall) {
    settings.authWall = true;
    const why = titleAuthWall ? "page title is a login/register page"
              : "WooCommerce login form (payment surface gated behind auth)";
    signals.push(`⚠ auth wall — ${why}; set rawCookies in gate to a logged-in session cookie`);
  }

  // SaaS donation-platform detection. Each entry is a platform we can recognize
  // but DON'T have a first-class checker flow for — recognizing them stops the
  // operator from wasting time configuring something that can't run, and tells
  // them why. Most modern nonprofits sit on one of these. Building a real
  // checker for any of them is a separate engineering project per platform
  // (each has its own API, CSRF model, response shapes, ToS questions).
  //
  // Order matters: more-specific patterns first (avoid e.g. "donate" generic
  // catching every page). All `unsupported: true` so the dashboard / setup
  // flow can flag the gate and refuse to be saved with a fake config.
  const SAAS_PLATFORMS: Array<{ name: string; test: RegExp; reach?: string }> = [
    // Big nonprofit SaaS — each runs thousands of charities
    { name: "Donorbox",        test: /\bdonorbox\.org\b|donorbox-iframe|class=["'][^"']*donorbox/i,                          reach: "very widespread" },
    { name: "Classy.org",      test: /\bclassy\.org\b|classy-iframe|data-classy-campaign/i,                                    reach: "widespread" },
    { name: "Blackbaud",       test: /\bblackbaud(?:hosting|\.com|\.org|-)?|sphere\.blackbaud|bbis-|webforms\/bbox/i,           reach: "higher-ed & big nonprofits" },
    { name: "ActionKit",       test: /actionkit|ak_braintree|payment_account["'\s:=]+["']Braintree CSE/i,                       reach: "Drupal + Braintree nonprofits" },
    { name: "Salesforce Donation Pages", test: /salesforce-sites\.com|salesforce\.com\/donate|Sfdc\.canvas|\.force\.com\/DonationPage/i, reach: "enterprise CRM users" },
    { name: "Fundraise Up",    test: /fundraise\.up\b|FundraiseUp|fundraiseup\.com/i,                                           reach: "growing" },
    { name: "Givebutter",      test: /\bgivebutter\b|gb-widget|givebutter\.com/i,                                                reach: "smaller nonprofits" },
    { name: "Engaging Networks", test: /\bengagingnetworks\b|en-form|en_pg_/i,                                                  reach: "advocacy nonprofits" },
    { name: "Funraise",        test: /\bfunraise\.io\b/i,                                                                        reach: "smaller nonprofits" },
    { name: "iRaiser",         test: /\biraiser(?:\.eu|\.com)?\b/i,                                                              reach: "European nonprofits" },
    { name: "Network for Good", test: /networkforgood/i,                                                                         reach: "small US nonprofits" },
    { name: "Givelively",      test: /givelively/i,                                                                              reach: "smaller nonprofits" },
    { name: "DonorPerfect",    test: /donorperfect|dpo-online/i,                                                                  reach: "fundraising CRM" },
    { name: "RaiseDonors",     test: /raisedonors/i,                                                                              reach: "smaller nonprofits" },
    { name: "Givecloud",       test: /\bgivecloud\b/i,                                                                            reach: "smaller nonprofits" },
    { name: "Give as you Live", test: /giveasyoulive/i,                                                                          reach: "UK donation aggregator" },
    { name: "GoHighLevel form", test: /leadconnectorhq\.com|gohighlevel/i,                                                       reach: "agency-built sites" },
    // E-commerce SaaS with native checkout (we have WC support but not these)
    { name: "Squarespace Commerce", test: /squarespace.*sqs-payment|sqs-cart|squarespace\.com\/commerce/i,                       reach: "Squarespace sites" },
    { name: "Webflow Ecommerce",    test: /webflow\.io\/commerce|webflow-checkout/i,                                              reach: "Webflow sites" },
    { name: "Wix Payments",         test: /wix\.com\/payments|wixapps\.net\/services\/cashier/i,                                  reach: "Wix sites" },
    // Bespoke WordPress donation plugins (built by specific agencies, not on
    // wp.org). Different shape per plugin — each would need its own flow.
    { name: "Pedalo Donation",      test: /pedalo-donation|nds_form_response/i,                                                   reach: "Pedalo agency clients (UK nonprofits)" },
  ];
  for (const p of SAAS_PLATFORMS) {
    if (p.test.test(html) && !settings.unsupportedPlatform) {
      settings.unsupportedPlatform = p.name;
      settings.platform = settings.platform || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      signals.push(`⚠ ${p.name} — SaaS platform, not supported by checker (${p.reach || "n/a"}). Building a flow for it is a separate per-platform project.`);
      break;
    }
  }

  const stripeKeys = extractStripeKeys(html);
  if (stripeKeys.length > 0) {
    const liveKeys = stripeKeys.filter(k => k.startsWith("pk_live_"));
    const testKeys = stripeKeys.filter(k => k.startsWith("pk_test_"));
    if (liveKeys.length > 0) {
      settings.publicKey = liveKeys[0];
      signals.push(`Stripe Live Key: ${liveKeys[0].slice(0, 20)}...`);
      stripeScore += 40;
    } else if (testKeys.length > 0) {
      settings.publicKey = testKeys[0];
      signals.push(`Stripe Test Key: ${testKeys[0].slice(0, 20)}...`);
      stripeScore += 30;
    }
  }

  if (/js\.stripe\.com\/v[23]/.test(html)) { stripeScore += 20; signals.push("Stripe.js v3 loaded"); }
  if (/Stripe\s*\(\s*['"]pk_/.test(html)) { stripeScore += 15; signals.push("Stripe() init found"); }
  if (/wc-stripe/i.test(html)) { stripeScore += 15; signals.push("WooCommerce Stripe plugin"); }
  if (/stripe_params|wc_stripe_params/i.test(html)) { stripeScore += 15; signals.push("WC Stripe params object"); }
  if (/stripe[_-]?elements|\.elements\s*\(/i.test(html)) { stripeScore += 10; signals.push("Stripe Elements"); }
  if (/payment[_-]?intent|paymentIntent/i.test(html)) { stripeScore += 10; signals.push("PaymentIntent flow"); }
  if (/createPaymentMethod|confirmCardPayment/i.test(html)) { stripeScore += 10; signals.push("Stripe card method"); }
  if (/data-stripe/i.test(html)) { stripeScore += 5; signals.push("Stripe data attr"); }

  // ── Stripe Checkout Session (embedded or redirect) ─────────────────────────
  if (/initEmbeddedCheckout|stripe\.initEmbeddedCheckout/i.test(html)) {
    stripeScore += 25;
    settings.checkoutSession = true;
    signals.push("Stripe Embedded Checkout");
  }
  if (/checkout\.stripe\.com/i.test(html) && !settings.checkoutSession) {
    stripeScore += 15;
    settings.checkoutSession = true;
    signals.push("Stripe Checkout redirect");
  }
  const csMatch = html.match(/clientSecret\s*['":\s]+['"](cs_[a-zA-Z0-9_]+)['"]/);
  if (csMatch) {
    settings.checkoutSessionSecret = csMatch[1];
    settings.checkoutSession = true;
    stripeScore += 20;
    signals.push(`Checkout Session secret: ${csMatch[1].substring(0, 15)}...`);
  }

  const wcNonceMatch = html.match(/woocommerce[_-]?(?:process[_-]?checkout|pay)[_-]?nonce['":\s]+['"]([a-f0-9]+)['"]/i)
    || html.match(/_wpnonce['":\s]+['"]([a-f0-9]+)['"]/i)
    || html.match(/name=["']woocommerce-process-checkout-nonce["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/id=["']woocommerce-process-checkout-nonce["'][^>]*value=["']([^"']+)["']/i);
  if (wcNonceMatch) {
    settings.wcNonce = wcNonceMatch[1];
    signals.push(`WC Nonce: ${wcNonceMatch[1].slice(0, 10)}...`);
  }

  const stripeParamsMatch = html.match(/var\s+wc_stripe_params\s*=\s*(\{[^}]+\})/i)
    || html.match(/wc_stripe_params['":\s]+(\{[^}]+\})/i);
  if (stripeParamsMatch) {
    try {
      const parsed = JSON.parse(stripeParamsMatch[1].replace(/'/g, '"'));
      if (parsed.key && !settings.publicKey) settings.publicKey = parsed.key;
      if (parsed.stripe_account) settings.stripeAccount = parsed.stripe_account;
      signals.push("Parsed wc_stripe_params");
    } catch {}
  }

  const stripeAccountMatch = html.match(/stripe[_-]?account['":\s]+["']?(acct_[a-zA-Z0-9]+)/i)
    || html.match(/\bacct_([a-zA-Z0-9]{8,})\b/);
  if (stripeAccountMatch) {
    const acct = stripeAccountMatch[1].startsWith("acct_") ? stripeAccountMatch[1] : `acct_${stripeAccountMatch[1]}`;
    settings.stripeAccount    = acct;
    settings.connectedAccount = acct;
  }

  const campaignMatch = html.match(/campaign[_-]?id['":\s]+['"]?(\d+)/i);
  if (campaignMatch) settings.campaignId = campaignMatch[1];

  const donateMatch = html.match(/action\s*=\s*["']([^"']*donat[^"']*)/i);
  if (donateMatch) settings.donatePath = donateMatch[1];

  if (/woocommerce|wc-checkout|wc-cart/i.test(html)) {
    settings.platform = "woocommerce";
    signals.push("WooCommerce platform");
  } else if (/shopify/i.test(html)) {
    settings.platform = "shopify";
    signals.push("Shopify platform");
  }

  if (/_charitable_donation_nonce|charitable_form_id|charitable_action.*make_donation/i.test(html)) {
    settings.donationSite = true;
    settings.formType = "charitable";
    signals.push("WordPress Charitable form");
    stripeScore += 15;

    // Auto-discover the form id too — same widened-selector approach as the
    // runtime scraper, so the operator doesn't need to paste it after setup.
    if (!settings.charitableFormId) {
      const charPatterns: RegExp[] = [
        /name=['"]charitable_form_id['"][^>]*value=['"](\d+)['"]/,
        /charitable_form_id['"\s]+value=['"](\d+)['"]/,
        /value=['"](\d+)['"][^>]*name=['"]charitable_form_id['"]/,
        /data-form-id=['"](\d+)['"][^>]*charitable/i,
        /charitable[^>]*data-form-id=['"](\d+)['"]/i,
        /charitable_form_settings\s*=\s*\{[^}]*\bid\s*:\s*['"]?(\d+)/,
      ];
      for (const pat of charPatterns) {
        const m = html.match(pat);
        if (m && m[1]) { settings.charitableFormId = m[1]; break; }
      }
      if (settings.charitableFormId) signals.push(`Charitable form ID: ${settings.charitableFormId}`);
    }
  }

  const giveStripeMatch = html.match(/give_stripe_vars\s*=\s*(\{[^;]+\})/);
  if (giveStripeMatch) {
    settings.donationSite = true;
    settings.formType = "givewp";
    signals.push("GiveWP donation form");
    stripeScore += 15;
    try {
      const giveVars = JSON.parse(giveStripeMatch[1]);
      if (giveVars.publishable_key && !settings.publicKey) {
        settings.publicKey = giveVars.publishable_key;
        signals.push(`GiveWP Stripe key: ${giveVars.publishable_key.slice(0, 20)}...`);
        stripeScore += 30;
      }
    } catch {}
  }

  if (/givewp-route=donate|givewp-donation-form|root-givewp-donation-form/i.test(html)) {
    settings.donationSite = true;
    if (!settings.formType) settings.formType = "givewp";
    settings.giveWpVersion = "v3";
    signals.push("GiveWP v3 route detected");
    stripeScore += 10;
  }

  // give_global_vars carries the GiveWP ajax url + nonce — pull both so the
  // checker doesn't need to scrape them again on first card check.
  const giveGlobalsMatch = html.match(/give_global_vars\s*=\s*(\{[\s\S]*?\});/);
  if (giveGlobalsMatch) {
    if (!settings.giveWpVersion) settings.giveWpVersion = "classic";
    signals.push("GiveWP classic (give_global_vars)");
    try {
      const gv = JSON.parse(giveGlobalsMatch[1]);
      if (gv.ajaxurl && !settings.ajaxUrl) settings.ajaxUrl = gv.ajaxurl;
      const giveNonce = gv.donate_form_nonce || gv.donateNonce || gv.nonce || gv._wpnonce;
      if (giveNonce && !settings.ajaxNonce) {
        settings.ajaxNonce = giveNonce;
        signals.push(`GiveWP ajax nonce: ${String(giveNonce).slice(0, 10)}...`);
      }
    } catch {}
  }

  // Form-id discovery — walk most-specific (v3 form-url with form-id=N) → fall
  // through to v2 input[name=give-form-id], React data attrs, JSON config, and
  // finally the give-form-{id}- class prefix. Mirrors the runtime scraper in
  // stripe-checker so any URL that scrapes at check time also auto-detects at
  // setup time, leaving the operator nothing to paste.
  if (!settings.giveFormId) {
    const formIdPatterns: RegExp[] = [
      /data-form-url=['"]https?:\/\/[^'"]*form-id[=](\d+)/i,
      /givewp-route=donation-form-view[^'"]*form-id[=](\d+)/i,
      /name=['"]give-form-id['"][^>]*value=['"](\d+)['"]/,
      /value=['"](\d+)['"][^>]*name=['"]give-form-id['"]/,
      /data-give-form-id=['"](\d+)['"]/,
      /data-form-id=['"](\d+)['"]/,
      /"formId"\s*:\s*(\d+)/,
      /"form_id"\s*:\s*(\d+)/,
      /\bgive-form-(\d+)-/,
    ];
    for (const pat of formIdPatterns) {
      const m = html.match(pat);
      if (m && m[1]) { settings.giveFormId = m[1]; break; }
    }
    if (settings.giveFormId) signals.push(`GiveWP form ID: ${settings.giveFormId}`);
  }

  // Pre-extract v2 session fields too — give-form-id-prefix and give-form-hash
  // are stable for the form (the hash is per-session but is also re-fetched at
  // check time). Caching the prefix means the first check doesn't have to
  // re-derive it; the hash is a hint that gets refreshed.
  if (!settings.giveFormIdPrefix) {
    const m = html.match(/name=['"]give-form-id-prefix['"][^>]*value=['"]([^'"]+)['"]/)
      || html.match(/value=['"]([^'"]+)['"][^>]*name=['"]give-form-id-prefix['"]/);
    if (m) settings.giveFormIdPrefix = m[1];
  }
  if (!settings.giveFormHash) {
    const m = html.match(/name=['"]give-form-hash['"][^>]*value=['"]([^'"]+)['"]/)
      || html.match(/value=['"]([^'"]+)['"][^>]*name=['"]give-form-hash['"]/);
    if (m) settings.giveFormHash = m[1];
  }

  const gformStripeMatch = html.match(/gform_stripe_theme_js_strings\s*=\s*(\{[^;]+\})/);
  if (gformStripeMatch) {
    settings.donationSite = true;
    settings.formType = "gravityforms";
    signals.push("Gravity Forms + Stripe");
    stripeScore += 15;
    try {
      const gfVars = JSON.parse(gformStripeMatch[1]);
      if (gfVars.publishable_key && !settings.publicKey) {
        settings.publicKey = gfVars.publishable_key;
        signals.push(`GF Stripe key: ${gfVars.publishable_key.slice(0, 20)}...`);
        stripeScore += 30;
      }
      if (gfVars.create_payment_intent_nonce) {
        settings.gfPaymentIntentNonce = gfVars.create_payment_intent_nonce;
        signals.push("GF PI nonce found");
      }
    } catch {}
  }

  const gfFeedMatch = html.match(/GFFrontendFeeds\(\s*(\{[^;]+\})\s*\)/);
  if (gfFeedMatch) {
    try {
      const feedData = JSON.parse(gfFeedMatch[1]);
      settings.gfFormId = feedData.formId;
      if (feedData.feeds?.length > 0) {
        const firstFeed = feedData.feeds[0];
        if (firstFeed.publishableKey && !settings.publicKey) {
          settings.publicKey = firstFeed.publishableKey;
        }
        settings.gfFeedId = firstFeed.feedId;
      }
      signals.push(`GF Form ID: ${settings.gfFormId}`);
    } catch {}
  }

  // Fallback form-id discovery when GFFrontendFeeds isn't on the page (themed
  // GF forms, AJAX-loaded forms, or older installs). Same widening pattern as
  // GiveWP / Charitable — most-specific first, fall through to weakest. Real
  // GF markup exposes the form-id in five distinct places.
  if (!settings.gfFormId && (settings.formType === "gravityforms" || /gform_wrapper|gform_submit|gform_ajax/i.test(html))) {
    const gfPatterns: RegExp[] = [
      /name=['"]gform_submit['"][^>]*value=['"](\d+)['"]/,
      /value=['"](\d+)['"][^>]*name=['"]gform_submit['"]/,
      /<form[^>]+id=['"]gform_(\d+)['"]/,
      /class=['"][^'"]*\bgform_wrapper_(\d+)\b[^'"]*['"]/,
      /name=['"]is_submit_(\d+)['"]/,
      /data-formid=['"](\d+)['"]/,
      /data-form-index=['"](\d+)['"]/,
    ];
    for (const pat of gfPatterns) {
      const m = html.match(pat);
      if (m && m[1]) { settings.gfFormId = m[1]; break; }
    }
    if (settings.gfFormId) signals.push(`GF Form ID: ${settings.gfFormId}`);
  }

  if (/gravityformsstripe|gf_stripe/i.test(html) && !settings.formType) {
    settings.formType = "gravityforms";
    signals.push("Gravity Forms Stripe plugin");
    stripeScore += 10;
  }

  // WP Full Stripe plugin (Mammothology). Two flow variants both belong to the
  // same checker subType (wp_full_stripe) — the runtime scrape picks which
  // action= name to send.  Markers: wpfs- input prefix, wp-full-stripe asset
  // path, or the inline_payment/inline_donation action names.
  if (/\bwp-full-stripe\b|\bwpfs-[a-z]|wp_full_stripe_inline_(payment|donation)_charge/i.test(html)) {
    settings.donationSite = true;
    settings.formType = "wp_full_stripe";
    stripeScore += 30;
    // Capture the site-specific form-name now so the gate is fully configured
    // from auto-detect (it's required at check time and changes per site).
    if (!settings.wpFsFormName) {
      const m = html.match(/name=['"]wpfs-form-name['"][^>]*value=['"]([^'"]+)['"]/)
             || html.match(/value=['"]([^'"]+)['"][^>]*name=['"]wpfs-form-name['"]/);
      if (m) settings.wpFsFormName = m[1];
    }
    signals.push(`WP Full Stripe plugin${settings.wpFsFormName ? ` (form: ${settings.wpFsFormName})` : ""}`);
  }

  if (!settings.formType && /charitable|give-form|donation-form/i.test(html)) {
    settings.donationSite = true;
    signals.push("Donation form detected");
  }

  // ── WooCommerce Payments (WCPay / WooPayments) ─────────────────────────────
  if (/wcpay[_-]?config|woocommerce[_-]?payments/i.test(html)) {
    stripeScore += 20;
    settings.wcPayments = true;
    signals.push("WooCommerce Payments (WCPay)");
  }
  if (/payment_method.*woocommerce_payments|woocommerce_payments.*payment_method/i.test(html)) {
    stripeScore += 15;
    settings.wcPayments = true;
    settings.wcPaySlug = "woocommerce_payments";
    signals.push("WCPay checkout slug detected");
  }

  // ── WooCommerce Stripe CC-only mode ──────────────────────────────────────
  // Detect when WC Stripe is configured for credit-card only (not full Stripe)
  if (/wc[_-]?stripe[_-]?cc|stripe[_-]?cc|woocommerce[_-]?stripe[_-]?credit[_-]?card/i.test(html)) {
    if (!settings.wcPaySlug) {
      settings.wcPaySlug = "stripe_cc";
      signals.push("WC Stripe CC-only mode detected");
    }
  }

  // ── Stripe publishable key presence (heuristic for stripe_cc) ─────────────
  // If we found a pk_live_ or pk_test_ but no explicit slug, check for
  // credit-card-only indicators in forms or scripts
  if (settings.publicKey && !settings.wcPaySlug && !settings.wcPayments) {
    // Check for credit-card-only mode indicators
    if (/stripe[_-]?elements|card[_-]?element|stripe[_-]?card/i.test(html) &&
        !/woocommerce[_-]?payments|wcpay/i.test(html)) {
      settings.wcPaySlug = "stripe_cc";
      signals.push("Stripe Elements detected (inferred stripe_cc slug)");
    }
  }

  // ── Explicit WC Stripe slug from HTML data attributes or config ───────────
  // Some sites expose the payment method slug in data attributes or JS config
  if (!settings.wcPaySlug) {
    const slugMatch = html.match(/payment_method['":\s]+['"]?(stripe(?:_cc|_checkout)?|woocommerce_payments|braintree_cc)['"]?/i)
      || html.match(/wc[_-]?stripe[_-]?method['":\s]+['"]?([^'"]+)['"]/i)
      || html.match(/data[_-]?payment[_-]?method=['"]?([^'"]+)['"]/i);
    if (slugMatch?.[1]) {
      const detectedSlug = slugMatch[1].toLowerCase();
      // Normalize common variations
      if (/woocommerce[_-]?payments|wcpay/i.test(detectedSlug)) {
        settings.wcPaySlug = "woocommerce_payments";
        signals.push("WCPay slug from data attribute");
      } else if (/stripe[_-]?cc|stripecc/i.test(detectedSlug)) {
        settings.wcPaySlug = "stripe_cc";
        signals.push("Stripe CC slug from data attribute");
      } else if (/stripe[_-]?checkout/i.test(detectedSlug)) {
        settings.wcPaySlug = "stripe_checkout";
        signals.push("Stripe Checkout slug from data attribute");
      } else if (/braintree[_-]?cc/i.test(detectedSlug)) {
        settings.wcPaySlug = "braintree_cc";
        signals.push("Braintree CC slug from data attribute");
      } else if (/stripe/i.test(detectedSlug) && !/checkout|cc/i.test(detectedSlug)) {
        settings.wcPaySlug = "stripe";
        signals.push("Stripe slug from data attribute");
      }
    }
  }

  // ── WooCommerce Block Checkout (Store API) ──────────────────────────────────
  if (/wc-block-checkout|wp-block-woocommerce-checkout|wc-blocks-checkout/i.test(html)) {
    settings.wcBlockCheckout = true;
    if (!settings.platform) settings.platform = "woocommerce";
    stripeScore += 10;
    signals.push("WC Block Checkout (Store API)");
  }
  const wcStoreNonceMatch = html.match(/wcStoreApiNonce['":\s]+['"]([a-f0-9]+)['"]/i)
    || html.match(/storeApiNonce['":\s]+['"]([a-f0-9]+)['"]/i);
  if (wcStoreNonceMatch) {
    settings.wcStoreNonce = wcStoreNonceMatch[1];
    signals.push(`WC Store API Nonce: ${wcStoreNonceMatch[1].slice(0, 10)}...`);
  }

  // ── WP REST nonce — used by GiveWP v3, WC Blocks, modern plugins ───────────
  if (!settings.wpRestNonce) {
    const wpRestMatch = html.match(/wpApiSettings\s*=\s*\{[^}]*nonce['":\s]+['"]([a-f0-9]{8,})['"]/i)
      || html.match(/wp\.apiFetch\.createNonceMiddleware\(\s*['"]([a-f0-9]{8,})['"]/i)
      || html.match(/_wpRestNonce['":\s]+['"]([a-f0-9]{8,})['"]/i)
      || html.match(/data-wp-rest-nonce=["']([a-f0-9]{8,})["']/i);
    if (wpRestMatch) {
      settings.wpRestNonce = wpRestMatch[1];
      signals.push(`WP REST Nonce: ${wpRestMatch[1].slice(0, 10)}...`);
    }
  }

  // ── WC AJAX endpoint URL + update-order-review nonce (legacy checkout) ─────
  if (!settings.ajaxUrl) {
    const wcAjaxMatch = html.match(/wc_ajax_url['":\s]+['"]([^'"]+)['"]/i)
      || html.match(/wc_checkout_params\s*=\s*\{[^}]*ajax_url['":\s]+['"]([^'"]+)['"]/i)
      || html.match(/woocommerce_params\s*=\s*\{[^}]*ajax_url['":\s]+['"]([^'"]+)['"]/i);
    if (wcAjaxMatch) {
      settings.ajaxUrl = wcAjaxMatch[1].replace(/\\\//g, "/");
      signals.push("WC ajax_url found");
    }
  }
  if (!settings.ajaxNonce) {
    const wcUpdateNonce = html.match(/update_order_review_nonce['":\s]+['"]([a-f0-9]{8,})['"]/i);
    if (wcUpdateNonce) {
      settings.ajaxNonce = wcUpdateNonce[1];
      signals.push(`WC update_order_review nonce: ${wcUpdateNonce[1].slice(0, 10)}...`);
    }
  }

  // ── Wallet config ID (Stripe Payment Request / Apple Pay / Link) ───────────
  if (!settings.walletConfigId) {
    const walletMatch = html.match(/walletConfigId['":\s]+['"]([a-zA-Z0-9_-]{8,})['"]/i)
      || html.match(/wallet_config_id['":\s]+['"]([a-zA-Z0-9_-]{8,})['"]/i);
    if (walletMatch) {
      settings.walletConfigId = walletMatch[1];
      signals.push(`Wallet config: ${walletMatch[1].slice(0, 12)}...`);
    }
  }

  if (/js\.braintreegateway\.com/i.test(html)) { braintreeScore += 30; signals.push("Braintree SDK"); }
  if (/braintree\.client\.create/i.test(html)) { braintreeScore += 20; signals.push("BT client create"); }
  if (/braintree[_-]?drop[_-]?in/i.test(html)) { braintreeScore += 15; signals.push("BT drop-in UI"); }
  if (/braintree\.hostedFields/i.test(html)) { braintreeScore += 15; signals.push("BT hosted fields"); }

  // ── WC Braintree plugin flow detection ──────────────────────────────────
  if (/wc[_-]braintree[_-]client[_-]token|wc_braintree_credit_card_get_client_token/i.test(html)) {
    braintreeScore += 25;
    if (!settings.btFlow) settings.btFlow = "wc_braintree";
    signals.push("BT WC plugin (wc_braintree checkout flow)");
  }
  if (/var\s+wc_braintree_client_token\s*=\s*\[/i.test(html)) {
    braintreeScore += 25;
    settings.btFlow = "wc_braintree_addpm";   // inline token in add-pm page
    signals.push("BT WC add-payment-method flow (inline token)");
  }
  if (/wc-braintree|wc_braintree(?!_client_token)/i.test(html) && !settings.btFlow) {
    braintreeScore += 10;
    settings.btFlow = "wc_braintree";
    signals.push("BT WC plugin signals");
  }

  // ── BT client token extraction (extended patterns) ───────────────────────
  const btTokenMatch =
       html.match(/var\s+wc_braintree_client_token\s*=\s*\["([^"]{30,})"/)
    || html.match(/braintreeClientToken\s*["':\s]+["']([^"']{30,})["']/)
    || html.match(/"clientToken"\s*:\s*"([^"]{30,})"/)
    || html.match(/"client_token"\s*:\s*"([^"]{30,})"/)
    || html.match(/authorization['":\s]+['"]([^'"]{30,})['"]/i)
    || html.match(/client[_-]?token['":\s]+['"]([^'"]{30,})['"]/i);
  if (btTokenMatch?.[1]) {
    settings.btClientToken = btTokenMatch[1];
    signals.push("BT client token found");
    braintreeScore += 20;
  }

  // ── BT merchant ID extraction ────────────────────────────────────────────
  if (!settings.btMerchantId) {
    const merchantM = html.match(/"merchantId"\s*:\s*"([^"]{6,})"/);
    if (merchantM) {
      settings.btMerchantId = merchantM[1];
      signals.push(`BT merchant: ${merchantM[1]}`);
    }
  }

  if (/www\.paypal\.com\/sdk\/js/i.test(html)) { paypalScore += 25; signals.push("PayPal SDK"); }
  if (/paypal\.Buttons/i.test(html)) { paypalScore += 15; signals.push("PayPal Buttons"); }
  if (/paypal-checkout/i.test(html)) { paypalScore += 10; signals.push("PayPal checkout"); }

  // GiveWP PayPal Commerce: has give-form-hash + data-client-token + paypal-commerce mode
  // This is NOT Braintree — it uses PayPal's confirm-payment-source API via Braintree token
  if (/give-form-hash/i.test(html) && /data-client-token/i.test(html) && /paypal[_-]commerce/i.test(html)) {
    paypalScore += 50;
    settings.formType = "givewp_paypal";
    settings.donationSite = true;
    signals.push("GiveWP PayPal Commerce (no PK needed)");
  }
  // Generic PayPal Commerce (non-GiveWP, non-WC): paypal-commerce mode with Braintree client token
  // but without WC PPCP markers. Examples: custom WP sites, GiveWP without form-hash.
  else if (/paypal[_-]commerce/i.test(html) && /data-client-token/i.test(html) && !/ppc_nonce|wc[_-]paypal|woocommerce/i.test(html)) {
    paypalScore += 40;
    settings.formType = "paypal_commerce";
    signals.push("PayPal Commerce (Braintree token, non-WC)");
  }
  // PayPal Commerce via ppc_nonce (WooCommerce PayPal Payments).
  // This is a DECISIVE signal: when present, the active WC checkout is PayPal,
  // not Stripe — even when wc-stripe is also loaded on the site for other
  // widgets (memberships, gift cards, side carts). Weight higher than the
  // combined Stripe.js + wc-stripe + Elements signals (60) so PPCP wins ties.
  if (/ppc_nonce|ppc_create_order|ppcp[_-]checkout|paypal[_-]commerce/i.test(html)) {
    paypalScore += 70;
    signals.push("WooCommerce PayPal Payments (PPCP) — active checkout");
    // Heuristic: when PPCP markers are present but Stripe lacks an *active*
    // checkout signal (createPaymentMethod / confirmCardPayment / payment_intent
    // nonces / wc_stripe_params present), Stripe is probably loaded but inactive
    // for this checkout. Cap the Stripe score at a lower ceiling so the gate
    // isn't mis-labeled. We don't zero it (Stripe might still be the path for
    // a sub-flow), but we make sure PayPal wins.
    const stripeActiveCheckout = /createPaymentMethod|confirmCardPayment|create_payment_intent|wc_stripe_params|stripe_payment_intent_nonce/i.test(html);
    if (!stripeActiveCheckout) {
      stripeScore = Math.min(stripeScore, 35);
      signals.push("⚠ Stripe.js loaded but no active-checkout signal — capped score (PPCP wins)");
    }
  }

  if (/squareup\.com|web\.squarecdn\.com/i.test(html)) { squareScore += 25; signals.push("Square SDK"); }

  // Adyen detection
  if (/adyen\.com|adyen-|Adyen/i.test(html)) {
    adyenScore += 40;
    signals.push("Adyen SDK/checkout detected");
  }
  if (/createFromAction|handleAction|dropin|AdyenCheckout/i.test(html)) {
    adyenScore += 30;
    signals.push("Adyen Drop-in/Components integration");
  }
  if (/originKey|clientKey|merchantAccount/i.test(html) && /adyen/i.test(html)) {
    adyenScore += 20;
    signals.push("Adyen client-side config found");
  }

  if (/sgcaptcha|siteground.*captcha/i.test(html)) {
    settings.captchaType = "sgcaptcha";
    signals.push("⚠ SiteGround CAPTCHA detected");
  } else if (/turnstile.*sitekey|challenges\.cloudflare\.com/i.test(html)) {
    settings.captchaType = "turnstile";
    const tkMatch = html.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
    if (tkMatch) settings.captchaSiteKey = tkMatch[1];
    signals.push("⚠ Cloudflare Turnstile CAPTCHA");
  } else if (/g-recaptcha|grecaptcha|www\.google\.com\/recaptcha/i.test(html)) {
    settings.captchaType = "recaptcha";
    const rkMatch = html.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
    if (rkMatch) settings.captchaSiteKey = rkMatch[1];
    signals.push("⚠ Google reCAPTCHA detected");
  } else if (/hcaptcha\.com|h-captcha/i.test(html)) {
    settings.captchaType = "hcaptcha";
    const hkMatch = html.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
    if (hkMatch) settings.captchaSiteKey = hkMatch[1];
    signals.push("⚠ hCaptcha detected");
  }

  return { stripeScore, braintreeScore, paypalScore, squareScore, adyenScore };
}

export async function detectGateFromUrl(inputUrl: string): Promise<DetectedGate> {
  const baseUrl = normalizeBaseUrl(inputUrl);

  const cached = _detectionCache.get(baseUrl);
  if (cached && Date.now() - cached.cachedAt < DETECTION_CACHE_TTL) {
    return cached.result;
  }

  const signals: string[] = [];
  const settings: Record<string, any> = { siteUrl: baseUrl };
  const crawledPaths: string[] = [];
  detectorCookies = "";

  let totalStripe = 0;
  let totalBraintree = 0;
  let totalPaypal = 0;
  let totalSquare = 0;
  let totalAdyen = 0;

  const discoveredPaths: string[] = [];

  const homepageHtml = await fetchPage(baseUrl + "/");
  if (homepageHtml && !homepageHtml.startsWith("<captcha_detected")) {
    crawledPaths.push("/");
    const homeScores = analyzeHtml(homepageHtml, signals, settings);
    totalStripe += homeScores.stripeScore;
    totalBraintree += homeScores.braintreeScore;
    totalPaypal += homeScores.paypalScore;
    totalSquare += homeScores.squareScore;
    totalAdyen += homeScores.adyenScore;

    const deepLinks = extractDeepLinks(homepageHtml, baseUrl);
    discoveredPaths.push(...deepLinks);

    const navMatch = homepageHtml.match(/<nav[^>]*>([\s\S]*?)<\/nav>/gi);
    if (navMatch) {
      for (const nav of navMatch) {
        const navLinks = nav.matchAll(/href=["']([^"']+)/gi);
        for (const m of navLinks) {
          try {
            const u = new URL(m[1], baseUrl);
            if (u.hostname === new URL(baseUrl).hostname) {
              const p = u.pathname;
              if (/donat|give|pay|checkout|support|contribut|shop|cart|billing|subscri/i.test(p) && !discoveredPaths.includes(p)) {
                discoveredPaths.push(p);
              }
            }
          } catch {}
        }
      }
    }
  } else if (homepageHtml?.startsWith("<captcha_detected")) {
    crawledPaths.push("/");
    analyzeHtml(homepageHtml, signals, settings);
  }

  const pathBatches = [
    ["/checkout/", "/my-account/add-payment-method/", "/account/add-payment-method/"],
    ["/donate/", "/pay/", "/shop/", "/give/"],
    ["/donate-now/", "/donation/", "/contribute/", "/support/"],
    ["/my-account/", "/cart/", "/billing/"],
    ["/my-account/verified-payment/", "/secure-checkout/finalize/", "/donate/make-an-impact/"],
    ["/account/secure-billing/add-card/", "/checkout/finish-order/", "/support-the-cause/"],
  ];

  for (const batch of pathBatches) {
    if (settings.publicKey && settings.formType && !batch.some(p => /donat|give|support|contribut/i.test(p))) break;

    const uniquePaths = batch.filter(p => !crawledPaths.includes(p));
    if (uniquePaths.length === 0) continue;

    const results = await Promise.allSettled(
      uniquePaths.map(async (path) => {
        const fullUrl = baseUrl + path;
        const html = await fetchPage(fullUrl);
        return { path, html };
      })
    );

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value.html) continue;
      const { path, html } = r.value;
      crawledPaths.push(path);

      if (!html.startsWith("<captcha_detected")) {
        const newLinks = extractDeepLinks(html, baseUrl);
        for (const link of newLinks) {
          if (!discoveredPaths.includes(link) && !crawledPaths.includes(link)) {
            discoveredPaths.push(link);
          }
        }
      }

      const scores = analyzeHtml(html, signals, settings);
      totalStripe += scores.stripeScore;
      totalBraintree += scores.braintreeScore;
      totalPaypal += scores.paypalScore;
      totalSquare += scores.squareScore;
      totalAdyen += scores.adyenScore;
    }
  }

  if (!settings.publicKey || !settings.formType) {
    const deepPaths = discoveredPaths.filter(p => !crawledPaths.includes(p)).slice(0, 8);
    if (deepPaths.length > 0) {
      const deepResults = await Promise.allSettled(
        deepPaths.map(async (path) => {
          const fullUrl = baseUrl + path;
          const html = await fetchPage(fullUrl);
          return { path, html };
        })
      );

      for (const r of deepResults) {
        if (r.status !== "fulfilled" || !r.value.html) continue;
        const { path, html } = r.value;
        crawledPaths.push(path);
        if (!html.startsWith("<captcha_detected")) {
          const scores = analyzeHtml(html, signals, settings);
          totalStripe += scores.stripeScore;
          totalBraintree += scores.braintreeScore;
          totalPaypal += scores.paypalScore;
          totalSquare += scores.squareScore;
          totalAdyen += scores.adyenScore;
        }
      }
    }
  }

  if (!settings.publicKey) {
    const inputPath = inputUrl.replace(baseUrl, "");
    if (inputPath && inputPath !== "/" && !crawledPaths.includes(inputPath)) {
      const html = await fetchPage(inputUrl.startsWith("http") ? inputUrl : "https://" + inputUrl);
      if (html) {
        crawledPaths.push(inputPath || "/custom");
        const scores = analyzeHtml(html, signals, settings);
        totalStripe += scores.stripeScore;
        totalBraintree += scores.braintreeScore;
        totalPaypal += scores.paypalScore;
        totalSquare += scores.squareScore;
        totalAdyen += scores.adyenScore;
      }
    }
  }

  const uniqueSignals = [...new Set(signals)];

  const scores = [
    { type: "stripe", score: totalStripe },
    { type: "braintree", score: totalBraintree },
    { type: "paypal", score: totalPaypal },
    { type: "square", score: totalSquare },
  ].sort((a, b) => b.score - a.score);

  let gateType = "unknown";
  let subType = "standard";
  let confidence = 0;

  // If we recognized a SaaS platform we don't support, refuse to claim a
  // viable gate even if Stripe-shaped signals were also present (often a SaaS
  // platform embeds Stripe internally but funnels everything through its own
  // API). Zero confidence + "unsupported" subType lets the dashboard refuse
  // to save the gate and show the operator the platform name + why.
  if (settings.unsupportedPlatform) {
    gateType = "unsupported";
    subType = "saas_" + String(settings.unsupportedPlatform).toLowerCase().replace(/[^a-z0-9]+/g, "_");
    confidence = 0;
  } else if (scores[0].score > 0) {
    gateType = scores[0].type;
    confidence = Math.min(scores[0].score, 100);

    if (gateType === "stripe") {
      if (settings.checkoutSession) subType = "checkout_session";
      else if (settings.formType === "charitable") subType = "charitable";
      else if (settings.formType === "givewp") {
        subType = settings.giveWpVersion === "v3" ? "givewp_v3" : "givewp";
      }
      else if (settings.formType === "gravityforms") subType = "gravityforms";
      else if (settings.formType === "wp_full_stripe") subType = "wp_full_stripe";
      else if (settings.donationSite) subType = "charitable";
      else if (settings.platform === "woocommerce") subType = "payment_intents";
      else subType = "payment_intents";
    } else if (gateType === "paypal") {
      if (settings.formType === "givewp_paypal") subType = "givewp_commerce";
      else if (settings.formType === "paypal_commerce") subType = "paypal_commerce";
      else subType = "standard";
    } else if (gateType === "braintree") {
      if (settings.btFlow === "wc_braintree_addpm") subType = "wc_addpm";
      else if (settings.btFlow === "wc_braintree") subType = "wc_checkout";
      else if (settings.btDropIn) subType = "drop_in";
      else subType = "hosted_fields";
    }
  }

  const activeGates = scores.filter(s => s.score > 0);
  if (activeGates.length > 1) {
    settings.hybridGates = activeGates.map(g => g.type);
    uniqueSignals.push(`Hybrid: ${activeGates.map(g => g.type).join(" + ")}`);
  }

  // Lazy-form-load hint — when a WordPress donation plugin's signature was
  // present in the HTML (give_global_vars / charitable_action / gravityforms)
  // but no form-id was extracted by any selector, the form is being injected
  // by JS after the initial paint. Tell the operator that explicitly so they
  // know to paste the id, not to assume our detector is broken.
  const lazyHints: string[] = [];
  if (/give_global_vars|give-form/i.test(homepageHtml || "") && !settings.giveFormId)      lazyHints.push("GiveWP form appears JS-loaded — paste giveFormId in gate settings");
  if (/_charitable_donation_nonce|charitable_form_id/i.test(homepageHtml || "") && !settings.charitableFormId) lazyHints.push("Charitable form appears JS-loaded — paste charitableFormId in gate settings");
  if (/gravityforms|gform_wrapper/i.test(homepageHtml || "") && !settings.gfFormId)        lazyHints.push("Gravity Forms form appears JS-loaded — paste gfFormId in gate settings");
  for (const h of lazyHints) uniqueSignals.push(`⚠ ${h}`);

  // Explicit "failed to auto-detect form-id" signal when the donation platform
  // was identified but no id was extracted. Saves the operator from guessing
  // whether we tried — tells them to paste the id manually in gate settings.
  const missingFormId: string[] = [];
  if (settings.formType === "givewp"      && !settings.giveFormId)      missingFormId.push("giveFormId");
  if (settings.formType === "charitable"  && !settings.charitableFormId) missingFormId.push("charitableFormId");
  if (settings.formType === "gravityforms" && !settings.gfFormId)        missingFormId.push("gfFormId");
  if (missingFormId.length) {
    uniqueSignals.push(`⚠ form-id not auto-detected (${missingFormId.join(", ")}) — page may be JS-rendered; set manually in gate settings`);
    settings.formIdMissing = missingFormId;
  }

  const result: DetectedGate = {
    gateType,
    subType,
    settings,
    confidence,
    signals: uniqueSignals,
    siteUrl: baseUrl,
    crawledPaths,
  };

  _detectionCache.set(baseUrl, { result, cachedAt: Date.now() });
  return result;
}
