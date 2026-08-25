/**
 * URL file processor — fetches remote URL lists (from Telegram links, pasted
 * URLs, or raw text), downloads the content, and extracts CC data from it.
 *
 * Supports:
 *   - Direct .txt/.csv/.log URLs (GitHub raw, pastebin, etc.)
 *   - Telegram file links (api.telegram.org/file/...)
 *   - Raw pasted text with embedded URLs
 *   - Multi-URL batch processing
 */
import { extractCards, extractBins, summarizeExtraction } from "./cc-extractor";

export interface URLProcessResult {
  url:         string;
  filename:    string;
  status:      "ok" | "error";
  error?:      string;
  cards:       string[];
  bins:        string[];
  summary:     { total: number; withCvv: number; withExpiryOnly: number; bareBins: number };
  rawLength:   number;
}

/** Extract URLs from arbitrary text (handles telegram links, pasted URLs, etc). */
export function extractURLs(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  const matches = text.match(urlRegex) || [];
  // Deduplicate
  return [...new Set(matches.map(u => u.replace(/[.,;!?]+$/, "")))];
}

/** Check if a URL points to a known file host / raw content endpoint. */
function isRawContentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("raw.githubusercontent.com") ||
    lower.includes("gist.githubusercontent.com") ||
    lower.includes("pastebin.com/raw") ||
    lower.includes("paste.rs") ||
    lower.includes("dpaste.org") ||
    lower.includes("hastebin.com/raw") ||
    lower.includes("api.telegram.org/file/") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".log") ||
    lower.endsWith(".tsv")
  );
}

/** Normalize a URL to its raw content form where possible. */
function normalizeToRaw(url: string): string {
  // GitHub blob → raw
  const ghMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)/);
  if (ghMatch) {
    return `https://raw.githubusercontent.com/${ghMatch[1]}/${ghMatch[2]}/${ghMatch[3]}`;
  }
  // GitHub gist → raw
  const gistMatch = url.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/);
  if (gistMatch) {
    return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
  }
  return url;
}

/** Fetch content from a URL with timeout and error handling. */
async function fetchURL(url: string, timeoutMs = 15000): Promise<{ content: string; filename: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(normalizeToRaw(url), {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CCBot/1.0)",
        "Accept": "text/plain, text/csv, application/octet-stream, */*",
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const content = await response.text();
    // Derive filename from URL
    const urlPath = new URL(url).pathname;
    const filename = urlPath.split("/").pop() || "unknown.txt";

    return { content, filename };
  } finally {
    clearTimeout(timer);
  }
}

/** Process a single URL — fetch, extract cards, extract bins. */
export async function processURL(url: string): Promise<URLProcessResult> {
  try {
    const { content, filename } = await fetchURL(url);
    const cards = extractCards(content);
    const bins = extractBins(content, 6);
    const summary = summarizeExtraction(cards);

    return {
      url,
      filename,
      status: "ok",
      cards,
      bins,
      summary,
      rawLength: content.length,
    };
  } catch (err: any) {
    return {
      url,
      filename: "",
      status: "error",
      error: err.message || "fetch failed",
      cards: [],
      bins: [],
      summary: { total: 0, withCvv: 0, withExpiryOnly: 0, bareBins: 0 },
      rawLength: 0,
    };
  }
}

/** Process multiple URLs in parallel (capped at 10 concurrent). */
export async function processURLs(urls: string[]): Promise<URLProcessResult[]> {
  const results: URLProcessResult[] = [];
  const concurrency = 10;

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processURL));
    results.push(...batchResults);
  }

  return results;
}

/** Process raw text — extract any embedded URLs, then process them. If no URLs
 *  found, treat the entire text as CC data to extract directly. */
export async function processRawInput(text: string): Promise<{
  urls: URLProcessResult[];
  directCards: string[];
  directBins: string[];
  directSummary: { total: number; withCvv: number; withExpiryOnly: number; bareBins: number };
}> {
  const urls = extractURLs(text);

  if (urls.length > 0) {
    const urlResults = await processURLs(urls);
    // Also extract any CCs from the input text itself
    const directCards = extractCards(text);
    const directBins = extractBins(text, 6);
    const directSummary = summarizeExtraction(directCards);
    return { urls: urlResults, directCards, directBins, directSummary };
  }

  // No URLs — treat as direct CC data
  const directCards = extractCards(text);
  const directBins = extractBins(text, 6);
  const directSummary = summarizeExtraction(directCards);
  return { urls: [], directCards, directBins, directSummary };
}
