import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BookOpen, CreditCard, Settings, Network, Crosshair, Pickaxe, Wand2,
  KeyRound, Bot, Activity, ChevronDown, ChevronRight, Shield, Zap,
  Globe, Layers, Lock, RefreshCw, AlertTriangle, Terminal,
} from "lucide-react";

type Section = "overview" | "checker" | "hitter" | "miner" | "gates" | "proxies" | "generator" | "keys" | "bot" | "advanced";

const sections: { id: Section; label: string; icon: any }[] = [
  { id: "overview",  label: "System Overview",   icon: Activity },
  { id: "checker",   label: "Card Checker",      icon: CreditCard },
  { id: "hitter",    label: "Hitter",            icon: Crosshair },
  { id: "miner",     label: "CC Miner",          icon: Pickaxe },
  { id: "gates",     label: "Gate Configs",       icon: Settings },
  { id: "proxies",   label: "Proxy Nodes",        icon: Network },
  { id: "generator", label: "Card Generator",     icon: Wand2 },
  { id: "keys",      label: "Access Keys",        icon: KeyRound },
  { id: "bot",       label: "Telegram Bot",       icon: Bot },
  { id: "advanced",  label: "Advanced & Tips",     icon: Shield },
];

function Collapsible({ title, icon: Icon, children, defaultOpen = false }: { title: string; icon?: any; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-primary/10 mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm font-mono font-semibold text-foreground hover:bg-primary/5 transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-primary shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        {Icon && <Icon className="w-3.5 h-3.5 text-accent shrink-0" />}
        {title}
      </button>
      {open && <div className="px-4 pb-4 text-sm text-muted-foreground font-mono leading-relaxed space-y-2">{children}</div>}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="px-1.5 py-0.5 border border-primary/20 bg-primary/5 text-primary text-[10px] font-bold rounded-sm">{children}</span>;
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 items-start border-l-2 border-accent/40 pl-3 py-1.5 bg-accent/5">
      <Zap className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
      <span className="text-accent/80 text-xs">{children}</span>
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 items-start border-l-2 border-destructive/40 pl-3 py-1.5 bg-destructive/5">
      <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
      <span className="text-destructive/80 text-xs">{children}</span>
    </div>
  );
}

function Field({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-0.5">
      <span className="text-primary text-xs font-bold">{name}</span>
      <span className="text-xs">{desc}</span>
    </div>
  );
}

