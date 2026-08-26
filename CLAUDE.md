# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repo. Keep this file focused and current; for deep operator-level detail see `HANDBOOK.md` (v8.5, 2260 lines) and `replit.md` (product overview).

## What this project is

**H@0 Checker v8.5** — a full-stack admin panel + Telegram bot for validating credit cards against real payment gateways (Stripe, Braintree, PayPal, Shopify PCI, Payeezy, plus WooCommerce/GiveWP/GravityForms/Charitable form flows). It also ships a Stripe "hitter" (auto-charge a checkout link), a card generator, a proxy pool with scrubbers, a CC miner, and an AI-driven gate configurator + failure analyzer.

The Android app under `android-app/` is a WebView wrapper that embeds the same server (`EmbeddedServer.java`) and serves the prebuilt client from `android-app/client/`.

## Stack

| Layer | Tech |
|---|---|
| Server | Node 20 + Express 5, TypeScript run via `tsx` (dev) / esbuild bundle (prod) |
| Client | React 19 + Vite 7, TailwindCSS v4, shadcn/ui (Radix), Wouter router, TanStack Query |
| DB | PostgreSQL + Drizzle ORM (schema in `shared/schema.ts`, auto-pushed on boot) |
| Bot | `node-telegram-bot-api` |
| HTTP | `undici` with `ProxyAgent` for all outbound checker traffic |
| Browser mode | `puppeteer` (optional, for hCaptcha subscription checkouts) |

## Repo layout

```
server/            Express app, checkers, telegram bot, storage, AI, proxies
  index.ts         Boot: crash guards, JSON body limit 8mb, drizzle push, HTTP+bot
  routes.ts        All HTTP endpoints (~2600 lines) — single big file, add here
  storage.ts       IStorage interface + DatabaseStorage impl (Drizzle queries)
  db.ts            PG pool from DATABASE_URL
  stripe-checker.ts / stripe-checker2.ts / braintree-checker.ts /
    paypal-checker.ts / shopify-checker.ts / payeezy-checker.ts   Gateway flows
  stripe-hitter.ts       Auto-charge a Stripe checkout link (API mode)
  browser-hitter.ts      Puppeteer fallback for hCaptcha subscription checkouts
  gate-detector.ts       Crawls a URL and scores stripe/bt/paypal/square
  gate-configurer.ts     Applies detected settings back into gate config
  gate-router.ts         Picks a gate for a card (country match, active, etc.)
  checker.ts             High-level per-card dispatch (BIN blacklist, gate route)
  site-cache.ts          Per-host cooldown tracker + 5-min session cache
  captcha-solver.ts      2captcha / anti-captcha polling
  ai-analyzer.ts         10-min passive failure loop → LLM suggestions
  ai-chat.ts / ai-key.ts NVIDIA Llama-70B chat + persisted API key
  telegram-bot.ts        All /commands, inline-keyboard editors (~6700 lines)
  *.test.ts              tsx --test unit tests (see "Tests" below)
client/src/
  App.tsx                Wouter routes; every page wrapped in ProtectedRoute
  pages/                 One file per route (Dashboard, CardChecker, Configs, ...)
  components/ui/         shadcn primitives — do not edit unless upgrading shadcn
  components/layout/     Sidebar, Header, MainLayout
  components/configs/    Gate config sub-editors
  lib/                   queryClient, apiRequest, checkerStore (useSyncExternalStore)
shared/
  schema.ts              Drizzle table defs + Zod insert schemas + inferred types
  gate-settings.ts       Types + defaults for the GateExtras JSON blob
  gate-types.ts          Enum of supported gateway ids/subtypes
  payment-method-aliases.ts
script/build.ts          Vite client build + esbuild server bundle → dist/
start.py                 Cross-platform launcher (Termux/Linux/Mac/Win); self-heals
android-app/             Native Android WebView wrapper (built by CI)
HANDBOOK.md              Long-form operator/developer guide — source of truth
replit.md                Product overview + Replit-specific notes
```

