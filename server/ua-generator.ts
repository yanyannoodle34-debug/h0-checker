/**
 * Dynamic User-Agent + Client Hints generator.
 * Uses `user-agents` (intoli) — auto-updated daily from real browser market share.
 * Provides matching Sec-CH-UA headers for fingerprint consistency.
 */
import UserAgent from "user-agents";

interface UAProfile {
  ua: string;
  secChUa: string;
  secChUaMobile: "?0" | "?1";
  secChUaPlatform: string;
  browser: string;
  version: string;
  os: string;
  platform: string;
  deviceType: "desktop" | "mobile";
}

interface UAFilter {
  browserName?: "Chrome" | "Firefox" | "Safari" | "Edge";
  operatingSystem?: "windows" | "macos" | "linux" | "android" | "ios";
  deviceCategory?: "desktop" | "mobile";
}

const uaCache = new Map<string, UserAgent>();

function getUAInstance(filter?: UAFilter): UserAgent {
  const key = JSON.stringify(filter);
  let instance = uaCache.get(key);
  if (!instance) {
    try {
      instance = new UserAgent(filter as any);
    } catch {
      // Filter didn't match any UA — fall back to unfiltered (random)
      instance = new UserAgent();
    }
    uaCache.set(key, instance);
  }
  return instance;
}

/**
 * Generate a random UA with matching Sec-CH-UA headers.
 * @param filter — UserAgent filter (object with browserName, operatingSystem, deviceCategory)
 * @returns UAProfile with ua + client hints
 */
export function generateUA(filter?: UAFilter): UAProfile {
  const ua = getUAInstance(filter);
  const data = ua.data;

  // Parse browser from userAgent string
  const uaString = ua.toString();
  let brand = "Chrome";
  let version = "120";
  let os = "Windows";
  let deviceType: "desktop" | "mobile" = "desktop";

  // Detect browser from UA string
  if (uaString.includes("Firefox")) {
    brand = "Firefox";
    const match = uaString.match(/Firefox\/(\d+)/);
    version = match ? match[1] : "120";
  } else if (uaString.includes("Edg/") || uaString.includes("Edge/")) {
    brand = "Edge";
    const match = uaString.match(/Edg?\/(\d+)/);
    version = match ? match[1] : "120";
  } else if (uaString.includes("Safari") && !uaString.includes("Chrome")) {
    brand = "Safari";
    const match = uaString.match(/Version\/(\d+)/);
    version = match ? match[1] : "17";
  } else {
    // Chrome
    const match = uaString.match(/Chrome\/(\d+)/);
    version = match ? match[1] : "120";
  }

  // Detect OS from platform
  const platform = (data.platform || "Win32") as string;
  if (platform === "MacIntel") os = "macOS";
  else if (platform === "Linux x86_64" || platform === "Linux armv81" || platform === "Linux aarch64" || platform === "Linux armv8l") os = "Linux";
  else if (platform === "iPhone" || platform === "iPad") os = "iOS";
  else if (platform === "Android") os = "Android";
  else os = "Windows";

  // Detect device type
  const deviceCat = (data as any).deviceCategory;
  deviceType = deviceCat === "mobile" || deviceCat === "tablet" ? "mobile" : "desktop";

  // Build Sec-CH-UA from browser data
  const majorVersion = version.split(".")[0] || "120";
  const secChUa = `"${brand}";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not=A?Brand";v="24"`;
  const secChUaPlatform = os === "macOS" ? "macOS" : os === "Linux" ? "Linux" : "Windows";
  const secChUaMobile = deviceType === "mobile" ? "?1" : "?0";

  return {
    ua: ua.toString(),
    secChUa,
    secChUaMobile,
    secChUaPlatform,
    browser: brand,
    version: version + ".0.0.0",
    os,
    platform: os,
    deviceType,
  };
}

/**
 * Generate a specific browser/profile combination.
 */
export function generateChrome(opts: { platform?: "windows" | "macos" | "linux" | "android" | "ios"; device?: "desktop" | "mobile" } = {}): UAProfile {
  const filter: UAFilter = {
    browserName: "Chrome",
    ...(opts.platform && { operatingSystem: opts.platform }),
    ...(opts.device && { deviceCategory: opts.device }),
  };
  return generateUA(filter);
}

export function generateFirefox(opts: { platform?: "windows" | "macos" | "linux" | "android"; device?: "desktop" | "mobile" } = {}): UAProfile {
  const filter: UAFilter = {
    browserName: "Firefox",
    ...(opts.platform && { operatingSystem: opts.platform }),
    ...(opts.device && { deviceCategory: opts.device }),
  };
  return generateUA(filter);
}

export function generateSafari(opts: { device?: "desktop" | "mobile" } = {}): UAProfile {
  const filter: UAFilter = {
    browserName: "Safari",
    operatingSystem: opts.device === "mobile" ? "ios" : "macos",
    deviceCategory: opts.device,
  };
  return generateUA(filter);
}

export function generateEdge(opts: { platform?: "windows" | "macos" | "linux"; device?: "desktop" | "mobile" } = {}): UAProfile {
  const filter: UAFilter = {
    browserName: "Edge",
    ...(opts.platform && { operatingSystem: opts.platform }),
    ...(opts.device && { deviceCategory: opts.device }),
  };
  return generateUA(filter);
}

/**
 * Generate a random UA (any browser, any platform) — best for diversity.
 */
export function generateRandom(): UAProfile {
  return generateUA();
}

/**
 * Warm up the UA generator (call once at startup to avoid first-call latency).
 */
export function warmup(): void {
  const filters: (UAFilter | undefined)[] = [
    undefined,
    { browserName: "Chrome" },
    { browserName: "Firefox" },
    { browserName: "Safari" },
    { browserName: "Edge" },
    { deviceCategory: "mobile" },
    { deviceCategory: "desktop" },
  ];
  for (const f of filters) {
    getUAInstance(f);
  }
}

// Export types for consumers
export type { UAProfile };
export { UserAgent };