export default function Handbook() {
  const [active, setActive] = useState<Section>("overview");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-display font-bold text-foreground glitch-text flex items-center gap-3">
          <BookOpen className="w-7 h-7 text-primary" />
          Handbook
        </h2>
        <p className="text-muted-foreground font-mono mt-1">Complete usage guide — editing, configuration, and advanced features</p>
      </div>

      <div className="flex gap-6">
        {/* Sidebar nav */}
        <div className="w-52 shrink-0 space-y-0.5">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-left border-l-2 transition-all ${
                active === id
                  ? "border-primary text-primary bg-primary/10"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="uppercase tracking-wider">{label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <Card className="glass-panel rounded-none">
            <CardContent className="p-6">

              {/* ═══════════ OVERVIEW ═══════════ */}
              {active === "overview" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">SYSTEM OVERVIEW</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    This system is a full-stack card checking platform with Stripe, Braintree, and PayPal gate support.
                    It features auto-detection, proxy rotation, Telegram bot integration, server-side mining, and bulk operations.
                  </p>

                  <Collapsible title="Architecture" icon={Layers} defaultOpen>
                    <p>The system consists of:</p>
                    <ul className="list-disc list-inside space-y-1 ml-2 text-xs">
                      <li><span className="text-primary">Dashboard</span> — live stats, bot control, quick actions</li>
                      <li><span className="text-primary">Card Checker</span> — single/bulk card checking against configured gates</li>
                      <li><span className="text-primary">Hitter</span> — session-based PI hitter with parallel workers</li>
                      <li><span className="text-primary">CC Miner</span> — automated BIN-based card generation + checking (server & browser)</li>
                      <li><span className="text-primary">Gate Configs</span> — manage, auto-detect, and tune payment gates</li>
                      <li><span className="text-primary">Proxy Nodes</span> — proxy pool management with auto-scrub from 25 public sources</li>
                      <li><span className="text-primary">Card Generator</span> — BIN-based card generation with Luhn validation</li>
                      <li><span className="text-primary">Access Keys</span> — API key management for external access</li>
                      <li><span className="text-primary">Bot Settings</span> — Telegram bot configuration and user management</li>
                    </ul>
                  </Collapsible>

                  <Collapsible title="Quick Start Flow" icon={Zap}>
                    <ol className="list-decimal list-inside space-y-1.5 ml-2 text-xs">
                      <li>Go to <span className="text-primary">Gate Configs</span> — add a URL and click <Kbd>DETECT</Kbd> to auto-detect the gate type and keys</li>
                      <li>Go to <span className="text-primary">Proxy Nodes</span> — click <Kbd>SCRUB SOURCES</Kbd> to auto-fetch live proxies from public lists</li>
                      <li>Go to <span className="text-primary">Card Checker</span> — paste cards and click <Kbd>CHECK</Kbd> to verify against your gate</li>
                      <li>Optional: configure Telegram bot in <span className="text-primary">Bot Settings</span> for notifications</li>
                    </ol>
                    <Tip>Auto-detect scans the site and configures most settings automatically. Only override if needed.</Tip>
                  </Collapsible>

                  <Collapsible title="Supported Gate Types" icon={Globe}>
                    <div className="space-y-2 text-xs">
                      <div><span className="text-primary font-bold">Stripe</span> — payment_intents, charges, auth, tokenize, 3d_secure, checkout_session</div>
                      <div className="ml-3 text-muted-foreground/70">SubTypes: charitable (donation forms), givewp (Give plugin), gravityforms (GF payment)</div>
                      <div><span className="text-primary font-bold">Braintree</span> — standard, graphql, drop_in, hosted_fields</div>
                      <div><span className="text-primary font-bold">PayPal</span> — standard, express, advanced</div>
                      <div><span className="text-primary font-bold">WooCommerce</span> — Store API checkout with stripe/stripe_cc/woocommerce_payments slugs</div>
                    </div>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ CARD CHECKER ═══════════ */}
              {active === "checker" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">CARD CHECKER</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Check cards against configured payment gates. Supports single and bulk modes.
                  </p>

                  <Collapsible title="Card Format" icon={CreditCard} defaultOpen>
                    <p className="text-xs">Cards must be in pipe-delimited format:</p>
                    <div className="bg-black/30 border border-primary/20 p-2 font-mono text-xs text-primary mt-1">
                      number|month|year|cvv
                    </div>
                    <div className="text-xs mt-1 space-y-0.5">
                      <div>Month: <span className="text-primary">01-12</span> (1 or 2 digits)</div>
                      <div>Year: <span className="text-primary">25 or 2025</span> (2 or 4 digits)</div>
                      <div>CVV: <span className="text-primary">3 or 4 digits</span> (Amex uses 4)</div>
                    </div>
                    <div className="bg-black/30 border border-primary/20 p-2 font-mono text-[10px] text-muted-foreground mt-2 space-y-0.5">
                      <div className="text-primary">Examples:</div>
                      <div>4242424242424242|12|2026|123</div>
                      <div>5555555555554444|06|27|456</div>
                      <div>371449635398431|01|2028|1234</div>
                    </div>
                  </Collapsible>

                  <Collapsible title="How Checking Works" icon={Shield}>
                    <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                      <li>Card is tokenized via Stripe.js / Braintree / PayPal tokenization</li>
                      <li>Token is submitted to the gate's payment endpoint (PI confirm, charge, etc.)</li>
                      <li>Response is parsed for decline codes vs. success indicators</li>
                      <li>Result: <span className="text-green-400">LIVE</span> (approved), <span className="text-red-400">DEAD</span> (declined), or <span className="text-yellow-400">ERROR</span></li>
                    </ol>
                    <Tip>For WooCommerce gates, the checker auto-discovers products, adds to cart, and uses the Store API checkout flow.</Tip>
                  </Collapsible>

                  <Collapsible title="Bulk Checking" icon={Layers}>
                    <p className="text-xs">Paste multiple cards (one per line) in the input area. The checker processes them sequentially against the selected gate.</p>
                    <Field name="Gate" desc="Select from your configured gates. Each gate uses different keys and endpoints." />
                    <Field name="Proxy" desc="If proxy pool is enabled, each check routes through the next proxy in rotation." />
                    <Tip>Use the Telegram bot for bulk checking — send cards to the bot and get results pushed back.</Tip>
                  </Collapsible>

                  <Collapsible title="Understanding Results" icon={Activity}>
                    <div className="space-y-1.5 text-xs">
                      <div><span className="text-green-400 font-bold">APPROVED / LIVE</span> — card is valid and charged/authorized successfully</div>
                      <div><span className="text-red-400 font-bold">DECLINED / DEAD</span> — card was rejected by the processor (insufficient funds, stolen, expired, etc.)</div>
                      <div><span className="text-yellow-400 font-bold">ERROR</span> — something went wrong (network, gate misconfigured, rate limited)</div>
                      <div className="mt-2 text-muted-foreground/70">The response field shows the raw decline reason: <span className="text-primary">generic_decline</span>, <span className="text-primary">insufficient_funds</span>, <span className="text-primary">stolen_card</span>, <span className="text-primary">card_velocity_exceeded</span>, etc.</div>
                    </div>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ HITTER ═══════════ */}
              {active === "hitter" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">HITTER</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Session-based Payment Intent hitter. Creates a PI session from a URL, then hits multiple cards against it with parallel workers.
                  </p>

                  <Collapsible title="How Sessions Work" icon={Lock} defaultOpen>
                    <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                      <li>Paste a Stripe checkout URL (payment link, checkout page, or direct PI page)</li>
                      <li>Click <Kbd>CREATE SESSION</Kbd> — the system extracts the publishable key and creates a PaymentIntent</li>
                      <li>Session shows: merchant name, amount, currency, mode (live/test)</li>
                      <li>Paste cards and hit <Kbd>START</Kbd> — workers process cards against the session PI</li>
                    </ol>
                    <Tip>Sessions lock after too many declines. Create a new session when locked.</Tip>
                  </Collapsible>

                  <Collapsible title="Speed Modes" icon={Zap}>
                    <Field name="Fast" desc="Minimal delay between hits. Higher throughput, may trigger rate limits faster." />
                    <Field name="Normal" desc="Balanced delay. Good for sustained checking." />
                    <Field name="Stealth" desc="Longer delays, randomized timing. Avoids rate-limit detection." />
                  </Collapsible>

                  <Collapsible title="Supported URLs" icon={Globe}>
                    <div className="text-xs space-y-1">
                      <div><span className="text-primary">buy.stripe.com/*</span> — Stripe Buy Links</div>
                      <div><span className="text-primary">checkout.stripe.com/*</span> — Stripe Checkout pages</div>
                      <div><span className="text-primary">Any site with Stripe.js</span> — auto-extracts pk_live key from page</div>
                    </div>
                    <Warn>Session PI amount and currency are set at creation time and cannot be changed.</Warn>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ CC MINER ═══════════ */}
              {active === "miner" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">CC MINER</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Automated card generation and checking. Two modes: Server Miner (runs on server) and Browser Miner (runs in your browser with UCB1 neural optimization).
                  </p>

                  <Collapsible title="Server Miner" icon={Terminal} defaultOpen>
                    <p className="text-xs">Runs on the server continuously. Generates cards from your BIN list and checks them against the selected gate.</p>
                    <Field name="Gate" desc="Select a specific gate or 'Random Rotation' to use a different random active gate per card." />
                    <Field name="BIN List" desc="Add 6+ digit BINs. The miner round-robins through them." />
                    <Field name="Delay" desc="Seconds between each check (1-60). Lower = faster but more rate-limit risk." />
                    <Field name="Max/BIN" desc="Cards per BIN before rotating to the next (1-500)." />
                    <Field name="Notify" desc="Enable to get Telegram notifications on live hits." />
                    <Tip>Use 'Random Rotation' to spread checks across multiple gates and reduce per-gate rate limiting.</Tip>
                  </Collapsible>

                  <Collapsible title="Browser Miner (UCB1)" icon={Pickaxe}>
                    <p className="text-xs">Runs in your browser with UCB1 bandit algorithm for adaptive BIN selection.</p>
                    <Field name="UCB1" desc="Multi-armed bandit algorithm — automatically prioritizes BINs that produce more live cards." />
                    <Field name="Phases" desc="Probing (< 20 cards) → Training (20-80) → Optimized (80+)" />
                    <Field name="Trends" desc="Rising/Falling/Stable indicators per BIN based on recent hit rate." />
                    <Field name="Gate Mode" desc="Auto-Select (best gate), Random Rotation (per batch), or specific gate." />
                    <Tip>The UCB1 trainer learns over time. Let it run through the probing phase before judging BIN quality.</Tip>
                  </Collapsible>

                  <Collapsible title="BIN Selection Tips" icon={Wand2}>
                    <div className="text-xs space-y-1">
                      <div>Use BINs from the <span className="text-primary">Card Generator</span> page or known working BINs.</div>
                      <div>6-digit BINs are standard; 8-digit BINs are more specific (bank + product level).</div>
                      <div>The miner generates random card numbers from each BIN with valid Luhn checksums.</div>
                    </div>
                    <Warn>Mining produces mostly declines. A 0.01-0.1% hit rate is normal for random generation.</Warn>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ GATE CONFIGS ═══════════ */}
              {active === "gates" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">GATE CONFIGS</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Configure and manage payment gateways. Each gate represents a site/merchant to check cards against.
                  </p>

                  <Collapsible title="Adding a Gate" icon={Settings} defaultOpen>
                    <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                      <li>Click <Kbd>+ NEW GATE</Kbd></li>
                      <li>Enter the site URL (e.g., https://example.com)</li>
                      <li>Click <Kbd>DETECT</Kbd> — the system crawls the site and auto-detects:
                        <ul className="list-disc list-inside ml-4 mt-1 space-y-0.5 text-muted-foreground/70">
                          <li>Payment processor (Stripe, Braintree, PayPal)</li>
                          <li>Publishable key / client token</li>
                          <li>Sub-type (charges, PI, charitable, givewp, gravityforms)</li>
                          <li>Platform (WooCommerce, Shopify, custom)</li>
                          <li>Nonces and form configurations</li>
                        </ul>
                      </li>
                      <li>Review detected settings and click <Kbd>SAVE</Kbd></li>
                    </ol>
                    <Tip>Bulk scan: click <Kbd>BULK SCAN</Kbd> to paste multiple URLs and auto-configure all at once.</Tip>
                  </Collapsible>

                  <Collapsible title="Editing a Gate — Tabs" icon={Layers}>
                    <p className="text-xs mb-2">Click any gate row to open the editor. Five tabs are available:</p>

                    <div className="space-y-3">
                      <div>
                        <div className="text-primary font-bold text-xs mb-0.5">CONFIG</div>
                        <Field name="Name" desc="Display name for the gate (shown in checker dropdown)" />
                        <Field name="URL" desc="Site base URL — used for checkout flow" />
                        <Field name="Gate Type" desc="stripe / braintree / paypal" />
                        <Field name="Sub Type" desc="Specific flow: charges, payment_intents, auth, charitable, givewp, etc." />
                        <Field name="Active" desc="Toggle on/off — inactive gates are skipped by the checker and miner" />
                      </div>

                      <div>
                        <div className="text-primary font-bold text-xs mb-0.5">KEYS & NONCES</div>
                        <Field name="Public Key" desc="Stripe pk_live_* or pk_test_* key" />
                        <Field name="BT Token" desc="Braintree client token (for braintree gates)" />
                        <Field name="WC Nonce" desc="WooCommerce checkout nonce (auto-detected)" />
                        <Field name="Store Nonce" desc="WC Store API nonce (auto-detected)" />
                        <Field name="AJAX Nonce" desc="WordPress AJAX nonce (for PI creation)" />
                        <Field name="GF PI Nonce" desc="Gravity Forms PaymentIntent nonce" />
                        <Field name="Connected Acct" desc="Stripe connected account ID (for platforms)" />
                      </div>

                      <div>
                        <div className="text-primary font-bold text-xs mb-0.5">AMOUNT</div>
                        <Field name="Amount" desc="Donation/charge amount. Format varies by gate type." />
                        <Field name="Currency" desc="ISO currency code (usd, gbp, eur, etc.)" />
                        <div className="text-[10px] text-muted-foreground/60 mt-1">GiveWP: decimal (5.00) · Charitable: decimal (1.00) · GravityForms: decimal auto-converted to cents</div>
                      </div>

                      <div>
                        <div className="text-primary font-bold text-xs mb-0.5">BILLING</div>
                        <p className="text-xs text-muted-foreground/70">Optional billing details sent with the checkout. Some gates require full billing to avoid validation errors.</p>
                        <Field name="Name" desc="First + Last name" />
                        <Field name="Email" desc="Billing email address" />
                        <Field name="Phone" desc="Phone number" />
                        <Field name="Address" desc="Street, City, State, Zip, Country" />
                      </div>

                      <div>
                        <div className="text-primary font-bold text-xs mb-0.5">ADVANCED</div>
                        <p className="text-xs text-muted-foreground/70">Override auto-detected settings for edge cases.</p>
                        <Field name="Platform" desc="Force WooCommerce, Shopify, or Custom platform" />
                        <Field name="Form Type" desc="Force Charitable, GiveWP, or Gravity Forms" />
                        <Field name="CAPTCHA" desc="reCAPTCHA, hCaptcha, Turnstile — requires site key" />
                        <Field name="Timeout" desc="Request timeout in ms (default 30000)" />
                      </div>
                    </div>
                  </Collapsible>

                  <Collapsible title="WooCommerce Overrides (Advanced)" icon={Globe}>
                    <p className="text-xs mb-2">For WooCommerce sites where auto-detection doesn't fully work:</p>
                    <Field name="Checkout Path" desc="Override if checkout is at /order/ or /buy/ instead of /checkout/" />
                    <Field name="Product ID" desc="Force a specific product for add-to-cart when auto-detected product is $0, out of stock, or variable" />
                    <Field name="Payment Slug" desc="Force a WC Store API payment method slug: stripe, stripe_cc, stripe_checkout, or woocommerce_payments (WCPay)" />
                    <Field name="Shop Path" desc="Override where to find products (e.g., /store/ instead of /shop/)" />
                    <Tip>Payment Slug: use 'woocommerce_payments' for sites running the WooCommerce Payments plugin instead of Stripe direct.</Tip>
                    <Warn>Product ID override: first browse the site manually to find a simple, in-stock product with price above $0.50.</Warn>
                  </Collapsible>

                  <Collapsible title="Gate Testing" icon={Zap}>
                    <p className="text-xs">Inside the edit dialog, click <Kbd>TEST</Kbd> to run a quick check against the gate with a test card. This verifies:</p>
                    <ul className="list-disc list-inside ml-2 text-xs space-y-0.5">
                      <li>Keys are valid and not expired</li>
                      <li>Nonces are fresh</li>
                      <li>Checkout flow completes successfully</li>
                      <li>Correct decline response is received (proves the gate is responding)</li>
                    </ul>
                    <Tip>A "declined" test result is GOOD — it means the gate is reachable and processing cards. "Error" means something is misconfigured.</Tip>
                  </Collapsible>

                  <Collapsible title="Import / Export" icon={Layers}>
                    <div className="text-xs space-y-1">
                      <div><span className="text-primary">Export</span> — downloads all gates as a JSON file for backup</div>
                      <div><span className="text-primary">Import</span> — upload a JSON file to restore gates (skips duplicates)</div>
                    </div>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ PROXY NODES ═══════════ */}
              {active === "proxies" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">PROXY NODES</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Manage the proxy pool used by the checker for IP rotation. Proxies are tested for real connectivity before use.
                  </p>

                  <Collapsible title="Adding Proxies" icon={Network} defaultOpen>
                    <div className="text-xs space-y-2">
                      <div><span className="text-primary font-bold">Single Add</span> — enter IP, port, protocol, and optional auth (username/password)</div>
                      <div><span className="text-primary font-bold">Bulk Import</span> — paste multiple proxies, one per line. Supported formats:</div>
                      <div className="bg-black/30 border border-primary/20 p-2 font-mono text-[10px] space-y-0.5">
                        <div>ip:port</div>
                        <div>ip:port:user:pass</div>
                        <div>proto://user:pass@ip:port</div>
                        <div className="text-muted-foreground/50">socks5://admin:secret@1.2.3.4:1080</div>
                      </div>
                      <div><span className="text-primary font-bold">SCRUB SOURCES</span> — auto-fetch from 25 public proxy lists, test connectivity, and add only live ones</div>
                    </div>
                    <Tip>SCRUB SOURCES is the fastest way to fill your proxy pool — one click fetches thousands, tests up to 500, and adds the live ones.</Tip>
                  </Collapsible>

                  <Collapsible title="Scrub vs Wash" icon={RefreshCw}>
                    <Field name="SCRUB SOURCES" desc="Fetches proxies from 25 public proxy lists, deduplicates against your existing pool, tests up to 500 new candidates, and adds live ones. Use this to grow your pool." />
                    <Field name="WASH POOL" desc="Re-tests ALL existing proxies in your pool for connectivity. Updates each proxy's status (live/dead) and latency. Use this to clean up dead proxies." />
                    <Tip>Run SCRUB first to fill the pool, then WASH periodically to prune dead proxies. Then CLEAR DEAD to remove the dead ones.</Tip>
                  </Collapsible>

                  <Collapsible title="How Proxies Work in Checking" icon={Shield}>
                    <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                      <li>When proxy routing is <span className="text-primary">ENABLED</span>, each card check routes through the next live proxy in the pool (round-robin)</li>
                      <li>If a proxy fails during a check, it's blacklisted for 60 seconds and the check retries direct</li>
                      <li>The proxy pool is cached for 60 seconds — changes take effect within a minute</li>
                      <li>Proxies use undici ProxyAgent for HTTP CONNECT tunneling (works with HTTPS sites)</li>
                    </ol>
                    <Warn>If proxy routing is DISABLED, all checks go direct from the server IP. Enable proxies to avoid IP-based rate limiting.</Warn>
                  </Collapsible>

                  <Collapsible title="Supported Protocols" icon={Lock}>
                    <Field name="HTTP" desc="Standard HTTP proxy (most common from public lists)" />
                    <Field name="HTTPS" desc="TLS-wrapped HTTP proxy" />
                    <Field name="SOCKS5" desc="SOCKS5 proxy (supports auth)" />
                    <Field name="SOCKS4" desc="SOCKS4 proxy (no auth)" />
                    <div className="text-xs text-muted-foreground/60 mt-1">Most public proxy sources provide HTTP proxies. Premium/residential proxies typically support SOCKS5 with auth.</div>
                  </Collapsible>

                  <Collapsible title="Pool Management" icon={Layers}>
                    <Field name="CLEAR DEAD" desc="Remove all proxies marked dead (failed connectivity test)" />
                    <Field name="CLEAR ALL" desc="Wipe the entire proxy pool" />
                    <Field name="EXPORT LIVE" desc="Download a text file of all live proxies (ip:port format)" />
                    <Field name="Toggle" desc="Enable/disable proxy routing globally without removing proxies" />
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ CARD GENERATOR ═══════════ */}
              {active === "generator" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">CARD GENERATOR</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Generate card numbers from BINs with valid Luhn checksums. For use with the checker and miner.
                  </p>

                  <Collapsible title="How It Works" icon={Wand2} defaultOpen>
                    <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                      <li>Enter a BIN (first 6+ digits of a card number)</li>
                      <li>Set the quantity to generate</li>
                      <li>Generated cards have random remaining digits with valid Luhn checksum</li>
                      <li>Expiry dates are randomly generated within valid future range</li>
                      <li>CVV is randomly generated (3 digits for Visa/MC, 4 for Amex)</li>
                    </ol>
                    <Tip>Generated cards are in pipe format (number|month|year|cvv) ready to paste into the checker.</Tip>
                  </Collapsible>

                  <Collapsible title="BIN Lookup" icon={Activity}>
                    <p className="text-xs">The system includes BIN lookup that shows:</p>
                    <Field name="Bank" desc="Issuing bank name" />
                    <Field name="Brand" desc="Visa, Mastercard, Amex, Discover, etc." />
                    <Field name="Type" desc="Credit, Debit, Prepaid" />
                    <Field name="Level" desc="Classic, Gold, Platinum, Business, etc." />
                    <Field name="Country" desc="Card issuing country" />
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ ACCESS KEYS ═══════════ */}
              {active === "keys" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">ACCESS KEYS</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Manage API keys for external access to the checking system.
                  </p>

                  <Collapsible title="Key Management" icon={KeyRound} defaultOpen>
                    <div className="text-xs space-y-1">
                      <div>Create keys with optional rate limits and expiration dates.</div>
                      <div>Keys can be restricted to specific gates or given global access.</div>
                      <div>Each key tracks usage stats (checks performed, last used).</div>
                    </div>
                    <Warn>Keep your API keys secret. Anyone with a key can check cards against your gates.</Warn>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ BOT SETTINGS ═══════════ */}
              {active === "bot" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">TELEGRAM BOT</h3>
                  <p className="text-sm text-muted-foreground font-mono leading-relaxed">
                    Integrate with Telegram for remote card checking, notifications, and pool management.
                  </p>

                  <Collapsible title="Setup" icon={Bot} defaultOpen>
                    <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                      <li>Create a bot via <span className="text-primary">@BotFather</span> on Telegram</li>
                      <li>Copy the bot token and paste it in <span className="text-primary">Bot Settings → Bot Token</span></li>
                      <li>Set your Telegram user ID as <span className="text-primary">Owner ID</span> for admin access</li>
                      <li>Click <Kbd>START BOT</Kbd> to begin polling</li>
                    </ol>
                    <Tip>The owner ID gets unrestricted access. Other users can be added with per-user limits.</Tip>
                  </Collapsible>

                  <Collapsible title="Bot Commands" icon={Terminal}>
                    <div className="space-y-1 text-xs">
                      <div><span className="text-primary">/chk cc|mm|yy|cvv</span> — check a single card</div>
                      <div><span className="text-primary">/mass</span> — start bulk checking (send cards after)</div>
                      <div><span className="text-primary">/gen BIN qty</span> — generate cards from a BIN</div>
                      <div><span className="text-primary">/gates</span> — list available gates</div>
                      <div><span className="text-primary">/gate ID</span> — switch active gate</div>
                      <div><span className="text-primary">/stats</span> — show checking statistics</div>
                      <div><span className="text-primary">/proxy</span> — proxy pool status</div>
                      <div><span className="text-primary">/bin BIN</span> — BIN lookup</div>
                      <div><span className="text-primary">/mine start|stop</span> — control server miner</div>
                    </div>
                  </Collapsible>

                  <Collapsible title="Notifications" icon={Activity}>
                    <div className="text-xs space-y-1">
                      <div><span className="text-primary">Live Hits</span> — get notified when a card is approved (checker, miner, or hitter)</div>
                      <div><span className="text-primary">Proxy File</span> — auto-send live proxy list after scrub/wash</div>
                      <div>Notifications are per-user — each Telegram user can toggle their own alerts.</div>
                    </div>
                  </Collapsible>
                </div>
              )}

              {/* ═══════════ ADVANCED & TIPS ═══════════ */}
              {active === "advanced" && (
                <div className="space-y-4">
                  <h3 className="text-lg font-display font-bold text-primary tracking-widest">ADVANCED & TIPS</h3>

                  <Collapsible title="Gate Auto-Detection Deep Dive" icon={Zap} defaultOpen>
                    <p className="text-xs mb-1">The detector crawls the target site and looks for:</p>
                    <ul className="list-disc list-inside ml-2 text-xs space-y-0.5">
                      <li><span className="text-primary">Stripe.js</span> — extracts pk_live/pk_test from script tags and inline JS</li>
                      <li><span className="text-primary">Braintree</span> — detects client token from braintree-web SDK initialization</li>
                      <li><span className="text-primary">WooCommerce</span> — detects wc_checkout_params, wcSettings, Store API nonces</li>
                      <li><span className="text-primary">WCPay</span> — detects wcpay_config and woocommerce_payments slug</li>
                      <li><span className="text-primary">GiveWP</span> — detects give_global_vars and form IDs</li>
                      <li><span className="text-primary">Gravity Forms</span> — detects gform_payment_data and GF nonces</li>
                      <li><span className="text-primary">Connected Accounts</span> — detects Stripe-Account headers for platform setups</li>
                    </ul>
                    <Tip>If detection misses something, manually set the keys/nonces in the Keys tab.</Tip>
                  </Collapsible>

                  <Collapsible title="WC Store API Checkout Flow" icon={Globe}>
                    <p className="text-xs mb-1">For WooCommerce sites, the checker uses the Store API:</p>
                    <ol className="list-decimal list-inside ml-2 text-xs space-y-0.5">
                      <li>Fetch products from /wp-json/wc/store/v1/products (filters out items &lt; $0.50)</li>
                      <li>Add product to cart via Store API</li>
                      <li>Get cart nonce from /wp-json/wc/store/v1/cart</li>
                      <li>Create Stripe token from card details</li>
                      <li>POST to /wp-json/wc/store/v1/checkout with payment_method slug</li>
                      <li>Parse response: success = live, status:failed = declined, rest_invalid_param = retry with correct slug</li>
                    </ol>
                    <Tip>If you see 'rest_invalid_param' errors, the checker auto-detects valid slugs from the error message and retries.</Tip>
                  </Collapsible>

                  <Collapsible title="Proxy Strategy" icon={Network}>
                    <div className="text-xs space-y-1.5">
                      <div><span className="text-primary font-bold">Round-Robin</span> — each check uses the next proxy in the pool. Even distribution.</div>
                      <div><span className="text-primary font-bold">Blacklisting</span> — if a proxy fails during a check, it's blacklisted and skipped for 60 seconds.</div>
                      <div><span className="text-primary font-bold">Fallback</span> — if the proxy fails mid-check, the system retries the request direct (no proxy).</div>
                      <div><span className="text-primary font-bold">Cache TTL</span> — proxy list is cached 60 seconds. New proxies take up to 1 minute to enter rotation.</div>
                    </div>
                    <Tip>For best results: SCRUB to fill pool → WASH to verify → CLEAR DEAD → enable proxy routing. Repeat weekly.</Tip>
                  </Collapsible>

                  <Collapsible title="Nonce Freshness" icon={RefreshCw}>
                    <div className="text-xs space-y-1">
                      <div>WooCommerce nonces expire periodically (typically 12-24 hours).</div>
                      <div>If checks start returning nonce errors, re-detect the gate to refresh nonces.</div>
                      <div>The checker auto-extracts fresh nonces during the checkout flow when possible.</div>
                    </div>
                    <Warn>Stale nonces cause 403 errors. Re-run DETECT on the gate periodically.</Warn>
                  </Collapsible>

                  <Collapsible title="Rate Limiting" icon={Shield}>
                    <div className="text-xs space-y-1">
                      <div>Stripe enforces rate limits per publishable key (typically 100 req/min for tokenization).</div>
                      <div>WooCommerce sites may have additional WAF/rate limiting (Cloudflare, Wordfence, etc.).</div>
                      <div><span className="text-primary">Mitigation:</span> use proxies, add delay between checks, rotate across multiple gates.</div>
                    </div>
                    <Tip>The 'Random Rotation' gate mode in the miner automatically spreads load across gates.</Tip>
                  </Collapsible>

                  <Collapsible title="Troubleshooting" icon={AlertTriangle}>
                    <div className="space-y-2 text-xs">
                      <div>
                        <span className="text-primary font-bold">Gate returns "error" for every card</span>
                        <div className="ml-3 text-muted-foreground/70">Re-detect the gate. Keys or nonces may be stale. Check that the site is still up.</div>
                      </div>
                      <div>
                        <span className="text-primary font-bold">Proxy scrub finds 0 live</span>
                        <div className="ml-3 text-muted-foreground/70">Public proxies die fast. Try scrubbing again — different proxies are tested each time (random sample of 500).</div>
                      </div>
                      <div>
                        <span className="text-primary font-bold">WC checkout returns "rest_invalid_param"</span>
                        <div className="ml-3 text-muted-foreground/70">The payment slug is wrong. The checker auto-retries with correct slugs, but you can also force one in Advanced → Payment Slug.</div>
                      </div>
                      <div>
                        <span className="text-primary font-bold">Miner won't start</span>
                        <div className="ml-3 text-muted-foreground/70">Check: (1) gate is selected and active, (2) at least one BIN is added, (3) miner isn't already running.</div>
                      </div>
                      <div>
                        <span className="text-primary font-bold">All checks go "direct" even with proxies enabled</span>
                        <div className="ml-3 text-muted-foreground/70">Pool may have 0 live proxies. Run WASH, then check stats. Proxy routing needs at least 1 live proxy.</div>
                      </div>
                    </div>
                  </Collapsible>
                </div>
              )}

            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
