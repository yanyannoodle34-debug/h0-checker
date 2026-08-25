# H@0 CHK V8.0 - Card Checker Admin Panel & Telegram Bot

## Overview
This project is a full-stack card checking system featuring an admin panel and Telegram bot integration. Its core purpose is to validate credit cards using real Stripe payment gateway checking, employing full browser-simulated tokenization with detailed billing information, device fingerprints, and secure headers. The system aims to provide robust and accurate card validation, offering detailed response classifications and supporting various payment flow types, including specialized flows for charitable donations and Gravity Forms. The business vision is to offer a comprehensive tool for merchants and individuals requiring reliable card verification, enhancing transaction security and reducing fraud.

## User Preferences
I prefer clear and concise communication. When explaining concepts, please use simple language and avoid overly technical jargon where possible. I value iterative development, so feel free to propose changes in smaller, manageable steps. Before implementing any major architectural changes or introducing new external dependencies, please ask for my approval. Ensure the development process prioritizes security and performance. I expect the agent to be proactive in identifying potential issues or improvements.

## System Architecture
The system is built as a full-stack application.
- **Frontend**: Developed with React, TypeScript, Vite, Tailwind CSS, and shadcn/ui for a modern and responsive user interface. `wouter` is used for routing and `TanStack React Query` for data fetching, ensuring efficient state management.
- **Backend**: Implemented using Express.js with TypeScript, providing a robust API layer.
- **Database**: PostgreSQL is utilized for data persistence, managed with Drizzle ORM.
- **Telegram Bot**: Integrates with `node-telegram-bot-api` for interactive card checking and administration.
- **Card Checking Flows**: Supports a variety of Stripe-based flows including Charge, Auth, Charitable Donation (WordPress Charitable plugin), GiveWP Donation, Gravity Forms, Full Browser (WC registration), and direct Tokenization. It also includes a Braintree GraphQL tokenization flow.
- **Response Classification**: Cards are classified into CVV LIVE, CCN LIVE, TOKENIZED, DEAD/DECLINED, and Gateway Error, providing clear feedback on card status.
- **BIN Lookup**: Integrates binlist.net for automatic issuing bank information, cached for performance.
- **Stripe Checkout Hitter v3.0**: A dedicated module to parse Stripe checkout URLs, decode session data, and automatically hit these checkouts with approved cards. It features real Stripe.js telemetry simulation for device fingerprinting, per-card identity isolation, parallel processing, and smart decline classification.
- **Hitter Architecture**: Includes advanced features like preflight session checks, lock protection, fresh amount calculation, and auto-retry mechanisms with exponential backoff.
- **Hitter v3.0 Features**:
  - **Session Cloning**: Re-visit `buy.stripe.com` Payment Links to generate multiple parallel checkout sessions (2-10 clones). Cards are distributed round-robin across cloned sessions; if one locks, remaining cards redistribute to active sessions.
  - **3DS Auto-Complete**: Automatically follows frictionless 3DS challenge URLs. Parses redirect HTML for `threeDSMethodData`/`creq`/`cres`/`PaRes` fields and auto-submits form POSTs. Interactive 3DS challenges fall through as 3DS REQUIRED.
  - **Confirm Delay Tuning**: Configurable delay (0-8 seconds) between PM creation and payment confirmation, adjustable via UI slider.
  - **Token Reuse (PM Cache)**: Caches successful PaymentMethod IDs with 15-minute TTL. When enabled, skips PM creation for cards with cached tokens. Failed PM creations are never cached.
  - **Browser Feature Flags**: Enhanced telemetry with WebGL renderer/vendor strings, AudioContext fingerprint hashes, hardware concurrency, device memory, and battery status — all matched to 12 device profiles.
  - **API Endpoints**: `POST /api/hitter/clone` (session cloning), updated `POST /api/hitter/hit` (accepts `sessionTokens[]`, `confirmDelay`, `tokenReuse`), updated `POST /api/hitter/parse` (supports `buy.stripe.com` URLs)
  - **Error Classification**: Smart error detection for subscription checkouts with hCaptcha (CAPTCHA BLOCK), session rate-limiting, and generic confirm failures. Non-retryable errors (CAPTCHA BLOCK) skip retry loops.
- **UI/UX Decisions**: The admin panel leverages shadcn/ui for a consistent and modern design. It provides real-time dashboards for mass checks, detailed configuration pages, and user management.
- **State Persistence**: The card checker state is managed globally using `client/src/lib/checkerStore.ts` and `useSyncExternalStore` to ensure state continuity across page navigations.
- **Security**: User authentication uses bcrypt, and sensitive operations are password-protected.

## External Dependencies
- **PostgreSQL**: Primary database for storing all system data.
- **Stripe API**: Core payment gateway for card tokenization and confirmation.
- **binlist.net API**: Used for BIN lookup to identify issuing bank information.
- **node-telegram-bot-api**: Library for interacting with the Telegram Bot API.
- **Capsolver API**: Optional integration for hCaptcha auto-solving during Stripe checkout hitting.
- **undici**: Used for making HTTP requests, particularly with proxy agents.
- **puppeteer**: Headless Chromium browser automation for browser-mode checkout hitting, bypassing captcha sessions by submitting card details directly via the real Stripe Checkout page.

## Browser Hitter Module
- **File**: `server/browser-hitter.ts`
- **Purpose**: Puppeteer-based headless browser fallback for Stripe checkout sessions that use subscription+captcha flows (hCaptcha). Instead of API-level tokenization+confirm, it opens the real checkout URL in headless Chromium, fills card details, and submits — intercepting the network confirm response.
- **Browser Mode Toggle**: Three states — OFF (API only), AUTO (browser when subscription+captcha detected), ON (always browser).
- **Chromium Path**: `/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium` (or `CHROMIUM_PATH` env var)
- **Limitations**: Browser mode is sequential (one card at a time per page), slower than API mode. Session locks after successful charge (one card per session).