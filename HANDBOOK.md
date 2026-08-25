# H@0 Checker v8.0 — Developer Handbook

> Complete reference for startup, troubleshooting, and modifying core systems.

---

## Table of Contents

0. [V8.0 — What's New](#0-v80--whats-new)
1. [Project Architecture](#1-project-architecture)
2. [Startup Guide](#2-startup-guide)
   - [Termux (Android)](#21-termux-android)
   - [Linux / macOS](#22-linux--macos)
   - [Windows](#23-windows)
   - [Environment Variables](#24-environment-variables)
3. [Common Problems & Fixes](#3-common-problems--fixes)
4. [Core Code Guide](#4-core-code-guide)
   - [Adding a Gate Type](#41-adding-a-new-gate-type)
   - [Modifying Card Checker Logic](#42-modifying-card-checker-logic)
   - [Stripe Hitter](#43-stripe-hitter)
   - [Gate Auto-Detector](#44-gate-auto-detector)
   - [Database Schema](#45-database-schema)
   - [API Routes](#46-api-routes)
   - [Telegram Bot Commands](#47-telegram-bot-commands)
   - [Frontend Pages](#48-frontend-pages)
5. [Proxy System](#5-proxy-system)
   - [Scrub Sources](#51-scrub-sources)
   - [Wash Pool](#52-wash-pool)
   - [How Proxies Work in Checking](#53-how-proxies-work-in-checking)
   - [Proxy Formats](#54-proxy-formats)
6. [CC Miner](#6-cc-miner)
   - [Server Miner](#61-server-miner)
   - [Random Gate Mode](#62-random-gate-mode)
   - [Browser Miner (UCB1)](#63-browser-miner-ucb1)
7. [Gate Configuration — Advanced](#7-gate-configuration--advanced)
   - [Edit Tabs Reference](#71-edit-tabs-reference)
   - [WooCommerce Overrides](#72-woocommerce-overrides)
   - [WCPay Support](#73-wcpay-support)
   - [Braintree Gates](#74-braintree-gates)
   - [Nonce Freshness](#75-nonce-freshness)
8. [File Map](#8-file-map)
9. [Default Credentials](#9-default-credentials)
10. [Gate Setup — Complete Guide (English)](#10-gate-setup--complete-guide-english)
    - [Method 1: Auto-Detect](#101-method-1-auto-detect-recommended)
    - [Method 2: Bulk URL Scan](#102-method-2-bulk-url-scan)
    - [Method 3: Manual Setup](#103-method-3-manual-setup)
    - [Finding Keys from Browser DevTools](#104-finding-keys-from-browser-devtools)
    - [Gate Type: Stripe (WooCommerce)](#105-gate-type-stripe-woocommerce)
    - [Gate Type: Stripe (Donation Forms)](#106-gate-type-stripe-donation-forms)
    - [Gate Type: Braintree](#107-gate-type-braintree)
    - [Gate Type: PayPal](#108-gate-type-paypal)
    - [Editing & Fine-Tuning Gates](#109-editing--fine-tuning-gates)
    - [Testing a Gate](#1010-testing-a-gate)
    - [Troubleshooting Gates](#1011-troubleshooting-gates)
11. [Gate Setup — လမ်းညွှန် (မြန်မာ)](#11-gate-setup--လမးညွှန-မြနမာ)
    - [နည်းလမ်း ၁: Auto-Detect](#111-နညးလမး-၁-auto-detect)
    - [နည်းလမ်း ၂: Bulk URL Scan](#112-နညးလမး-၂-bulk-url-scan)
    - [နည်းလမ်း ၃: Manual Setup](#113-နညးလမး-၃-manual-setup)
    - [Browser DevTools မှ Key များရှာနည်း](#114-browser-devtools-မှ-key-များရှာနညး)
    - [Gate အမျိုးအစားအလိုက် Setup](#115-gate-အမျိုးအစားအလိုက-setup)
    - [Gate တည်းဖြတ်ခြင်းနှင့် ပြင်ဆင်ခြင်း](#116-gate-တညးဖြတခြငးနှင-ပြငဆငခြငး)
    - [Gate စမ်းသပ်ခြင်းနှင့် ပြဿနာဖြေရှင်းခြင်း](#117-gate-စမးသပခြငးနှင-ပြဿနာဖြေရှငးခြငး)

---

## 0. V8.0 — What's New

V8 is a robustness + tooling release. The check pipeline itself didn't change shape, but the verdict-quality, error-handling, and admin-workflow layers got an overhaul. Everything below is shipping in `main`.

### 0.1 New checker modules

| File | What it does |
|---|---|
| `server/payeezy-checker.ts` | First Data Payeezy WC plugin (PCI fields posted to `add-payment-method` page). Ported from `Atachement/Payezzy Auth.py`. |
| `server/captcha-solver.ts` | 2captcha + Anti-Captcha integration. Solves Cloudflare Turnstile, hCaptcha, reCAPTCHA v2. Polled with an 8 s initial wait + 5 s interval, 2 min timeout. |
| `server/site-cache.ts` | Two in-process maps: `SiteCooldownTracker` (per-host rate limiter, jittered delay grows with 429/5xx/captcha hits, resets on clean 2xx) and `CachedSession` (5 min TTL for cookies/pk/acct/nonces — survives within a check burst). |

### 0.2 Checker robustness upgrades

- **Braintree response-code table** — full `_BT_RESPONSE_CODES` from `braintree_gate.py` ported into both `response-codes.ts` and `braintree-checker.ts`. Codes **2001, 2002, 2003, 2010, 2061, 2069, 2079, 2090** now classify as `live` (insufficient funds, CVV/AVS mismatch, PayPal pending/consent) instead of being grouped into the dead bucket. 5-digit validation codes 81706–81725 covered.
- **BIN lookup** — primary now `https://bins.antipublic.cc/bins/{prefix}` (richer than binlist: level, country flag, emoji), with `lookup.binlist.net` retained as fallback.
- **Site-level rate gating** — `sessionFetch` calls `waitSiteCooldown(url)` at the top of every attempt. Blocks (403/429/5xx and captcha pages) bump a per-host counter; successes reset it. Sleep windows: 50–200 ms after 1 check, up to 500–1500 ms after 3+ blocks.
- **HTTP error funnel** — `sessionFetch` catches captcha pages (SiteGround `sgcaptcha`, Cloudflare PoW, Cloudflare Turnstile, CF JS challenge) and either solves them inline (PoW) or escalates to the external solver (Turnstile/hCaptcha) when a per-gate API key is configured.
- **WHMCS Stripe Auth: `wallet_config_id`** — page-scraped UUID (manual override allowed) plus the full `client_attribution_metadata` quad (`client_session_id`, `merchant_integration_source/subtype/version`, `wallet_config_id`) is now injected into PM tokenize, SI confirm, and direct seti-confirm bodies. Cuts the "integration_surface" rejection rate.
- **GiveWP** — subscription mode (`donationType=subscription` adds `setup_future_usage=off_session` to classic + v3 donate routes) and Stripe-Connect `acct_…` extraction (passed as `_stripe_account=` URL param, not header).
- **GiveWP nonce auto-retry** — when classic submission returns `give_error_donation_form_nonce` / `unable to recognize your session` / `refresh the screen` / `nonce verification failed`, the checker now:
  1. Re-fetches the donate page *in the same session* → fresh `give-form-hash` bound to current cookies
  2. Re-tokenizes the card (Stripe tokens are single-use; the failed POST consumed the first)
  3. Updates `give-form-hash`, `give-form-nonce`, `give_checkout_nonce`, `give_token` and retries the POST once
  Three hash patterns supported: standard `name="give-form-hash"`, per-form `name="give-form-{id}-hash"`, and minified-JS `"give-form-hash":"…"`.
- **GravityForms** — primary action is now `gfstripe_validate_form` (ref: `شرح الكورس2.py`), which is what modern GF+Stripe sites actually expose. Extracts `state_2`, `version_hash`, `feed_id`, and the stripe-temp `hash=` from the donate page; falls back to the old `gfstripe_create_payment_intent` / `gf_stripe_create_payment_intent` variants for older installs.
- **Stripe live-signal classifier** — confirmed `card_velocity_exceeded`, `withdrawal_count_limit_exceeded`, `insufficient_funds`, `incorrect_zip`, `cvc_check_failed`, `online_or_offline_pin_required` are all classified as `live`.
- **Process-level safety net** (`server/index.ts`) — `process.on("unhandledRejection")` and `process.on("uncaughtException")` log and keep the process alive. Stray promise rejections from telegram callbacks / undici fetches / drizzle drivers can no longer tank long mass-check runs.

### 0.3 New `GateExtras` fields (all flow UI → settings → `buildExtras` → checker)

| Field | Purpose |
|---|---|
| `donationType` | `"single"` or `"subscription"` — toggles GiveWP off_session subscription mode |
| `currency` | Override charge currency (USD/EUR/GBP/CAD/AUD/JPY/INR) |
| `connectedAccount` | Stripe `acct_…` Connect override (marketplaces / GiveWP / Charitable) |
| `ajaxNonce` | GiveWP AJAX nonce override (when page-scrape can't find it) |
| `gfPiNonce` | GravityForms PI nonce override |
| `btMerchantId` | Braintree merchant ID fallback for tokens that don't carry one |
| `addPmPath` | Override path for WC `/my-account/add-payment-method/` |
| `captchaProvider` | `"2captcha"` or `"anticaptcha"` |
| `captchaApiKey` | Solver service API key |
| `walletConfigId` | Manual `wallet_config_id` (WHMCS Stripe Auth) — wins over page-scrape |
| `rawCookies` | Pasted `Cookie:` header for pre-authenticated sessions (Payeezy-style) |
| `liveOverrides` / `deadOverrides` | Comma-separated keyword lists — force-classify matched responses |
| `proxyOverride` | Sticky proxy URL — bypasses the rotating pool for this gate |
| `testCardOverride` | Pin a specific test card for the dashboard's Test button |
| `autoValidate` | When true, save runs the test card immediately and keeps the dialog open with the result |

### 0.4 New backend endpoints

| Verb | Path | Purpose |
|---|---|---|
| `POST` | `/api/gates/scrape-hints` | Fetches a URL and regex-extracts pk_live, acct_, wcNonce, ajaxNonce, gfPiNonce, walletConfigId, giveFormId, gfFormId, captchaSiteKey |
| `GET` | `/api/gates/:id/health` | Returns `{checks10min, blocks, lastCheck}` from `siteCooldown` for that gate's host |
| `GET` | `/api/gates/:id/failure-suggestions` | Scans last 200 check results for the gate and returns rule-based reconfigure suggestions sorted by confidence (captcha missing, nonce errors → wcBlockCheckout, rate-limit → proxy pinning, no_pm_id → wcPaySlug, integration-surface → walletConfigId, 0 approvals → liveOverrides) |
| `GET` | `/api/sessions` | `{ sessions, cooldowns }` snapshot of the in-memory cache |
| `DELETE` | `/api/sessions` | Clear all cached sessions |
| `DELETE` | `/api/sessions/:hostname` | Clear one host's cache entry |

### 0.5 Configs page (dashboard) — new UI

- **Edit-dialog header** — `HINTS` button next to `RE-DETECT`. Calls `/api/gates/scrape-hints`, lists each extracted field with a per-row `APPLY` button so the admin can pick and choose.
- **Edit-dialog Advanced tab** — new sections: Donation Type & Currency; Stripe Connect / Manual Nonces; Braintree Overrides; Captcha Solver (provider + key); Manual Overrides (test card, wallet_config_id, raw cookies, sticky proxy); Response Classifier Overrides (force-live / force-dead textareas); Save Behavior (auto-validate toggle).
- **Edit-dialog Gate Health card** — refreshes every 10 s; shows checks/10 min, consecutive blocks (color-coded), seconds since last check, warning banner at blocks ≥ 3.
- **Edit-dialog Failure Pattern Analysis** — `ANALYZE` button on Advanced tab, fetches `/api/gates/:id/failure-suggestions`, shows each suggestion as a card with `APPLY` button.
- **Configs header** — `RE-DETECT ALL` button. Iterates every gate, calls `detect-url`, PATCHes with merged settings, shows live progress, toast summary.
- **Configs page panel** — Session Cache & Cooldown card: hostname list with pk/acct/nonce badges, per-host × button, `CLEAR ALL` action.
- **Gate Profiles** — localStorage-backed save/apply/delete named bundles of `gateType + subType + settings`. Panel appears in edit dialog header.

### 0.6 Telegram bot — new commands (all admin-only)

| Command | What it does |
|---|---|
| `/version` | Build header, supported gates, robustness features, AI key status, uptime, heap. |
| `/editgate [name]` | Inline-keyboard drill-down editor covering all ~40 gate fields. Categories: Basic, Keys, Billing, Amount, Forms/WC, Nonces, Braintree, Captcha, Proxy/Net, Overrides. Field types: text (typed reply), number (validated), csv (comma-split), bool (instant toggle), select (radio-list). Each field has a Clear button. Required top-level fields (`name`, `url`, `gateType`) can't be cleared. Per-admin `editContext` so multiple admins can edit simultaneously. |
| `/setaikey <key>` | Persist NVIDIA API key to `data/.nvidia-key` (mode 0600). Original message auto-deleted when bot has permission. `/setaikey clear` removes it. `/setaikey` (no args) shows masked current value + source (`env var` / `file` / `none`). |
| `/ai <prompt>` | Multi-turn chat with NVIDIA Llama-3.1-70B. Per-admin history capped at last 20 messages; `/ai reset` clears it. Replies chunked at 3800 chars; Markdown parse failures fall back to plain text. |
| `/aiconfig [name]` | One-tap AI gate auto-configurator. Picks gate → re-detects URL → scrapes page hints → asks the LLM for an optimal advanced config → shows preview with ✅ Apply / ✖️ Cancel / 🔍 Full Details buttons. Persists recommendation in `pendingAiConfig` so the admin can take their time deciding. |

### 0.7 Process & error hardening

- All `eg_*` (editgate) callbacks wrapped in `try/catch` that answers the callback and DMs the admin instead of bubbling.
- All `aic_*` (aiconfig) callbacks wrapped the same way.
- `setFieldValue` coerces `undefined` to `""` for nullable top-level columns; throws explicit "X is required" for `name`/`url`/`gateType`. Previously `undefined` could trigger NOT-NULL violations and take down the server when an admin cleared a top-level field.
- `process.on("unhandledRejection")` / `process.on("uncaughtException")` log and keep the process alive.

### 0.8 AI Console (`/ai` page)

A dedicated dashboard section that pulls every AI surface into one place. Sidebar entry between Gate Configs and Access Keys; status pill (green/red dot) next to `v8.0_FINAL` in the sidebar header polls `/api/ai/status` every 30 s.

**Cards on the page:**

1. **API Key** — masked current value, source badge (`ENV VAR` / `FILE` / `NONE`). Eye toggle, **SAVE** button (writes `data/.nvidia-key`, mode 0600), **REMOVE** button. Env-var source disables the inputs with an explanatory hint — unset the env var to manage from the UI.
2. **Status & Activity** — Model/Provider stats and scrollable feed of recent AI-related `system_logs` (`ai-key`, `ai-reconfigurer`, `ai-analyzer`, `aiconfig`).
3. **Chat** — inline conversation with NVIDIA Llama-3.1-70B (`/api/ai/chat` proxy). History saved to `localStorage` (last 40 msgs). Enter sends, Shift+Enter newlines.
4. **AI Analyzer** — see 0.9 below.
5. **AI Workflows** — quick links to Gate Reconfigurer (on Configs), Telegram `/aiconfig`, Telegram `/ai`, Failure Pattern Analysis (on Configs).

**Shared module: `server/ai-key.ts`** — `readAIKey` / `writeAIKey` / `clearAIKey` / `maskAIKey` / `aiKeySource`. Both `telegram-bot.ts` (for `/ai`, `/aiconfig`, `/setaikey`) and `routes.ts` (for the web endpoints) import from here. Saving via the web panel takes effect immediately for the next Telegram `/ai` invocation — same file.

**Endpoints:**

| Verb | Path | Notes |
|---|---|---|
| `GET` | `/api/ai/status` | `{ configured, masked, source, envVarPresent, canEdit, recentCount, recentEvents }` |
| `POST` | `/api/ai/key` | Body `{ key }`. 409 when env var is authoritative. Validates `[A-Za-z0-9_-]{10,}`. |
| `DELETE` | `/api/ai/key` | Wipes the file. 409 when env var is authoritative. |
| `POST` | `/api/ai/chat` | Body `{ messages: [{role, content}, …] }`. Last 20 truncated. Same model + system prompt as Telegram `/ai`. |

### 0.9 AI Analyzer — background failure learning loop

A **passive** loop on the AI Console that watches real gate failures and proposes setting changes. **Never auto-applies** — admin clicks `APPLY` per suggestion.

**Files:** `server/ai-analyzer.ts` (logic + state), `server/index.ts` (boot init).

**Cycle (runs every 10 min when toggled ON):**

1. **Candidate filter** — every active gate where the last 50 checks are >60% failures AND zero recent approvals. (Working gates aren't candidates even if slow.)
2. **Sampling** — 6 raw response excerpts (500 chars each) uniformly spaced through the failure window. These are the actual `response` field from `check_results` — the same string the dashboard shows in the recent-checks feed.
3. **LLM call** — Llama-70B with a prompt grounded in the actual checker field names plus pattern → fix rules:
   - Cloudflare/Turnstile HTML → `captchaProvider="2captcha"`
   - `nonce` / `session expired` / `refresh` → `wcBlockCheckout=true`
   - `429` / `rate limit` / `too many requests` → `proxyCountry` or `proxyOverride`
   - `integration_surface` / `invalid_request_error` / `publishable key` → reset `walletConfigId`
   - Same bank decline code repeated → add to `liveOverrides`
   - "Payment processing failed" with no decline_code → likely missing `wcPaySlug`
4. **Suggestion stored** with confidence, reason, sample list, status=`pending`.

**Safety:**

- **Cost cap** — at most 5 LLM calls per cycle.
- **De-dup** — gates with a pending suggestion <30 min old are skipped.
- **Ring buffer** — top 50 suggestions retained, oldest dropped first.
- **Persistence** — state in `data/.ai-analyzer.json` (mode 0600). Boot restarts the loop if `enabled=true`.
- **System log entry per cycle** (source=`ai-analyzer`) so the action is auditable.

**Endpoints:**

| Verb | Path | Notes |
|---|---|---|
| `GET` | `/api/ai/analyzer/status` | `{ enabled, lastRunAt, lastRunStatus, cycleCount, suggestionCount, pendingCount }` |
| `POST` | `/api/ai/analyzer/toggle` | Body `{ enabled: bool }`. Rejected when AI key isn't set. |
| `POST` | `/api/ai/analyzer/run` | Manual one-shot cycle (RUN NOW button). |
| `GET` | `/api/ai/suggestions` | All suggestions, pending first. |
| `POST` | `/api/ai/suggestions/:id/apply` | Merges proposed `changes` into `gate.settings`. Returns `{ applied: N }`. |
| `POST` | `/api/ai/suggestions/:id/dismiss` | Marks dismissed; analyzer can re-suggest after 30 min. |

**UI (AI Analyzer card on `/ai`):**

- ON/OFF switch + **RUN NOW** button, **RUNNING** pill when active.
- Four stat tiles: Cycles, Suggestions total, Pending, Last run timestamp.
- Last-run status line ("scanned 4 candidates, 2 new suggestions, 2 skipped").
- Suggestion feed per card:
  - Gate name · failure% · confidence% · time
  - One-line analysis from the LLM
  - Yellow rationale line
  - Proposed setting chips (`captchaProvider=2captcha`, etc.)
  - **APPLY** / **DISMISS** buttons (pending only)
  - Expandable "Show N raw response samples" block — `<pre>` blocks of the actual truncated response strings the LLM was looking at

### 0.10 Why some gates from the references are still pending

These are sketched in the gap analysis but not yet ported — each is large enough to warrant its own session with a known-good test target:

- ~~Shopify PCI Checkout~~ — **shipped in V8.5** (see § 0.11)
- BigCommerce + Braintree (Stencil `x-sf-csrf-token` → checkoutId → BT TokenizeCreditCard → bigcommerce orders/payments).
- WC Stripe `wc_stripe_create_and_confirm_setup_intent` variant (Riva.py — different from our standard WC Stripe path).
- GiveWP PayPal Commerce + Donorbox guest credit-card.
- Full WC Braintree Cardinal 3DS lookup flow.

---

## 0.11 V8.5 — Reference-Script Audit + Shopify Gate

A focused quality release. No new large flows; instead every existing checker was audited against its Python reference implementation and the gaps were closed.

### 0.11.1 New gate: Shopify PCI

**File:** `server/shopify-checker.ts`  
**Type:** `shopify`, sub-types: `pci` (default), `standard`

Three-step flow ported from `Shopify 10$.py`:

| Step | What happens |
|---|---|
| **PCI Tokenise** | `POST https://checkout.pci.shopifyinc.com/sessions` — sends raw card data, receives a `sessionId` |
| **SubmitForCompletion** | `POST {site}/checkouts/unstable/graphql` with `SubmitForCompletion` GQL mutation — returns `receiptId` |
| **PollForReceipt** | Same GQL endpoint, `PollForReceipt` query × 2 with 5 s sleep between — reads final verdict |

**Live signals** (`SHOPIFY_PCI_LIVE_SIGNALS`):  
`insufficient_funds`, `do_not_honor`, `card_velocity_exceeded`, `authentication_required`, `call_issuer`, `try_again_later`, `incorrect_cvc`, `cvc_check_failed`, `incorrect_zip`, `PAYMENTS_CREDIT_CARD_BASE_EXPIRED`, `CAPTCHA_METADATA_MISSING`, `OrderCreationSucceeded`, `READY`

**Dead signals** (`SHOPIFY_PCI_DEAD_SIGNALS`):  
`incorrect_number`, `invalid_number`, `PAYMENTS_CREDIT_CARD_BASE_INVALID_NUMBER`, `PAYMENTS_CREDIT_CARD_BASE_INVALID_EXPIRY`, `fraudulent`, `stolen_card`, `lost_card`, `pickup_card`, `PAYMENT_CANCELLED`, `DECLINED`

**ShopifyExtras:**
| Field | Purpose |
|---|---|
| `productHandle` | Specific Shopify product handle to add to cart |
| `checkoutScope` | Override `*.myshopify.com` scope (default: derived from siteUrl) |
| `proxyOverride` | Sticky proxy URL |
| `proxyCountry` | Country for pool proxy selection |
| `timeout` | Timeout in ms for GQL requests (default 20 000) |

**Gate config required fields:**
- `siteUrl` — the Shopify store URL (e.g. `https://store.myshopify.com`)

---

### 0.11.2 Reference-script classification fixes

All four checker files were diffed against their Python source (`Atachement/*.py`):

| File | Fix |
|---|---|
| `stripe-checker.ts` | `"your card was declined"` → `isLive: true`. The HTML phrase means the bank declined the transaction — the card number is real. Previously classified dead. |
| `stripe-checker.ts` | GiveWP subscription body now includes `subscriptionPeriod=month` + `subscriptionFrequency=1`. Required by the GiveWP Recurring plugin; omitting them silently rejects the donation. |
| `stripe-checker.ts` | `tokenizeCard` (split-card-element flow) now sends the full `client_attribution_metadata` quad: `client_session_id`, `merchant_integration_source`, `merchant_integration_subtype`, `merchant_integration_version`. Was completely absent. |
| `stripe-checker2.ts` | `billingFallback.first`/`.last` → `rndName()` split. `BILLING_DATA` objects have `city/state/zip/country/line1` — never `first`/`last`; fallback was always `"Test"/"User"`. |
| `stripe-checker2.ts` | Generic `buildAjaxBody` branch now sends `billing_first_name` + `billing_last_name`. Was missing, causing 100% of admin-ajax generic-branch checks to POST an anonymous name. |
| `stripe-checker2.ts` | `tokenizeCard` now accepts and uses a `timeout?: number` parameter instead of hard-coding 12 000 ms. Call site passes `extras.timeout`. |
| `paypal-checker.ts` | `paypal-client-metadata-id: {uuid}` header added to `confirm-payment-source` POST. PayPal CORS API requires it to tie the verification to a client session. |
| `paypal-checker.ts` | Vault fallback (`_ppVaultOnlyCheck`) — 3 raw `fetch()` calls now route through `getProxyDispatcher`. Previously bypassed proxy entirely. |
| `braintree-checker.ts` | BigCommerce Stencil step 7 (order submit → JWT) applies proxy dispatcher. Was the only Stencil step missing proxy coverage. |
| `braintree-checker.ts` | BigCommerce Stencil step 9 (`payments.bigcommerce.com`) applies proxy dispatcher. External API call now honours `proxyCountry`/`proxyOverride`. |
| `braintree-checker.ts` | Added BT processor codes 2091 (Voice Authorization Required → **live**) and 2092 (Destination Bank Cannot Process → **dead**). |

---

### 0.11.3 BIN blacklist

**File:** `server/checker.ts` — runs before any gateway call.

```
gate.settings.binBlacklist = "400000, 411111, 555555"
```

If a card's first 6 digits start with any comma-separated prefix in `binBlacklist`, the check is rejected immediately with:
```
BIN 400000 blacklisted (prefix: 400000)
```

No proxy used, no API charge. Useful for skipping known test BINs, bank-specific ranges that always 3DS, or BINs that trigger specific gateway fraud rules.

---

### 0.11.4 Gate config UI additions (Advanced tab)

| Section | New fields |
|---|---|
| **BIN Blacklist** | Textarea — comma-separated BIN prefixes that skip the gateway entirely |
| **Braintree Overrides** | Flow selector: Auto / WC Add-PM / WC Checkout / BigCommerce Stencil (was JSON-only before) |
| **Donation Gate Overrides** | `donatePath` (page path override), `donateAmount` ($), `donationType` (Single vs Subscription with helper explaining the SetupIntent bypass) |

The **flow guide card** (between sub-type selector and Target URL) shows a `READY` badge or a per-field ✓/✗/· status for every field the selected flow needs. `siteUrl` correctly resolves from `editGate.url` (was always showing "required" before).

---

## 1. Project Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Browser / Telegram                │
└────────────────────┬────────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────▼────────────────────────────────┐
│              Express Server  (server/)              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  routes  │  │  vite    │  │  telegram-bot     │  │
│  │  .ts     │  │  (dev)   │  │  .ts              │  │
│  └────┬─────┘  └──────────┘  └───────────────────┘  │
│       │                                              │
│  ┌────▼──────────────────────────────────────────┐  │
│  │  stripe-checker.ts  ·  stripe-hitter.ts       │  │
│  │  gate-detector.ts   ·  browser-hitter.ts      │  │
│  │  card-generator.ts  ·  response-codes.ts      │  │
│  └────┬──────────────────────────────────────────┘  │
│       │                                              │
│  ┌────▼──────────┐  ┌─────────────────────────────┐  │
│  │  storage.ts   │  │  db.ts (Drizzle ORM / PG)   │  │
│  └───────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              React Frontend  (client/src/)          │
│  pages/: Dashboard  CardChecker  Hitter  Configs    │
│           Proxies   Keys   Users  CardGen  Miner    │
│           BotSettings  Handbook                     │
└─────────────────────────────────────────────────────┘
```

**Tech stack:**
| Layer | Technology |
|---|---|
| Server | Node.js + Express 5, TypeScript via tsx |
| Frontend | React 19, TailwindCSS v4, shadcn/ui, Wouter |
| Database | PostgreSQL + Drizzle ORM |
| Build | Vite 7 (dev HMR), esbuild (prod bundle) |
| Bot | node-telegram-bot-api |
| Proxy | undici ProxyAgent (HTTP CONNECT tunneling) |

**Supported Payment Gateways:**
| Gateway | Sub-Types / Flows |
|---|---|
| Stripe | `payment_intents`, `charges`, `auth`, `checkout_session`, `stripe_page_confirm`, `wc_stripe_confirm_setup_intent` |
| Stripe (forms) | `charitable`, `givewp` (v2 classic), `givewp_v3` (REST), `gravityforms` |
| WooCommerce admin-ajax | Any `ajaxAction` — auto-detects GiveWP / Charitable / WC / Generic body shape |
| Braintree | `wc_braintree_addpm` (add-PM vault), `wc_braintree` (checkout), `bigcommerce_stencil` (9-step Stencil flow) |
| Shopify | PCI tokenise → SubmitForCompletion GQL → PollForReceipt GQL |
| PayPal | GiveWP PayPal Commerce, WC PPCP, Vault fallback |
| Payeezy | First Data Payeezy WC plugin (PCI fields → add-payment-method) |

---

## 2. Startup Guide

### 2.1 Termux (Android)

> **One command does everything** — installs system packages, PostgreSQL,
> Node.js dependencies, and starts the server.

```bash
# First time (or after updating source files):
python start.py

# Production mode (optimised build):
python start.py --prod

# Custom port:
python start.py --port 8080

# Skip npm install if deps are already good:
python start.py --dev
```

**What `start.py` does automatically:**

1. Detects `/storage/emulated/0` shared storage → copies project to
   `~/h0-panel` (ext4 supports symlinks; shared storage does not)
2. Installs missing Termux packages: `nodejs-lts postgresql make clang rsync`
3. Starts PostgreSQL on unix socket `$PREFIX/var/run/postgresql`
4. Creates `h0checker` database
5. Runs `npm install`; if `bcrypt` native build fails → uninstalls it,
   installs `bcryptjs` (pure-JS, identical API), patches server imports
6. Launches the dev server via `./node_modules/.bin/tsx server/index.ts`

**Accessing the panel from another device on the same Wi-Fi:**
```
http://192.168.x.x:5000      (IP shown in startup output)
```

---

### 2.2 Linux / macOS

```bash
# Prerequisites (Ubuntu/Debian):
sudo apt install nodejs npm postgresql

# Prerequisites (macOS):
brew install node postgresql

# Start PostgreSQL (Linux):
sudo systemctl start postgresql

# Run the app:
python start.py

# Or manually without the script:
export DATABASE_URL="postgresql://localhost:5432/h0checker"
npm install
npx tsx server/index.ts
```

---

### 2.3 Windows

```powershell
# Install Node.js from https://nodejs.org/
# Install PostgreSQL from https://postgresql.org/download/windows/

$env:DATABASE_URL = "postgresql://localhost:5432/h0checker"
npm install
npx tsx server/index.ts
```

> **Tip:** Use `python start.py --skip-pg` if you have a remote PostgreSQL
> (e.g., Neon, Supabase, Railway) and set `DATABASE_URL` in your shell.

---

### 2.4 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `PORT` | ❌ | Server port (default: `5000`) |
| `NODE_ENV` | ❌ | `development` or `production` |
| `CAPSOLVER_API_KEY` | ❌ | Auto-solve hCaptcha (Stripe hitter) |
| `CHROMIUM_PATH` | ❌ | Full path to Chromium binary (browser mode) |
| `DEBUG_CHECKER` | ❌ | Set to `1` for verbose hitter logs |
| `PUPPETEER_SKIP_DOWNLOAD` | auto | Set by `start.py` on Termux |

**Set a permanent DATABASE_URL in Termux:**
```bash
echo 'export DATABASE_URL="postgresql:///h0checker?host=/data/data/com.termux/files/usr/var/run/postgresql"' >> ~/.bashrc
source ~/.bashrc
```

---

## 3. Common Problems & Fixes

### ❌ `EACCES: permission denied, symlink` during npm install

**Cause:** Project is on Android shared storage (`/storage/emulated/0`) which
doesn't support symlinks. npm can't create `node_modules/.bin/` links.

**Fix:** `start.py` auto-detects this and copies to `~/h0-panel`. Make sure
you run `python start.py` from any location — it handles the copy.

```bash
# Manual fix if needed:
cp -r /storage/emulated/0/YourProject ~/h0-panel
cd ~/h0-panel
npm install
```

---

### ❌ `No native build was found for platform=android arch=arm` (bcrypt)

**Cause:** `bcrypt` uses native C++ bindings with no prebuilt ARM binary.

**Fix:** `start.py` automatically detects and fixes this by replacing `bcrypt`
with `bcryptjs` (pure-JS, identical API). Run `python start.py` and it will
self-heal on every startup.

**Manual fix:**
```bash
cd ~/h0-panel
npm uninstall bcrypt
npm install bcryptjs@latest
# Then edit server/routes.ts:
sed -i 's/from "bcrypt"/from "bcryptjs"/g' server/routes.ts
```

---

### ❌ `Cannot find package 'express'` when starting tsx

**Cause:** `node_modules` is missing or the working directory is wrong.

**Fix:**
```bash
cd ~/h0-panel       # must be in the project root
npm install
./node_modules/.bin/tsx server/index.ts
```

---

### ❌ `DATABASE_URL must be set` or database connection refused

**Cause:** PostgreSQL isn't running or `DATABASE_URL` isn't set.

**Fix (Termux):**
```bash
# Start PostgreSQL manually:
pg_ctl -D $PREFIX/var/lib/postgresql \
       -l $PREFIX/var/lib/postgresql/logfile \
       -o "-k $PREFIX/var/run/postgresql" start

# Verify it's running:
pg_isready -h $PREFIX/var/run/postgresql

# Set the URL for this session:
export DATABASE_URL="postgresql:///h0checker?host=/data/data/com.termux/files/usr/var/run/postgresql"
```

**Fix (Linux):**
```bash
sudo systemctl start postgresql
export DATABASE_URL="postgresql://localhost:5432/h0checker"
createdb h0checker    # if database doesn't exist
```

---

### ❌ `drizzle-kit push` hangs at startup

**Cause:** Older drizzle-kit versions prompt for confirmation interactively.

**Fix:** Already applied — `server/index.ts` uses `--force` flag:
```typescript
execSync("npx drizzle-kit push --force", { stdio: "pipe" });
```

---

### ❌ Frontend crashes with `<Select.Item /> must have a value prop that is not an empty string`

**Cause:** Radix UI forbids `<SelectItem value="">`. Use a sentinel like `"_none_"`.

**Fix:** Already patched. If you add new Select components, use:
```tsx
<SelectItem value="_none_">None</SelectItem>
// in onValueChange:
onValueChange={(v) => setFoo(v === "_none_" ? undefined : v)}
```

---

### ❌ Server crashes on every frontend error

**Cause:** `server/vite.ts` had `process.exit(1)` in the Vite error logger.

**Fix:** Already removed. The server now logs frontend errors without dying.

---

### ❌ Browser mode crashes on Termux (Puppeteer / Chromium)

**Cause:** Puppeteer requires Chromium which is not installed by default on Termux.

**Fix:** Browser mode auto-disables when no Chromium is found. The hitter falls
back to API mode automatically. To enable browser mode on Termux:
```bash
pkg install chromium
export CHROMIUM_PATH=$(which chromium-browser)
```

---

### ❌ Vite HMR not connecting (`/vite-hmr` WebSocket fails)

**Cause:** Normal when accessing from a different device than localhost.

**Fix:** This is cosmetic — HMR works within the same machine. Hot reload
still functions; the WS warning can be ignored when accessing from mobile.

---

### 🔄 Resetting the database

```bash
# Via the web panel (Dashboard → System Reset → enter admin password)

# Or via start.py:
python start.py --reset-db

# Or manually:
dropdb h0checker && createdb h0checker
# Then restart the server (drizzle auto-recreates schema on boot)
```

---

## 4. Core Code Guide

### 4.1 Adding a New Gate Type

**Step 1 — Register the type in `server/routes.ts`:**
```typescript
// Find the /api/gates/types endpoint (~line 114)
{ id: "mygate", name: "MyGate", subtypes: ["standard", "v2"] },
```

**Step 2 — Add color in `client/src/pages/Configs.tsx`:**
```typescript
// Find getGateColor() function
const colors: Record<string, string> = {
  // ... existing entries ...
  mygate: "border-cyan-400 text-cyan-400",
};
```

**Step 3 — Add checking logic in `server/stripe-checker.ts`:**
```typescript
export async function checkCardMyGate(
  cardNumber: string, month: string, year: string, cvv: string,
  apiKey: string, gateName: string, siteUrl: string
): Promise<CheckResult> {
  const start = Date.now();
  // ... your HTTP check logic here ...
  return {
    status: "live",   // "live" | "dead" | "error"
    response: "CVV MATCH",
    code: "approved",
    latency: Date.now() - start,
    gate: gateName,
  };
}
```

**Step 4 — Wire it up in `server/routes.ts` (POST /api/checks):**
```typescript
// Find the section that checks gateType
} else if (gateType === "mygate" && gateSettings.apiKey) {
  checkResult = await checkCardMyGate(
    parsed.number, parsed.month, parsed.year, parsed.cvv,
    gateSettings.apiKey, gateName, gateSettings.siteUrl || ""
  );
}
```

**Step 5 — Add detector signals in `server/gate-detector.ts`:**
```typescript
// In analyzeHtml(), add scoring:
if (/mygate\.js|MyGateSDK/i.test(html)) {
  mygateScore += 25;
  signals.push("MyGate SDK detected");
}
const mgKeyMatch = html.match(/mg_key_[a-zA-Z0-9]+/);
if (mgKeyMatch) {
  settings.apiKey = mgKeyMatch[0];
  signals.push(`MyGate API Key: ${mgKeyMatch[0].slice(0, 10)}...`);
  mygateScore += 40;
}
```

---

### 4.2 Modifying Card Checker Logic

**Key file:** `server/stripe-checker.ts`

**Decline code classification** (controls `LIVE` vs `DEAD` detection):
```typescript
// ~line 53 — add/remove codes to change what counts as "live"
const CCN_LIVE_CODES = [
  "insufficient_funds",   // ← card is valid, just no funds
  "do_not_honor",
  "generic_decline",
  // add your codes here
];

const DEAD_CODES = [
  "expired_card",
  "incorrect_number",
  // cards with these codes are definitively dead
];
```

**Response message format** (what the user sees):
```typescript
// Find the section building the response string
// Format: "STATUS | CardBrand ...last4 | BankName | OptionalNote"
// Example: "CVV MATCH ✓ | VISA ...4242 | Chase Bank"
```

**Adding a new check method** (e.g., GiveWP-style form):
```typescript
export async function checkCardMyForm(
  num: string, mon: string, yr: string, cvv: string,
  publicKey: string, gateName: string, siteUrl: string,
  formId?: string
): Promise<CheckResult> {
  // 1. Tokenise the card via Stripe.js API simulation
  const tokenRes = await fetch("https://api.stripe.com/v1/tokens", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${publicKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "card[number]": num,
      "card[exp_month]": mon,
      "card[exp_year]": yr,
      "card[cvc]": cvv,
    }).toString(),
  });
  const token = await tokenRes.json();
  if (token.error) return { status: "dead", response: token.error.message, ... };

  // 2. Submit the token to the form endpoint
  // ... site-specific POST logic ...
}
```

---

### 4.3 Stripe Hitter

**Key file:** `server/stripe-hitter.ts`

**How it works:**
1. `parseCheckoutLink(url)` — fetches the checkout page, extracts `publishableKey`, `paymentIntentClientSecret`, `amount`, `mode`
2. `hitCheckoutWithCard(session, cardStr)` — tokenises the card, confirms the payment intent
3. `hitCardsParallel(session, cards, concurrency)` — runs multiple cards concurrently

**Changing device fingerprints** (to avoid Stripe fraud detection):
```typescript
// ~line 155 — DEVICE_PROFILES array
const DEVICE_PROFILES = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
    secChUa: '"Chromium";v="131"...',
    secChUaPlatform: '"Windows"',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    // Add more profiles here for better rotation
  },
];
```

**Adding a custom confirm delay** (mimics human pace):
```typescript
// confirmDelay is already supported — pass it from the frontend
// In hitCheckoutWithCard():
if (confirmDelay > 0) {
  await new Promise(r => setTimeout(r, confirmDelay));
}
```

**Supporting a new Stripe checkout variant:**
```typescript
// In parseCheckoutLink(), look for the JSON blob:
// cs_live_... pages have different structure than payment_link pages
// Add detection in the parsing section (~line 400):
if (html.includes("__stripe_data__")) {
  // custom extraction logic
}
```

---

### 4.4 Gate Auto-Detector

**Key file:** `server/gate-detector.ts`

**How scoring works:**
- Each crawled page's HTML is analysed by `analyzeHtml()`
- Scores accumulate across all crawled paths
- Highest scorer wins: `stripe > braintree > paypal > square`

**Adding detection for a new gateway:**
```typescript
// In analyzeHtml(), add a new score variable and patterns:
let mygateScore = 0;

if (/mygate\.com\/sdk/i.test(html)) {
  mygateScore += 30;
  signals.push("MyGate SDK loaded");
}
if (/MG\.init\s*\(/i.test(html)) {
  mygateScore += 20;
  signals.push("MyGate init call found");
}
const mgKeyMatch = html.match(/mg_pub_[a-zA-Z0-9]+/);
if (mgKeyMatch) {
  settings.mgPublicKey = mgKeyMatch[0];
  mygateScore += 40;
  signals.push(`MyGate key: ${mgKeyMatch[0].slice(0,15)}...`);
}

// Return it with the others:
return { stripeScore, braintreeScore, paypalScore, squareScore, mygateScore };
```

**Adding new crawl paths** (paths the detector visits on each site):
```typescript
// ~line 11 — CRAWL_PATHS array
const CRAWL_PATHS = [
  "/",
  "/checkout/",
  "/my-account/add-payment-method/",
  "/donate/",
  "/your-new-path/",   // ← add here
];
```

**Extracting additional settings from HTML:**
```typescript
// In analyzeHtml(), add extraction:
const myNonceMatch = html.match(/my_nonce["':\s]+["']([a-f0-9]+)["']/i);
if (myNonceMatch) {
  settings.myNonce = myNonceMatch[1];
  signals.push(`My nonce: ${myNonceMatch[1].slice(0,8)}...`);
}
```

---

### 4.5 Database Schema

**Key file:** `shared/schema.ts`

**Adding a new column to an existing table:**
```typescript
// In shared/schema.ts, e.g. adding "checkType" to checkResults:
export const checkResults = pgTable("check_results", {
  // ... existing columns ...
  checkType: text("check_type").default("standard"),  // ← add this
});
```

**After changing the schema, apply it:**
```bash
# The server auto-runs drizzle-kit push on startup,
# but you can also run it manually:
npx drizzle-kit push --force
```

**Adding a new table:**
```typescript
// In shared/schema.ts:
export const myNewTable = pgTable("my_new_table", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});
export const insertMyNewTableSchema = createInsertSchema(myNewTable).omit({ id: true, createdAt: true });
export type MyNewTable = typeof myNewTable.$inferSelect;
export type InsertMyNewTable = z.infer<typeof insertMyNewTableSchema>;
```

**Adding storage methods in `server/storage.ts`:**
```typescript
// Add to IStorage interface:
getMyItems(): Promise<MyNewTable[]>;
createMyItem(data: InsertMyNewTable): Promise<MyNewTable>;

// Add implementation to the DatabaseStorage class:
async getMyItems() {
  return await db.select().from(myNewTable).orderBy(desc(myNewTable.createdAt));
}
async createMyItem(data: InsertMyNewTable) {
  const [item] = await db.insert(myNewTable).values(data).returning();
  return item;
}
```

---

### 4.6 API Routes

**Key file:** `server/routes.ts`

**Adding a new API endpoint:**
```typescript
// In registerRoutes(), add after existing routes:
app.get("/api/my-endpoint", async (req, res) => {
  try {
    const data = await storage.getMyItems();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/my-endpoint", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: "name required" });
  const item = await storage.createMyItem({ name });
  res.json(item);
});
```

**Using the endpoint in React:**
```typescript
// In any page component:
const { data } = useQuery({ queryKey: ["/api/my-endpoint"] });

const createMutation = useMutation({
  mutationFn: async (name: string) => {
    const res = await apiRequest("POST", "/api/my-endpoint", { name });
    return res.json();
  },
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/my-endpoint"] }),
});
```

**Adding an SSE (streaming) endpoint** (like bulk gate setup):
```typescript
app.post("/api/my-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  for (const item of req.body.items) {
    send({ status: "processing", item });
    await doWork(item);
    send({ status: "done", item, result: "ok" });
  }
  send({ status: "complete" });
  res.end();
});
```

**Consuming SSE in React:**
```typescript
const res = await fetch("/api/my-stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ items }),
});
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n"); buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    // handle event
  }
}
```

---

### 4.7 Telegram Bot Commands

**Key file:** `server/telegram-bot.ts`

**Adding a new bot command:**
```typescript
// Find the section with bot.onText() handlers and add:
bot.onText(/\/mycommand(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const arg = match?.[1]?.trim() || "";
  const botUser = await storage.getBotUser(chatId);
  
  if (!botUser) {
    return bot!.sendMessage(chatId, "❌ Not registered. Use /start");
  }
  
  // Your logic here
  await bot!.sendMessage(chatId, `✅ Done: ${arg}`, { parse_mode: "Markdown" });
});
```

**Sending a notification to the channel:**
```typescript
// Already available via notifyLiveCardToChannel() — called automatically
// for any approved card result.
// For custom channel messages:
import { bot } from "./telegram-bot"; // (export bot if needed)
await bot.sendMessage(settings.chatId, "your message", { parse_mode: "Markdown" });
```

**Admin-only commands:**
```typescript
bot.onText(/\/adminonly/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const botUser = await storage.getBotUser(chatId);
  const isAdminUser = await checkAdmin(chatId, botUser);
  
  if (!isAdminUser) {
    return bot!.sendMessage(chatId, "🔒 Admin only.");
  }
  // admin logic
});
```

---

### 4.8 Frontend Pages

**Key file:** `client/src/pages/` (one file per page)

**Adding a new page:**

1. Create `client/src/pages/MyPage.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MyIcon } from "lucide-react";

export default function MyPage() {
  const { data } = useQuery({ queryKey: ["/api/my-endpoint"] });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-display font-bold text-foreground glitch-text">
          My Page
        </h2>
        <p className="text-muted-foreground font-mono mt-1">Description</p>
      </div>
      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-primary/20 bg-primary/5">
          <CardTitle className="font-display tracking-widest text-lg flex items-center gap-2">
            <MyIcon className="w-5 h-5 text-primary" />
            Section Title
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          {/* content */}
        </CardContent>
      </Card>
    </div>
  );
}
```

2. Register the route in `client/src/App.tsx`:
```tsx
import MyPage from "@/pages/MyPage";
// ...
<Route path="/mypage">
  <ProtectedRoute component={MyPage} />
</Route>
```

3. Add to sidebar in `client/src/components/layout/Sidebar.tsx`:
```tsx
{ href: "/mypage", label: "My Page", icon: MyIcon },
```

**Styling conventions:**
```
glass-panel       — card background with glass effect
rounded-none      — sharp corners (consistent with design)
font-display      — headings
font-mono         — data, labels, badges
text-primary      — green accent (#00ff80)
text-accent       — yellow accent
glitch-text       — animated glitch effect on headings
custom-scrollbar  — styled scrollbar
```

---

## 5. Proxy System

### 5.1 Scrub Sources

**SCRUB SOURCES** fetches proxies from 25 public proxy lists, deduplicates them
against your existing pool, randomly samples up to 500 new candidates, tests each
one for real connectivity via undici ProxyAgent (6s timeout against `httpbin.org/ip`),
and adds only the live ones with measured latency.

**How it works internally** (`POST /api/proxies/scrub`):
1. Fetch all 25 source URLs in parallel (10s timeout per source)
2. Parse `ip:port` lines from each response (regex validated)
3. Deduplicate across all sources → typically 3,000–8,000 unique proxies
4. Skip any proxy already in your pool (`ip:port` match)
5. Shuffle remaining and take up to 500 candidates
6. Test in parallel batches of 50 via `testProxyConnectivity()`
7. Add live ones to DB with `status: "live"`, real `latency`, and `lastChecked`
8. Invalidate the in-memory proxy cache so checker picks up new proxies immediately

**Proxy sources** (hardcoded in `server/routes.ts`):
- `api.proxyscrape.com` (HTTP + HTTPS)
- 20+ GitHub raw proxy list repos (TheSpeedX, monosans, mmpx12, etc.)
- `proxy-list.download`, `openproxylist.xyz`, `proxyspace.pro`

**Tip:** Public proxies die fast. Scrub regularly (daily) to keep the pool fresh.
Each scrub tests a different random sample, so repeated scrubs find different live proxies.

---

### 5.2 Wash Pool

**WASH POOL** re-tests every proxy already in your pool for connectivity. Updates
each proxy's `status` (live/dead), `latency`, and `lastChecked` timestamp.

**How it works** (`POST /api/proxies/wash`):
1. Loads all proxies from the database
2. Tests in parallel batches of 20 (6s timeout, supports auth proxies)
3. Updates each proxy record in-place via `storage.updateProxy()`
4. Invalidates proxy cache

**Workflow:** SCRUB to fill pool → WASH to verify → CLEAR DEAD to purge → repeat.

---

### 5.3 How Proxies Work in Checking

When proxy routing is **enabled** (`/api/proxy-config`), the checker routes each
request through the next live proxy in rotation:

```
getProxy()  →  round-robin from _liveProxies (60s cache from DB)
    ↓
getProxyDispatcher(url)  →  undici ProxyAgent(url)  (cached per URL)
    ↓
sessionFetch(url, opts)  →  undici.fetch(url, { dispatcher: agent })
    ↓
on failure  →  blacklist proxy for 60s, retry request direct (no proxy)
```

**Key details:**
- Proxy pool is cached in memory for 60 seconds (`_proxyCachedAt`)
- Dead proxies are blacklisted in `_deadProxies` Set — automatically rehabilitated
  when they re-appear as "live" in the DB after a wash
- If no live proxies available, checks go direct from server IP
- Auth proxies use URL format: `http://user:pass@ip:port`

---

### 5.4 Proxy Formats

**Single add** — IP, port, protocol selector, optional username/password

**Bulk import** — one per line, auto-parsed:
```
ip:port                          → http://ip:port
ip:port:user:pass                → http://user:pass@ip:port
proto://user:pass@ip:port        → as-is (socks5, https, etc.)
```

**Supported protocols:** HTTP, HTTPS, SOCKS5, SOCKS4

---

## 6. CC Miner

### 6.1 Server Miner

**Key file:** `server/miner.ts`

The server miner runs continuously on the server, generating cards from your BIN
list and checking them against the selected gate.

**Configuration** (via `PUT /api/miner`):
| Setting | Description |
|---|---|
| `gateId` | Gate to check against, or `"random"` for random rotation |
| `binList` | Array of 6+ digit BINs to round-robin through |
| `delaySecs` | Seconds between checks (1–60) |
| `maxCardsPerBin` | Cards per BIN before rotating to next (1–500) |
| `notifyEnabled` | Send Telegram notification on live hits |

**Flow per card:**
1. Pick next BIN (round-robin by `binIdx`)
2. Resolve gate (`resolveGate()` — specific or random active gate)
3. Generate 1 card via `generateCards(bin, 1)` (Luhn-valid)
4. Run `runGateCheck(card, gate, enrichBin=true)`
5. Store result in `check_results` table
6. If approved + notify enabled → push to Telegram

---

### 6.2 Random Gate Mode

When `gateId` is set to `"random"`, the `resolveGate()` function in `server/miner.ts`
picks a random **active** gate on every card:

```typescript
async function resolveGate(gateId: string) {
  if (gateId === "random") {
    const allGates = await storage.getGateConfigs();
    const active = allGates.filter(g => g.active);
    return active[Math.floor(Math.random() * active.length)];
  }
  return storage.getGateConfig(gateId);
}
```

**Benefits:**
- Distributes load across multiple gates → reduces per-gate rate limiting
- Each card hits a different merchant → harder to detect patterns
- Available in both server miner (dropdown: "Random Rotation") and browser miner

---

### 6.3 Browser Miner (UCB1)

The browser miner (`client/src/pages/Miner.tsx`) runs in the user's browser with
UCB1 multi-armed bandit optimization.

**UCB1 scoring** — BINs are scored by: `hitRate + C * sqrt(ln(totalRounds) / binTries)`
- Exploration bonus decreases as a BIN is tested more
- BINs with higher hit rates get checked more often
- New/under-tested BINs get exploration priority

**Phases per BIN:**
| Phase | Cards Checked | Behavior |
|---|---|---|
| Probing | < 20 | Building initial data, high exploration |
| Training | 20–80 | Refining scores, balancing explore/exploit |
| Optimized | 80+ | Exploitation-focused, reliable scoring |

**Gate modes:** Auto-Select (highest-scoring active gate), Random Rotation (per batch),
or a specific gate.

---

## 7. Gate Configuration — Advanced

### 7.1 Edit Tabs Reference

Click any gate row in Gate Configs to open the editor with 5 tabs:

| Tab | Contents |
|---|---|
| **Config** | Name, URL, gate type + sub-type (with flow guide card showing READY status), active toggle, re-detect button |
| **Keys & Nonces** | Public key, BT client token, WC nonce, Store nonce, AJAX nonce, GF PI nonce, connected account |
| **Amount** | Donation/charge amount, currency (ISO code) |
| **Billing** | First/last name, email, phone, address, city, state, zip, country |
| **Advanced** | Form & Platform, Admin-Ajax Gate, WC Path Overrides, Proxy Country, Request Timeout, BIN Blacklist, Response Classifier Overrides, Save Behavior, Braintree Overrides, Donation Gate Overrides, Captcha Solver, WooCommerce Overrides |

---

### 7.2 WooCommerce Overrides

In the **Advanced** tab, WooCommerce Overrides let you fine-tune the Store API
checkout flow when auto-detection doesn't fully work:

| Field | When to Use |
|---|---|
| **Checkout Path** | Site uses `/order/` or `/buy/` instead of `/checkout/` |
| **Product ID** | Auto-detected product is $0, out of stock, or variable (requires selection) |
| **Payment Slug** | Site uses `woocommerce_payments` instead of `stripe` — force the correct slug |
| **Shop Path** | Products are at `/store/` or `/products/` instead of `/shop/` |

**Product ID tip:** Browse the site manually, find a simple in-stock product above
$0.50, and copy its product ID from the URL or page source.

---

### 7.3 WCPay Support

Sites running **WooCommerce Payments** (WCPay) use a different payment method slug
(`woocommerce_payments`) and different `payment_data` keys in the Store API checkout.

**Auto-detection** (`server/gate-detector.ts`):
- Looks for `wcpay_config` and `woocommerce_payments` in page HTML
- Sets `settings.wcPayments = true` and `settings.wcPaySlug`

**Checker flow** (`server/stripe-checker.ts`):
1. Tries slugs in order: `stripe` → `stripe_cc` → `stripe_checkout` → `woocommerce_payments`
2. If `rest_invalid_param` error returned, parses valid slugs from error message
   and dynamically injects them into the retry loop
3. WCPay-specific `payment_data` includes `wcpay-payment-method` token key
4. `status: "failed"` with `order_id` = card declined (not an error)

**Override:** In Advanced → Payment Slug dropdown, select `woocommerce_payments (WCPay)`
to skip the slug trial loop and go directly to WCPay.

---

### 7.4 Braintree Gates

**Key file:** `server/braintree-checker.ts`

Braintree gates use a client token (not a publishable key) for tokenization.

**Setup:**
1. Auto-detect finds the `braintree.client.create()` call and extracts the client token
2. Or manually paste the BT client token in Keys & Nonces tab
3. Set gate type to `braintree` and sub-type to the appropriate flow

**Sub-types:**
| Sub-Type | Description |
|---|---|
| `standard` | Standard Braintree checkout flow |
| `graphql` | Braintree GraphQL tokenization API |
| `drop_in` | Drop-in UI integration |
| `hosted_fields` | Hosted Fields integration |

**BraintreeExtras** (Advanced → Braintree Overrides):
- `btFlow` — flow selector with UI dropdown: **Auto-detect** / **WC Add-Payment-Method** / **WC Standard Checkout** / **BigCommerce Stencil**. Auto tries Add-PM → WC checkout → token-only in order.
- `btMerchantId` — merchant ID fallback (extracted from token or page; override when auto-extract fails)
- `addPmPath` — custom path for add-payment-method page (default: `/my-account/add-payment-method/`)

**BigCommerce Stencil flow** (9 steps):
All steps now route through the gate proxy. Steps 7 (order submit) and 9 (`payments.bigcommerce.com`) previously used raw `fetch()` and bypassed proxy — fixed in V8.5.

---

### 7.5 Nonce Freshness

WooCommerce nonces expire periodically (typically 12–24 hours). Signs of stale nonces:

- 403 Forbidden responses
- `"Nonce verification failed"` errors
- Checkout requests rejected before reaching Stripe

**Fix:** Re-detect the gate (click **RE-DETECT** in the edit dialog). The detector
crawls the site again and extracts fresh nonces.

**The checker's built-in recovery:** `sessionFetch()` in `stripe-checker.ts` attempts
to extract fresh Store API nonces from cart/checkout pages during the checkout flow.
This auto-heals in many cases without manual re-detection.

---

## 8. File Map

```
/
├── start.py                    ← Cross-platform launcher (Termux, Linux, macOS, Win)
│
├── server/
│   ├── index.ts                ← App entry: Express setup, Vite dev, DB push, port
│   ├── routes.ts               ← All API endpoints (/api/*)
│   ├── storage.ts              ← DB abstraction layer (all queries live here)
│   ├── db.ts                   ← Drizzle ORM + PostgreSQL pool setup
│   ├── stripe-checker.ts       ← Card checking: Stripe auth/charge/GiveWP/GravityForms/Charitable
│   ├── stripe-checker2.ts      ← Admin-ajax gate checker (WC/GiveWP/Generic body shapes)
│   ├── braintree-checker.ts    ← Braintree: WC add-PM, WC checkout, BigCommerce Stencil
│   ├── shopify-checker.ts      ← Shopify PCI tokenise → SubmitForCompletion → PollForReceipt
│   ├── paypal-checker.ts       ← PayPal Commerce (GiveWP PPCP, WC PPCP, vault fallback)
│   ├── payeezy-checker.ts      ← First Data Payeezy WC plugin
│   ├── checker.ts              ← Gate dispatcher: routes cards to correct checker + BIN blacklist
│   ├── miner.ts                ← Server-side CC miner (random gate support)
│   ├── stripe-hitter.ts        ← Checkout link parser + card hitter engine
│   ├── browser-hitter.ts       ← Puppeteer-based hitter (falls back on ARM)
│   ├── gate-detector.ts        ← Site crawler + payment gateway fingerprinter
│   ├── card-generator.ts       ← BIN-based card number generator (Luhn)
│   ├── response-codes.ts       ← Maps decline codes → live/dead/error
│   ├── telegram-bot.ts         ← Full Telegram bot: /chk, /mass, /gate, etc.
│   ├── vite.ts                 ← Vite dev server middleware integration
│   └── static.ts               ← Production static file serving
│
├── client/src/
│   ├── App.tsx                 ← Router, protected routes, providers
│   ├── main.tsx                ← React root mount
│   ├── index.css               ← Global styles + CSS variables
│   ├── pages/
│   │   ├── Dashboard.tsx       ← Stats, bot controls, gate matrix, live feed
│   │   ├── CardChecker.tsx     ← Bulk card checker with real-time logs
│   │   ├── Hitter.tsx          ← Stripe checkout hitter with session cloning
│   │   ├── Configs.tsx         ← Gate configuration + mass URL setup
│   │   ├── Miner.tsx           ← CC Miner (server + browser UCB1)
│   │   ├── Proxies.tsx         ← Proxy pool: scrub sources, wash, manage
│   │   ├── Keys.tsx            ← Access key generation
│   │   ├── Users.tsx           ← Telegram bot user management
│   │   ├── CardGen.tsx         ← Card generator UI
│   │   ├── BotSettings.tsx     ← Telegram bot configuration
│   │   ├── Handbook.tsx        ← In-app usage handbook (10 sections)
│   │   └── Login.tsx           ← Authentication page
│   ├── components/
│   │   ├── layout/
│   │   │   ├── MainLayout.tsx  ← Sidebar + header wrapper
│   │   │   ├── Sidebar.tsx     ← Navigation sidebar
│   │   │   └── Header.tsx      ← Top header bar
│   │   └── ui/                 ← shadcn/ui components (don't edit)
│   ├── hooks/
│   │   ├── use-auth.tsx        ← Login/logout state
│   │   └── use-toast.ts        ← Toast notifications
│   └── lib/
│       ├── queryClient.ts      ← TanStack Query setup + apiRequest()
│       ├── checkerStore.ts     ← Global state for card checker (survives nav)
│       └── utils.ts            ← cn() classname helper
│
├── shared/
│   └── schema.ts               ← Database schema + Zod types (used by both)
│
├── script/
│   └── build.ts                ← Production build script (Vite + esbuild)
│
├── drizzle.config.ts           ← Drizzle Kit config
├── vite.config.ts              ← Vite config (aliases, plugins, build output)
├── tsconfig.json               ← TypeScript config (@/* and @shared/* aliases)
└── package.json                ← Dependencies + npm scripts
```

---

## 9. Default Credentials

| Item | Default |
|---|---|
| Web panel login | `admin` / `926696` |
| Bot admin password | `926696` |
| Admin reset endpoint | password: `926696` |

**Change the admin password** (strongly recommended):
1. Web panel → **System Configuration** → Bot Admin Password → enter new password → Save
2. Or via Dashboard → System Reset → use current password to change it
3. Or directly: `PATCH /api/bot-settings` with `{ "adminPassword": "newpassword" }`

**Change the web panel password:**
The web login password is stored as a bcrypt hash in the `users` table.
Use the admin reset endpoint or update it via the Users page in the panel.

---

## Quick Reference

```bash
# Start (Termux / any platform):
python start.py

# Production:
python start.py --prod

# Install only (no server start):
python start.py --install

# Wipe database:
python start.py --reset-db

# Use external DB (e.g. Neon/Supabase):
export DATABASE_URL="postgresql://user:pass@host/db"
python start.py --skip-pg

# Debug hitter logs:
export DEBUG_CHECKER=1
python start.py --dev

# Build production bundle:
python start.py --build
# Output: dist/index.cjs + dist/public/
```

---

## 10. Gate Setup — Complete Guide (English)

A **gate** is a payment endpoint on a merchant site that the checker uses to validate cards. Each gate type (Stripe, Braintree, PayPal) requires specific keys and settings extracted from the target site. This section covers every method for creating gates, finding keys, and fine-tuning settings.

---

### 10.1 Method 1: Auto-Detect (Recommended)

The fastest way to set up a single gate. The system crawls the site and extracts keys automatically.

**Steps:**
1. Go to **Gate Configs** page in the web panel
2. Click **NEW CONFIG** button
3. Enter the target site URL (e.g. `https://example-shop.com`)
4. Click **AUTO-DETECT** — the system will:
   - Crawl 30+ paths on the site (`/checkout/`, `/my-account/`, `/donate/`, `/shop/`, etc.)
   - Follow deep links to donation/checkout pages
   - Extract Stripe publishable keys (`pk_live_...` or `pk_test_...`)
   - Extract Braintree client tokens
   - Extract WooCommerce nonces
   - Detect WCPay vs direct Stripe
   - Identify donation forms (GiveWP, Charitable, Gravity Forms)
   - Handle CAPTCHA challenges (Cloudflare, SGCaptcha, hCaptcha)
5. Review the detection result — it shows:
   - **Gate Type** (stripe / braintree / paypal)
   - **Sub Type** (charges, payment_intents, charitable, givewp, gravityforms, etc.)
   - **Confidence score** (0-100%)
   - **Signals** — what evidence was found
   - **Extracted keys** — publishable key, nonces, tokens
6. Click **SAVE** to create the gate

**When auto-detect fails:**
- Site has strong CAPTCHA (Cloudflare challenge)
- Site uses non-standard payment integration
- Site blocks server-side requests
- In these cases, use Manual Setup (Section 10.3)

---

### 10.2 Method 2: Bulk URL Scan

Scan many sites at once. Best for setting up dozens of gates quickly.

**Steps:**
1. Go to **Gate Configs** page
2. Click **MASS SETUP** button
3. Paste URLs in the text area, one per line:
   ```
   example-shop1.com
   example-shop2.co.uk
   https://donate.example.org
   shop.example.net/checkout
   ```
4. Use the toolbar buttons:
   - **Paste** — paste from clipboard
   - **Dedup** — remove duplicate URLs
   - **Clear** — clear all URLs
5. Click **START SCAN** — the system processes each URL:
   - Shows real-time progress (scanning, success, failed)
   - Live timer shows elapsed time
   - Each result shows gate type, confidence, and key found
6. After completion, review results:
   - **Green rows** = successfully configured gates
   - **Red rows** = failed (CAPTCHA, no payment gateway, site down)
   - Click any row to expand detection details
7. Use post-scan buttons:
   - **RETRY FAILED** — re-scan only the failed URLs
   - **EXPORT** — download successful gates as a text file

**Bulk scan tips:**
- Start with 10-20 URLs to test before scanning hundreds
- Sites with Cloudflare will often fail — these need manual setup
- Donation sites (GiveWP, Charitable) have high success rates
- WooCommerce shops with standard checkout work best

---

### 10.3 Method 3: Manual Setup

When auto-detect fails, you can manually enter gate details.

**Steps:**
1. Go to **Gate Configs** → **NEW CONFIG**
2. Fill in:
   - **Name** — descriptive name (e.g. "ShopX Stripe Auth")
   - **Gate Type** — select: `stripe`, `braintree`, or `paypal`
   - **Sub Type** — depends on gate type:
     - Stripe: `charges`, `payment_intents`, `auth`, `charitable`, `givewp`, `givewp_v3`, `gravityforms`
     - Braintree: `standard`, `wc_braintree`, `wc_braintree_addpm`
     - PayPal: `standard`
   - **URL** — the target site base URL
3. Fill in gate-specific settings (see sections 10.5–10.8)
4. Click **Save**

---

### 10.4 Finding Keys from Browser DevTools

This is the core skill for manual gate setup. You need a web browser (Chrome/Edge/Firefox) to inspect the target site.

#### 10.4.1 Finding Stripe Publishable Key

The Stripe publishable key starts with `pk_live_` or `pk_test_` and is always present in the page source.

**Method A — Page Source Search:**
1. Open the target site's checkout or payment page in your browser
2. Press `Ctrl+U` (View Page Source)
3. Press `Ctrl+F` to search
4. Search for `pk_live_` or `pk_test_`
5. Copy the full key (e.g. `pk_live_abc123...xyz`)

**Method B — Browser Console:**
1. Open the payment page
2. Press `F12` to open DevTools → go to **Console** tab
3. Type: `Stripe` and press Enter
4. If Stripe is loaded, type:
   ```javascript
   document.querySelectorAll('script').forEach(s => {
     if(s.textContent.includes('pk_')) console.log(s.textContent.match(/pk_(live|test)_[a-zA-Z0-9_-]+/)?.[0])
   })
   ```
5. Or search all scripts:
   ```javascript
   document.documentElement.innerHTML.match(/pk_(live|test)_[a-zA-Z0-9_-]+/g)
   ```

**Method C — Network Tab:**
1. Open DevTools → **Network** tab
2. Filter by `api.stripe.com`
3. Complete a checkout or add-payment-method action on the site
4. Click any request to `api.stripe.com/v1/payment_methods` or `/v1/tokens`
5. In the **Payload** or **Request Body**, find the `key=pk_live_...` parameter

**Method D — Elements Tab:**
1. Open DevTools → **Elements** tab
2. Press `Ctrl+F` and search for `pk_live` or `pk_test`
3. Look in `<script>` tags, `data-*` attributes, or inline JavaScript
4. Common locations:
   - `<script>var stripe_params = { key: "pk_live_..." }</script>`
   - `<input type="hidden" name="stripe_key" value="pk_live_...">`
   - `<div data-stripe-key="pk_live_...">`

#### 10.4.2 Finding WooCommerce Nonces

WC nonces are security tokens that expire. They are needed for WC Store API checkout flow.

**WC Process-Checkout Nonce:**
1. View page source on the checkout page
2. Search for `woocommerce-process-checkout-nonce`
3. Copy the `value` attribute:
   ```html
   <input type="hidden" name="woocommerce-process-checkout-nonce" value="abc123def456">
   ```

**WC Store API Nonce:**
1. Open DevTools → **Network** tab
2. Search for requests to `/wp-json/wc/store/` or filter by `store`
3. Look at the request headers for: `Nonce: <value>` or `X-WC-Store-API-Nonce: <value>`
4. Or search page source for `wcStoreApiNonce` or `store_api_nonce`

**WC Ajax Nonce:**
1. View page source, search for `wc_checkout_params` or `wc_cart_params`
2. Find the `ajax_url` and nearby nonce values
3. Or search for `_ajax_nonce` in the source

#### 10.4.3 Finding Braintree Client Token

Braintree uses a client token (a long base64-encoded string) instead of a simple key.

**Method A — Page Source:**
1. View page source on the payment/checkout page
2. Search for `clientToken`, `client_token`, or `braintreeClientToken`
3. The token is a long string (100+ characters), often base64 encoded
4. Common patterns:
   ```javascript
   var wc_braintree_client_token = ["eyJ2ZXJzaW9uIjoyLC..."]
   ```
   ```javascript
   braintree.client.create({ authorization: "sandbox_abc123..." })
   ```

**Method B — Network Tab:**
1. Open DevTools → **Network** tab
2. Filter by `braintreegateway.com` or `braintree`
3. Look for requests to `client_api/v1/configuration` or `payment_methods/credit_cards`
4. Check request headers for `Authorization` containing the client token

**Method C — WC Braintree Ajax:**
1. For WooCommerce Braintree sites, the token may be fetched via AJAX
2. Filter Network tab for `wc_braintree` or `get_client_token`
3. The response contains the token in JSON format

#### 10.4.4 Identifying WCPay vs Direct Stripe

WooCommerce Payments (WCPay) uses Stripe under the hood but with a different payment method slug.

**How to tell:**
1. View page source, search for `woocommerce_payments` or `wcpay`
2. If found → it's WCPay, set `wcPaySlug` to `woocommerce_payments`
3. If you only see `stripe` or `stripe_cc` → it's direct Stripe plugin
4. In DevTools Network tab, look at checkout POST requests:
   - WCPay: `payment_method=woocommerce_payments`
   - Direct Stripe: `payment_method=stripe`

#### 10.4.5 Finding Connected Account (Stripe Connect)

Some sites use Stripe Connect with a connected account ID.

1. Search page source for `acct_` — this is the connected account ID
2. Or search for `stripe_account` or `connectedAccount`
3. Also check `wc_stripe_params` JavaScript object:
   ```javascript
   var wc_stripe_params = { key: "pk_live_...", stripe_account: "acct_abc123" }
   ```

#### 10.4.6 Finding GiveWP Form ID

1. View page source, search for `form-id=` or `data-form-url`
2. GiveWP v3 pattern:
   ```html
   <div data-form-url="https://example.com/?givewp-route=donation-form-view&form-id=1234">
   ```
3. Classic GiveWP: search for `give-form-id` or `give_form_id`

#### 10.4.7 Finding Gravity Forms Details

1. Search page source for `gform_stripe_theme_js_strings`
2. This JSON object contains:
   - `publishable_key` — the Stripe key
   - `create_payment_intent_nonce` — needed for GF PI flow
3. Also search for `GFFrontendFeeds` which contains `formId` and `feedId`

---

### 10.5 Gate Type: Stripe (WooCommerce)

WooCommerce Stripe is the most common gate type. It processes cards via the WC Store API checkout flow.

**Required Settings:**

| Setting | How to Find | Example |
|---|---|---|
| `publicKey` | Page source search `pk_live_` | `pk_live_51ABC...` |
| `siteUrl` | The shop domain | `https://shop.example.com` |

**Optional Settings (improve success rate):**

| Setting | Purpose | How to Find |
|---|---|---|
| `wcNonce` | WC checkout nonce | View source → search `process-checkout-nonce` |
| `wcStoreNonce` | Store API nonce | Network tab → store API requests |
| `wcPaySlug` | WCPay payment slug | `woocommerce_payments` if WCPay site |
| `stripeAccount` | Connected account | Page source → search `acct_` |
| `checkoutPath` | Custom checkout URL | Browse site → note the checkout page path |
| `shopPath` | Shop/catalog URL | Browse site → note where products are listed |
| `productId` | Specific product ID | URL of a product page: `?p=123` or `/product/123` |
| `currency` | Currency code | Usually auto-detected; override if needed |
| `platform` | CMS platform | Auto-detected as `woocommerce` |

**Sub Types:**
- `charges` — Stripe Charges API (older, but still common)
- `payment_intents` — Stripe PaymentIntents API (modern, recommended)
- `auth` — Auth-only (no capture), least suspicious

**Checkout Flow (what happens internally):**
1. System discovers a purchasable product on the site
2. Adds product to cart via WC Store API
3. Fetches fresh nonce from checkout page
4. Creates Stripe PaymentMethod with the card details
5. Submits WC checkout with the payment method token
6. Reads response: approved / declined / error

---

### 10.6 Gate Type: Stripe (Donation Forms)

Donation form gates are simpler — no product/cart needed.

#### Charitable
- **Sub Type:** `charitable`
- **Required:** `publicKey`, `siteUrl`
- **Optional:** `donatePath` (path to the donation form page)
- The system POSTs a donation to the Charitable form endpoint

#### GiveWP Classic
- **Sub Type:** `givewp`
- **Required:** `publicKey`, `siteUrl`
- **Optional:** `giveFormId` (the form ID number)
- Uses GiveWP's AJAX donation endpoint

#### GiveWP v3
- **Sub Type:** `givewp_v3`
- **Required:** `publicKey`, `siteUrl`
- **Optional:** `giveFormId`
- Uses GiveWP v3 REST route for donations

#### Gravity Forms + Stripe
- **Sub Type:** `gravityforms`
- **Required:** `publicKey`, `siteUrl`, `gfFormId`
- **Optional:** `gfPaymentIntentNonce`
- Uses Gravity Forms Stripe Add-On's payment intent flow

---

### 10.7 Gate Type: Shopify

Shopify stores use Shopify's own PCI-compliant tokenisation endpoint, not Stripe directly.

**Required Settings:**

| Setting | How to Find | Example |
|---|---|---|
| `siteUrl` | The Shopify store URL | `https://mystore.myshopify.com` |

**Optional Settings:**

| Setting | Purpose | Example |
|---|---|---|
| `checkoutScope` | Override `*.myshopify.com` domain used as `payment_session_scope` | `mystore.myshopify.com` |
| `proxyCountry` | Country for pool proxy selection | `US` |
| `timeout` | GQL request timeout (ms) | `30000` |

**How the Shopify flow works:**
1. **PCI Tokenise** — sends card details to `https://checkout.pci.shopifyinc.com/sessions`, returns a `sessionId`
2. **SubmitForCompletion** — POSTs a GQL mutation to `{siteUrl}/checkouts/unstable/graphql`, receives a `receiptId`
3. **PollForReceipt** — queries GQL twice (5 s apart) until result is `ProcessedReceipt`, `ActionRequiredReceipt` (3DS), or `FailedReceipt`

**Setting up manually:**
1. Set **Gate Type** → `shopify`
2. Set **URL** to the Shopify store URL
3. The system auto-derives the `*.myshopify.com` scope from the URL; override with `checkoutScope` if the store uses a custom domain

**Early-exit live signals:**
- `PAYMENTS_CREDIT_CARD_BASE_EXPIRED` — card expired but real (skips poll, returns LIVE)
- `CAPTCHA_METADATA_MISSING` — captcha required on checkout but tokenisation succeeded (LIVE)

---

### 10.8 Gate Type: Braintree

Braintree uses a client token instead of a publishable key.

**Required Settings:**

| Setting | How to Find | Example |
|---|---|---|
| `btClientToken` | Page source search (see 10.4.3) | `eyJ2ZXJzaW9uIjoyLC...` (long base64) |
| `siteUrl` | The site domain | `https://shop.example.com` |

**Optional Settings:**

| Setting | Purpose | Example |
|---|---|---|
| `btFlow` | Flow type | `wc_braintree`, `wc_braintree_addpm`, `standard` |
| `btMerchantId` | Merchant ID | Found in BT config or network requests |
| `addPmPath` | Add-payment-method page path | `/my-account/add-payment-method/` |

**Sub Types:**
- `standard` — Direct Braintree tokenization
- `wc_braintree` — WooCommerce Braintree plugin checkout flow
- `wc_braintree_addpm` — WC Braintree add-payment-method flow (best for auth checks)

**How WC Braintree flow works:**
1. System fetches a fresh client token via WC AJAX endpoint
2. Tokenizes card with Braintree client SDK
3. Submits to WC checkout or add-payment-method endpoint
4. Reads response for success/failure

---

### 10.8 Gate Type: PayPal

PayPal gates work differently — they check via the PayPal Commerce Platform.

**Required Settings:**

| Setting | How to Find |
|---|---|
| `siteUrl` | The merchant site URL |

PayPal detection is automatic — the system identifies PayPal integration from page signals and processes accordingly.

---

### 10.9 Editing & Fine-Tuning Gates

After a gate is created, you can edit it to improve performance.

**How to edit a gate:**
1. Go to **Gate Configs** page
2. Click the edit icon on any gate row
3. The edit dialog has multiple tabs:

**General Tab:**
- Gate name, type, sub type, URL
- Active/inactive toggle

**Settings Tab:**
- All key/value settings for the gate
- Edit publishable key, nonces, tokens
- Add/remove custom settings

**WC Overrides Tab (WooCommerce gates only):**
- `checkoutPath` — override the checkout page path
- `shopPath` — override the shop catalog path
- `productId` — lock to a specific product
- `wcPaySlug` — force WCPay slug
- `currency` — override currency
- Billing details (name, email, phone, address)

**Tips for better gate performance:**
- Use `auth` sub type for lower decline rates
- Set specific `productId` for cheapest product (under $1 ideal)
- Keep nonces fresh — they expire, so auto-detect refreshes them
- Prefer `pk_live_` keys over `pk_test_` (test keys only validate format)
- Set billing details matching the target site's country
- Use WC overrides to point to a specific cheap product

**Advanced tab — key fields:**

| Section | Field | Effect |
|---|---|---|
| BIN Blacklist | `binBlacklist` | Comma-separated BIN prefixes — cards matching are rejected before the gateway (no charge) |
| Response Classifier | `liveOverrides` | Force-LIVE any response containing these keywords |
| Response Classifier | `deadOverrides` | Force-DEAD any response containing these keywords |
| Braintree Overrides | `btFlow` | Dropdown: Auto / WC Add-PM / WC Checkout / BigCommerce Stencil |
| Donation Gate | `donatePath` | Override donate page path for GiveWP / Charitable / PayPal |
| Donation Gate | `donateAmount` | Dollar amount to donate (use `0.50` for minimum-charge sites) |
| Donation Gate | `donationType` | Single (one-off PaymentIntent) or Subscription (SetupIntent + off_session, bypasses sites that block one-off charges) |
| Proxy / Net | `proxyCountry` | Route through pool proxy for this country |
| Proxy / Net | `proxyOverride` | Sticky proxy URL — bypasses the rotating pool for this gate |
| Proxy / Net | `timeout` | Request timeout in ms (10 000 – 60 000) |

---

### 10.10 Testing a Gate

Before using a gate for bulk checking, test it:

1. Go to **Card Checker** page
2. Select the gate from the dropdown
3. Enter a known test card or a single card
4. Click **CHECK**
5. Check the response:
   - **Approved (LIVE)** — gate is working, card is valid
   - **Declined** — gate is working, card is invalid (this is good — means the gate processes)
   - **Error** — gate has a problem (wrong key, expired nonce, site blocking)

**Common test responses:**
- `Your card was declined` → Gate works, **card is LIVE** (bank declined it — card is real, bank has a record of it)
- `insufficient_funds` → Gate works, card is LIVE but no balance
- `incorrect_cvc` → Gate works, card is LIVE (number + expiry valid, CVV wrong)
- `No gate key configured` → Missing publishable key or client token
- `rest_invalid_param` → Wrong WCPay slug, system will auto-retry
- `Nonce expired` → Nonce needs refresh, re-run auto-detect
- `BIN 411111 blacklisted` → Card's BIN is in the gate's BIN Blacklist — check Advanced tab

---

### 10.11 Troubleshooting Gates

| Problem | Cause | Solution |
|---|---|---|
| All cards show "Error" | Wrong key or expired nonce | Re-run auto-detect to refresh |
| "No gate key configured" | Missing `publicKey` or `btClientToken` | Edit gate → add the key manually |
| "rest_invalid_param" on every card | Wrong payment method slug | Set `wcPaySlug` to `woocommerce_payments` |
| Very slow responses (>30s) | Site has CAPTCHA or rate limiting | Try different site or add proxy |
| "product_out_of_stock" | Selected product is unavailable | Edit gate → change `productId` or remove it |
| "Nonce verification failed" | WC nonce expired (they last ~24h) | Re-run auto-detect or manually update nonce |
| Braintree "bad token" | Client token expired (they last ~24h) | Re-run auto-detect for fresh token |
| Gate shows 0% confidence | Auto-detect found no payment signals | Site may not have online payment, try manually |
| "payment_method_disabled" | Stripe plugin disabled card payments | Site doesn't accept cards, use different site |

---

## 11. Gate Setup — လမ်းညွှန် (မြန်မာ)

**Gate** ဆိုတာ ကတ်တွေကို validate လုပ်ဖို့ checker က အသုံးပြုတဲ့ merchant site ပေါ်က payment endpoint တစ်ခုဖြစ်ပါတယ်။ Gate အမျိုးအစားတစ်ခုချင်းစီ (Stripe, Braintree, PayPal) အတွက် target site ကနေ ထုတ်ယူရတဲ့ သီးသန့် keys နဲ့ settings တွေ လိုအပ်ပါတယ်။

---

### 11.1 နည်းလမ်း ၁: Auto-Detect

Gate တစ်ခုကို အမြန်ဆုံး setup လုပ်နည်းပါ။ System က site ကို crawl လုပ်ပြီး keys တွေကို အလိုအလျောက် ထုတ်ယူပေးပါတယ်။

**လုပ်ဆောင်ရန်:**
1. Web panel ထဲက **Gate Configs** page ကို သွားပါ
2. **NEW CONFIG** ခလုတ်ကို နှိပ်ပါ
3. Target site URL ကို ထည့်ပါ (ဥပမာ `https://example-shop.com`)
4. **AUTO-DETECT** ကို နှိပ်ပါ — system က:
   - Site ပေါ်က path ၃၀ ကျော် ကို crawl လုပ်ပါတယ် (`/checkout/`, `/my-account/`, `/donate/` စသည်)
   - Donation/checkout page တွေဆီ deep link တွေကို follow လုပ်ပါတယ်
   - Stripe publishable key (`pk_live_...` သို့ `pk_test_...`) ကို extract လုပ်ပါတယ်
   - Braintree client token ကို extract လုပ်ပါတယ်
   - WooCommerce nonce တွေကို extract လုပ်ပါတယ်
   - WCPay နဲ့ direct Stripe ကို ခွဲခြား detect လုပ်ပါတယ်
   - Donation form (GiveWP, Charitable, Gravity Forms) ကို identify လုပ်ပါတယ်
   - CAPTCHA (Cloudflare, SGCaptcha, hCaptcha) ကို handle လုပ်ပါတယ်
5. Detection result ကို စစ်ဆေးပါ:
   - **Gate Type** — stripe / braintree / paypal
   - **Confidence score** — 0-100%
   - **Signals** — ရှာတွေ့တဲ့ အထောက်အထားတွေ
   - **Extracted keys** — key, nonce, token တွေ
6. **SAVE** ကို နှိပ်ပြီး gate ကို create လုပ်ပါ

**Auto-detect မအောင်မြင်ရင်:**
- Site မှာ CAPTCHA ပြင်းတယ် (Cloudflare challenge)
- Site က standard payment integration မသုံးဘူး
- Site က server-side request တွေကို block လုပ်တယ်
- ဒီအခြေအနေတွေမှာ Manual Setup (Section 11.3) ကို သုံးပါ

---

### 11.2 နည်းလမ်း ၂: Bulk URL Scan

Site အများကြီးကို တစ်ခါတည်း scan လုပ်ပါ။ Gate ဒါဇင်နဲ့ချီ မြန်မြန် setup လုပ်ချင်ရင် အကောင်းဆုံးပါ။

**လုပ်ဆောင်ရန်:**
1. **Gate Configs** page ကို သွားပါ
2. **MASS SETUP** ခလုတ်ကို နှိပ်ပါ
3. URL တွေကို text area ထဲ paste လုပ်ပါ (တစ်ကြောင်းတစ်ခု):
   ```
   example-shop1.com
   example-shop2.co.uk
   https://donate.example.org
   ```
4. Toolbar ခလုတ်တွေကို သုံးပါ:
   - **Paste** — clipboard ကနေ paste
   - **Dedup** — ထပ်နေတဲ့ URL တွေ ဖယ်ရှား
   - **Clear** — အကုန် clear
5. **START SCAN** နှိပ်ပါ — URL တစ်ခုချင်းစီ process လုပ်ပါတယ်:
   - Real-time progress ပြပါတယ်
   - Timer ပြပါတယ်
   - Result တစ်ခုချင်းစီ gate type, confidence, key ပြပါတယ်
6. ပြီးရင် result တွေကို စစ်ဆေးပါ:
   - **အစိမ်းရောင်** = gate အောင်မြင်စွာ configure ပြီး
   - **အနီရောင်** = fail (CAPTCHA, payment gateway မရှိ, site down)
7. Post-scan ခလုတ်တွေ:
   - **RETRY FAILED** — fail ခဲ့တဲ့ URL တွေ ပြန် scan
   - **EXPORT** — အောင်မြင်တဲ့ gate တွေကို file ဖြင့် download

---

### 11.3 နည်းလမ်း ၃: Manual Setup

Auto-detect မအောင်မြင်ရင် gate details ကို ကိုယ်တိုင် ထည့်နိုင်ပါတယ်။

**လုပ်ဆောင်ရန်:**
1. **Gate Configs** → **NEW CONFIG** ကို သွားပါ
2. ဖြည့်ရန်:
   - **Name** — ဖော်ပြချက် (ဥပမာ "ShopX Stripe Auth")
   - **Gate Type** — ရွေးပါ: `stripe`, `braintree`, `paypal`
   - **Sub Type** — gate type ပေါ်မူတည်:
     - Stripe: `charges`, `payment_intents`, `auth`, `charitable`, `givewp`, `givewp_v3`, `gravityforms`
     - Braintree: `standard`, `wc_braintree`, `wc_braintree_addpm`
     - PayPal: `standard`
   - **URL** — target site base URL
3. Gate-specific settings ဖြည့်ပါ (Section 11.5 ကြည့်ပါ)
4. **Save** နှိပ်ပါ

---

### 11.4 Browser DevTools မှ Key များရှာနည်း

Manual gate setup အတွက် အရေးကြီးဆုံး skill ဖြစ်ပါတယ်။ Target site ကို inspect လုပ်ဖို့ web browser (Chrome/Edge/Firefox) လိုအပ်ပါတယ်။

#### Stripe Publishable Key ရှာနည်း

Stripe publishable key က `pk_live_` သို့ `pk_test_` နဲ့ စပါတယ်။ Page source ထဲမှာ အမြဲရှိပါတယ်။

**နည်းလမ်း A — Page Source ရှာခြင်း:**
1. Browser မှာ target site ရဲ့ checkout သို့ payment page ကို ဖွင့်ပါ
2. `Ctrl+U` နှိပ်ပါ (View Page Source)
3. `Ctrl+F` နှိပ်ပြီး ရှာပါ
4. `pk_live_` သို့ `pk_test_` ကို ရှာပါ
5. Key အပြည့်ကို copy ကူးပါ (ဥပမာ `pk_live_abc123...xyz`)

**နည်းလမ်း B — Browser Console:**
1. Payment page ကို ဖွင့်ပါ
2. `F12` နှိပ်ပြီး DevTools ကို ဖွင့်ပါ → **Console** tab
3. ဒီ code ကို ရိုက်ထည့်ပါ:
   ```javascript
   document.documentElement.innerHTML.match(/pk_(live|test)_[a-zA-Z0-9_-]+/g)
   ```
4. Key ရှာတွေ့ရင် ပြပါလိမ့်မယ်

**နည်းလမ်း C — Network Tab:**
1. DevTools → **Network** tab ကို ဖွင့်ပါ
2. `api.stripe.com` ကို filter လုပ်ပါ
3. Site ပေါ်မှာ checkout လုပ်ပါ သို့ add-payment-method လုပ်ပါ
4. `api.stripe.com/v1/payment_methods` request ကို နှိပ်ပါ
5. **Payload** ထဲမှာ `key=pk_live_...` ကို ရှာပါ

**နည်းလမ်း D — Elements Tab:**
1. DevTools → **Elements** tab
2. `Ctrl+F` နှိပ်ပြီး `pk_live` ရှာပါ
3. `<script>` tag, `data-*` attribute, inline JavaScript ထဲမှာ ရှာပါ
4. ဖြစ်တတ်တဲ့ နေရာတွေ:
   - `<script>var stripe_params = { key: "pk_live_..." }</script>`
   - `<input type="hidden" name="stripe_key" value="pk_live_...">`

#### WooCommerce Nonce ရှာနည်း

WC nonce က expire ဖြစ်တတ်တဲ့ security token ဖြစ်ပါတယ်။

**WC Process-Checkout Nonce:**
1. Checkout page ရဲ့ page source ကို ကြည့်ပါ
2. `woocommerce-process-checkout-nonce` ကို ရှာပါ
3. `value` attribute ကို copy ကူးပါ

**WC Store API Nonce:**
1. DevTools → **Network** tab ကို ဖွင့်ပါ
2. `/wp-json/wc/store/` request တွေကို ရှာပါ
3. Request header ထဲမှာ `Nonce:` value ကို ကြည့်ပါ

#### Braintree Client Token ရှာနည်း

Braintree က publishable key အစား client token (base64 string ရှည်) ကို သုံးပါတယ်။

**Page Source:**
1. Payment page ရဲ့ source ကို ကြည့်ပါ
2. `clientToken`, `client_token`, `braintreeClientToken` ကို ရှာပါ
3. Token က ရှည်လျားသော string ဖြစ်ပါတယ် (character ၁၀၀ ကျော်)
4. ဖြစ်တတ်တဲ့ pattern:
   ```javascript
   var wc_braintree_client_token = ["eyJ2ZXJzaW9uIjoyLC..."]
   ```

**Network Tab:**
1. DevTools → **Network** tab
2. `braintreegateway.com` ကို filter လုပ်ပါ
3. Request header ထဲက `Authorization` ကို ကြည့်ပါ

#### WCPay နှင့် Direct Stripe ခွဲခြားနည်း

WooCommerce Payments (WCPay) က Stripe ကို အောက်ကနေ သုံးပါတယ် ဒါပေမယ့် payment method slug ကွာပါတယ်။

**ခွဲခြားနည်း:**
1. Page source ထဲ `woocommerce_payments` သို့ `wcpay` ကို ရှာပါ
2. ရှာတွေ့ရင် → WCPay ဖြစ်တယ်, `wcPaySlug` ကို `woocommerce_payments` ထားပါ
3. `stripe` သို့ `stripe_cc` ပဲ တွေ့ရင် → direct Stripe plugin ဖြစ်တယ်

#### Connected Account (Stripe Connect) ရှာနည်း

1. Page source ထဲ `acct_` ကို ရှာပါ — ဒါ connected account ID ဖြစ်ပါတယ်
2. သို့ `stripe_account` ကို ရှာပါ

#### GiveWP Form ID ရှာနည်း

1. Page source ထဲ `form-id=` သို့ `data-form-url` ကို ရှာပါ
2. GiveWP v3 pattern:
   ```html
   <div data-form-url="https://example.com/?givewp-route=donation-form-view&form-id=1234">
   ```

#### Gravity Forms Details ရှာနည်း

1. Page source ထဲ `gform_stripe_theme_js_strings` ကို ရှာပါ
2. JSON object ထဲ `publishable_key` နဲ့ `create_payment_intent_nonce` ရှိပါတယ်

---

### 11.5 Gate အမျိုးအစားအလိုက် Setup

#### Stripe (WooCommerce)

အသုံးအများဆုံး gate type ဖြစ်ပါတယ်။

**မဖြစ်မနေ လိုအပ်သော Settings:**

| Setting | ရှာနည်း | ဥပမာ |
|---|---|---|
| `publicKey` | Page source မှာ `pk_live_` ရှာပါ | `pk_live_51ABC...` |
| `siteUrl` | Shop domain | `https://shop.example.com` |

**ပိုကောင်းအောင် ထည့်သွင်းနိုင်သော Settings:**

| Setting | ရည်ရွယ်ချက် |
|---|---|
| `wcNonce` | WC checkout nonce |
| `wcStoreNonce` | Store API nonce |
| `wcPaySlug` | WCPay ဆိုရင် `woocommerce_payments` |
| `stripeAccount` | Connected account ID (`acct_...`) |
| `checkoutPath` | Checkout page path |
| `shopPath` | Shop page path |
| `productId` | Product ID (စျေးအသက်သာဆုံး product ရွေးပါ) |

**Sub Types:**
- `charges` — Stripe Charges API (အဟောင်း)
- `payment_intents` — Stripe PaymentIntents API (ခေတ်မီ, အကြံပြု)
- `auth` — Auth-only (capture မလုပ်), decline rate အနည်းဆုံး

**Checkout Flow (အတွင်းပိုင်း လုပ်ဆောင်ပုံ):**
1. System က site ပေါ်က ဝယ်လို့ရတဲ့ product ကို ရှာပါတယ်
2. WC Store API ကနေ cart ထဲ ထည့်ပါတယ်
3. Checkout page ကနေ nonce အသစ် ယူပါတယ်
4. Card details နဲ့ Stripe PaymentMethod create လုပ်ပါတယ်
5. WC checkout ကို payment method token နဲ့ submit လုပ်ပါတယ်
6. Response ကို ဖတ်ပါတယ်: approved / declined / error

#### Stripe (Donation Forms)

Donation form gate တွေက ပိုရိုးရှင်းပါတယ် — product/cart မလိုပါဘူး။

- **Charitable:** Sub Type `charitable`, `publicKey` + `siteUrl` လိုပါတယ်
- **GiveWP Classic:** Sub Type `givewp`, `publicKey` + `siteUrl` + `giveFormId` (optional)
- **GiveWP v3:** Sub Type `givewp_v3`, `publicKey` + `siteUrl`
- **Gravity Forms:** Sub Type `gravityforms`, `publicKey` + `siteUrl` + `gfFormId` + `gfPaymentIntentNonce`

#### Braintree

**မဖြစ်မနေ လိုအပ်သော Settings:**

| Setting | ရှာနည်း |
|---|---|
| `btClientToken` | Page source (Section 11.4) |
| `siteUrl` | Site domain |

**Sub Types:**
- `standard` — Direct Braintree tokenization
- `wc_braintree` — WooCommerce Braintree plugin checkout flow
- `wc_braintree_addpm` — WC Braintree add-payment-method flow (auth check အတွက် အကောင်းဆုံး)

#### PayPal

**လိုအပ်သော Settings:**

| Setting | ရှာနည်း |
|---|---|
| `siteUrl` | Merchant site URL |

PayPal detection က automatic ဖြစ်ပါတယ်။

---

### 11.6 Gate တည်းဖြတ်ခြင်းနှင့် ပြင်ဆင်ခြင်း

Gate create ပြီးပြီဆိုရင် performance ပိုကောင်းအောင် edit လုပ်နိုင်ပါတယ်။

**Gate edit လုပ်နည်း:**
1. **Gate Configs** page ကို သွားပါ
2. Gate row ပေါ်က edit icon ကို နှိပ်ပါ
3. Edit dialog ထဲ tab များစွာ ရှိပါတယ်:
   - **General** — Name, type, sub type, URL, active/inactive
   - **Settings** — Key/value settings အားလုံး
   - **WC Overrides** — WooCommerce gate အတွက် override settings

**Performance ပိုကောင်းအောင် Tips:**
- `auth` sub type သုံးပါ — decline rate နည်းပါတယ်
- စျေးအသက်သာဆုံး product ($1 အောက်) ကို `productId` ထည့်ပါ
- Nonce ကို fresh ဖြစ်အောင် ထိန်းပါ — expire ဖြစ်တတ်ပါတယ်
- `pk_live_` key ကို `pk_test_` ထက် ပိုနှစ်သက်ပါ
- Target site ရဲ့ နိုင်ငံနဲ့ ကိုက်ညီတဲ့ billing details ထည့်ပါ
- WC overrides ထဲ စျေးသက်သာတဲ့ product ကို point လုပ်ပါ

---

### 11.7 Gate စမ်းသပ်ခြင်းနှင့် ပြဿနာဖြေရှင်းခြင်း

**Gate စမ်းသပ်နည်း:**
1. **Card Checker** page ကို သွားပါ
2. Dropdown ကနေ gate ကို ရွေးပါ
3. Card တစ်ခု ထည့်ပါ
4. **CHECK** နှိပ်ပါ
5. Response စစ်ဆေးပါ:
   - **Approved (LIVE)** — gate အလုပ်လုပ်တယ်, card valid ဖြစ်တယ်
   - **"Your card was declined"** — gate အလုပ်လုပ်တယ်, card **LIVE** ဖြစ်တယ် (bank ကိုရောက်ပြီး bank decline လုပ်တယ် — card real ဖြစ်တယ်)
   - **Declined** — gate အလုပ်လုပ်တယ်, card invalid
   - **Error** — gate ပြဿနာရှိတယ် (key မှား, nonce expire, site block)

**ဖြစ်တတ်သော ပြဿနာများနှင့် ဖြေရှင်းနည်း:**

| ပြဿနာ | အကြောင်းရင်း | ဖြေရှင်းနည်း |
|---|---|---|
| Card အားလုံး "Error" ပြ | Key မှား သို့ nonce expire | Auto-detect ပြန် run ပြီး refresh |
| "No gate key configured" | `publicKey` သို့ `btClientToken` ပျောက် | Gate edit → key ကိုယ်တိုင် ထည့်ပါ |
| "rest_invalid_param" | Payment method slug မှား | `wcPaySlug` ကို `woocommerce_payments` ထားပါ |
| Response အလွန်နှေး (>30s) | CAPTCHA သို့ rate limiting | Site ပြောင်းပါ သို့ proxy ထည့်ပါ |
| "product_out_of_stock" | Product ဝယ်လို့မရတော့ | Gate edit → `productId` ပြောင်းပါ |
| "Nonce verification failed" | WC nonce expire (~24 နာရီ) | Auto-detect ပြန် run သို့ nonce ကိုယ်တိုင် update |
| Braintree "bad token" | Client token expire (~24 နာရီ) | Auto-detect ပြန် run ပြီး token အသစ်ယူ |
| Gate confidence 0% | Payment signal ရှာမတွေ့ | Site ပေါ်မှာ online payment မရှိနိုင်, ကိုယ်တိုင် try |
| "payment_method_disabled" | Card payment ပိတ်ထား | ဒီ site မှာ card accept မလုပ်, site ပြောင်းပါ |
