import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Persistent user settings live at $XDG_CONFIG_HOME/handback/settings.json
// (defaulting to ~/.config/handback/settings.json), separate from session
// storage under ~/.handback. Override the whole path with HANDBACK_CONFIG.
export interface HandbackConfig {
  /** Open runbooks in a Glimpse native window when `glimpseui` is installed. Default: true. */
  glimpse?: boolean;
  /** Keep the Glimpse window floating above other windows. Default: false. */
  floating?: boolean;
  /** Open http/https links in this browser app instead of the system default (Glimpse only). */
  openLinksApp?: string;
}

export function configPath(): string {
  if (process.env.HANDBACK_CONFIG) return process.env.HANDBACK_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "handback", "settings.json");
}

// Read settings.json, returning {} when it's missing or malformed so a bad file
// never breaks a run.
export function loadConfig(): HandbackConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as HandbackConfig) : {};
  } catch {
    return {};
  }
}

// Merge a partial config into settings.json, creating the file/dir if needed.
// Returns the merged config. Best-effort: throws only if the write itself fails.
export function saveConfig(partial: Partial<HandbackConfig>): HandbackConfig {
  const merged = { ...loadConfig(), ...partial };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v !== "0" && v.toLowerCase() !== "false";
}

// Resolve whether to use the Glimpse native window.
// Priority (highest wins): HANDBACK_GLIMPSE env var → settings.json → default true.
export function resolveUseGlimpse(config: HandbackConfig = loadConfig()): boolean {
  return envBool("HANDBACK_GLIMPSE") ?? config.glimpse ?? true;
}

// Resolve whether the Glimpse window floats above others.
// Priority: HANDBACK_GLIMPSE_FLOATING env var → settings.json → default false.
export function resolveFloating(config: HandbackConfig = loadConfig()): boolean {
  return envBool("HANDBACK_GLIMPSE_FLOATING") ?? config.floating ?? false;
}

// Resolve which browser app opens http/https links, or undefined for the system default.
// Priority: HANDBACK_GLIMPSE_OPEN_LINKS_APP env var → settings.json.
export function resolveOpenLinksApp(config: HandbackConfig = loadConfig()): string | undefined {
  return process.env.HANDBACK_GLIMPSE_OPEN_LINKS_APP || config.openLinksApp || undefined;
}
