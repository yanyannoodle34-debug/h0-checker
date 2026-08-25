/**
 * Multi-provider AI API key persistence shared between the Telegram bot and the
 * web admin panel.  Stored in files under the project's `data/` directory.
 *
 * Supported providers:
 *   - nvidia   (NVIDIA_API_KEY / data/.nvidia-key)
 *   - deepseek (DEEPSEEK_API_KEY / data/.deepseek-key)
 *
 * Each provider follows: env var > file > empty string
 */
import * as fs from "fs";
import * as path from "path";

export type AIProvider = "nvidia" | "deepseek";

export interface ProviderConfig {
  envVar:        string;
  keyFile:       string;
  baseUrl:       string;
  defaultModel:  string;
  models:        string[];
}

export const AI_PROVIDERS: Record<AIProvider, ProviderConfig> = {
  nvidia: {
    envVar:       "NVIDIA_API_KEY",
    keyFile:      path.resolve(process.cwd(), "data", ".nvidia-key"),
    baseUrl:      "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.1-70b-instruct",
    models: [
      "meta/llama-3.1-70b-instruct",
      "meta/llama-3.3-70b-instruct",
      "nvidia/nemotron-70b-instruct",
      "mistralai/mixtral-8x7b-instruct",
    ],
  },
  deepseek: {
    envVar:       "DEEPSEEK_API_KEY",
    keyFile:      path.resolve(process.cwd(), "data", ".deepseek-key"),
    baseUrl:      "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
};

function readKeyFile(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8").trim();
  } catch { /* fall through */ }
  return "";
}

function writeKeyFile(filePath: string, key: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, key.trim(), { mode: 0o600 });
}

function deleteKeyFile(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ─── Public API (backward-compatible) ────────────────────────────────────────

export function readAIKey(provider: AIProvider = "nvidia"): string {
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return "";
  const envVal = process.env[cfg.envVar];
  if (envVal) return envVal;
  return readKeyFile(cfg.keyFile);
}

export function writeAIKey(key: string, provider: AIProvider = "nvidia"): void {
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return;
  writeKeyFile(cfg.keyFile, key);
}

export function clearAIKey(provider: AIProvider = "nvidia"): void {
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return;
  deleteKeyFile(cfg.keyFile);
}

export function maskAIKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 12) return "***" + key.slice(-3);
  return key.slice(0, 6) + "\u2026" + key.slice(-4);
}

export function aiKeySource(provider: AIProvider = "nvidia"): "env" | "file" | "none" {
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return "none";
  if (process.env[cfg.envVar]) return "env";
  if (fs.existsSync(cfg.keyFile)) return "file";
  return "none";
}

/** Check if any AI provider has a configured key. */
export function hasAnyAIKey(): boolean {
  return (Object.keys(AI_PROVIDERS) as AIProvider[]).some(p => readAIKey(p) !== "");
}

/** Get the first available provider, preferring nvidia then deepseek. */
export function getActiveProvider(): AIProvider | null {
  for (const p of ["nvidia", "deepseek"] as AIProvider[]) {
    if (readAIKey(p)) return p;
  }
  return null;
}