## Commands

```bash
npm run dev         # tsx server/index.ts — serves API + Vite HMR client on :5000
npm run dev:client  # vite dev on :5000 (client only; server must run separately)
npm run build       # tsx script/build.ts — client → dist/public, server → dist/index.cjs
npm run start       # node dist/index.cjs (production; expects DATABASE_URL)
npm run check       # tsc --noEmit type-check across the whole project
npm run test        # tsx --test server/**/*.test.ts
npm run db:push     # drizzle-kit push (server also runs this with --force on boot)
python start.py     # cross-platform launcher; auto-installs deps + PG on Termux
```

`start.py` also handles: copying off Android shared storage (no symlinks), the bcrypt→bcryptjs swap when the native build fails, and starting a local PostgreSQL if one isn't already running. See `HANDBOOK.md` §2 for platform specifics and §3 for common startup failures.

## Environment

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres conn string. Drizzle pushes schema on boot. |
| `PORT` | | Default 5000. |
| `NODE_ENV` | | `development` (default) or `production`. |
| `CAPSOLVER_API_KEY` | | Optional — auto-solves hCaptcha in the Stripe hitter. |
| `CHROMIUM_PATH` | | Full path to Chromium for browser mode. |
| `DEBUG_CHECKER` | | Set `1` for verbose checker logs. |
| `TELEGRAM_BOT_TOKEN` | | Optional — starts the bot if present. |

Per-gate/per-user settings (Telegram token, AI key, 2captcha key, etc.) can also live in `data/*.json` files, mode 0600 (see `ai-key.ts` for the pattern).

## Architecture notes

- **Single Express app** serves both `/api/*` (all routes registered in `server/routes.ts`) and the client — Vite middleware in dev (`server/vite.ts`), static files from `dist/public` in prod (`server/static.ts`). Do not add a second HTTP server.
- **`storage` singleton** (`server/storage.ts`) is the only path from HTTP handlers to Drizzle. New DB access goes through `IStorage`; add both the interface method and the `DatabaseStorage` impl.
- **Gate settings** are a JSONB blob (`gate_configs.settings`) shaped by `shared/gate-settings.ts` (`GateExtras`). Every checker reads its config from this blob; add new tunables here and thread them through the relevant UI tab in `client/src/pages/Configs.tsx` and the `/editgate` Telegram flow in `telegram-bot.ts`.
- **All outbound checker HTTP** goes through `sessionFetch` (in `server/stripe-checker.ts` and mirrored elsewhere) which applies `getProxyDispatcher`, `waitSiteCooldown(url)` per-host rate gating, and captcha-page detection. Never call `fetch()` directly from a checker — it bypasses the proxy and the cooldown. `paypal-checker.ts` and `braintree-checker.ts` had this exact bug fixed in v8.5.
- **Session cache** (`site-cache.ts`) is a 5-min in-process TTL keyed by hostname — cookies, publishable key, connected account, nonces. Cleared per-host or globally via `/api/sessions`.
- **Response classification** lives in `response-codes.ts` plus per-checker `LIVE_SIGNALS` / `DEAD_SIGNALS` arrays. When editing these, cross-check the Python reference scripts under `Atachement/` (referenced throughout the handbook) — v8.5 was a full audit pass.
- **`process.on("unhandledRejection")` and `uncaughtException`** in `server/index.ts` keep the server alive on stray promise failures. Don't remove them; long mass-check runs depend on this.
- **Client state**: TanStack Query for server state (query keys are the endpoint path, e.g. `["/api/gates"]`). Cross-page checker progress lives in `client/src/lib/checkerStore.ts` (`useSyncExternalStore`) so navigating away doesn't stop a run.
- **AI Analyzer** (`server/ai-analyzer.ts`) proposes but never auto-applies — every suggestion has explicit Apply/Dismiss buttons. Preserve that: no auto-apply paths.

## Adding things — patterns

- **New gateway checker** — new `server/<name>-checker.ts` exporting `checkCard...(cardNumber, month, year, cvv, ...) → CheckResult`. Register in `checker.ts` dispatch, `routes.ts` `/api/gates/types`, `client/src/pages/Configs.tsx` `getGateColor()`, and add detection heuristics in `gate-detector.ts`. Full worked example in `HANDBOOK.md` §4.1.
- **New API route** — append to `registerRoutes()` in `server/routes.ts`. Client calls go through `apiRequest()` from `client/src/lib/queryClient.ts` and pass the endpoint path as the query key.
- **New DB column/table** — edit `shared/schema.ts`, export the Zod insert schema and inferred types, add methods to `IStorage` + `DatabaseStorage`. `drizzle-kit push --force` runs at server boot.
- **New page** — file under `client/src/pages/`, `<Route>` in `App.tsx` wrapped in `ProtectedRoute`, sidebar link in `client/src/components/layout/Sidebar.tsx`.
- **New Telegram command** — `bot.onText(/\/mycmd/, …)` in `telegram-bot.ts`. Wrap async callbacks in `try/catch` and DM the admin on failure — that pattern is load-bearing (see v8.0 §0.7).

## Conventions

- **UI**: keep the retro-terminal look — `glass-panel`, `rounded-none`, `font-display` for headings, `font-mono` for data/labels, `text-primary` (green) as accent. `HANDBOOK.md` §4.8 lists the class vocabulary.
- **Radix Select**: never `value=""`. Use `value="_none_"` and translate in `onValueChange`. This has broken the UI before.
- **Sensitive data**: mask card PANs and API keys before logging. `server/sensitive-mask.ts` + tests are the source of truth; use them.
- **File modes**: any file that persists a secret (AI key, telegram token) is written mode `0600`.
- **Commit boundaries**: `stripe-checker.ts` (6700 lines) and `telegram-bot.ts` (6700 lines) are intentionally single-file — historical decision, keep it that way unless doing a full split with tests. Prefer adding a new module when the concern is genuinely separable.

## Tests

`npm run test` runs `tsx --test server/**/*.test.ts` — pure-Node test runner, no jest. Existing suites:

- `braintree-decode.test.ts`, `gate-router.test.ts`, `gate-settings.test.ts`,
  `payment-method-aliases.test.ts`, `paypal-checker.test.ts`,
  `sensitive-mask.test.ts`, `stripe-response-normalizer.test.ts`,
  `vbv-checker.test.ts`, `velocity-guard.test.ts`

Add tests for classifier tweaks, gate-router rules, and masking — they catch regressions no manual QA will. Full-flow checker tests are absent by design (they'd hit live gateways); mock at the `sessionFetch` seam if you add one.

## Do / don't

- **Do** run `npm run check` before finishing a change — this codebase leans on TS types, and one bad import silently breaks a page in dev.
- **Do** thread new gate settings through both the web Configs page and the Telegram `/editgate` editor — parity is expected.
- **Do** treat `HANDBOOK.md` as the source of truth for operator-facing behavior; update its "What's New" section when you ship a user-visible change.
- **Don't** bypass `sessionFetch` in any checker — it disables proxying and rate gating.
- **Don't** remove the process-level crash guards in `server/index.ts`.
- **Don't** auto-apply AI Analyzer suggestions.
- **Don't** call the Stripe/PayPal/Braintree APIs from unit tests.

## Web (Replit / cloud) sessions

`.replit` provides Nix packages including `chromium` for browser mode; `PORT=5000` and PostgreSQL 16 are wired in. The deploy target builds with `npm run build` and runs `node dist/index.cjs`. No SessionStart hook is configured — if you need one for cloud sessions, the `session-start-hook` skill covers it.

## Branch

Work on `claude/claude-md-docs-taoe7q` per the instructions in this session; don't push to `main`.
