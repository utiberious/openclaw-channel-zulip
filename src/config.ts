import path from "node:path";
import { readFileSync } from "node:fs";

export type ZulipConfig = {
  baseUrl: string;
  email: string;
  apiKey: string;
};

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = val;
  }
  return result;
}

function resolveEnvPath(): string {
  const candidates: string[] = [];

  const pluginDir = process.env["ZULIP_PLUGIN_DIR"];
  if (pluginDir) {
    candidates.push(path.join(pluginDir, ".env"));
  }

  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (home) {
    candidates.push(path.join(home, ".openclaw", "zulip", ".env"));
  }

  candidates.push(path.join(process.cwd(), ".env"));

  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      // not found, try next
    }
  }

  return candidates[candidates.length - 1]!;
}

export function loadConfig(): ZulipConfig {
  const envPath = resolveEnvPath();

  let vars: Record<string, string> = {};
  try {
    const content = readFileSync(envPath, "utf-8");
    vars = parseEnvFile(content);
  } catch {
    // fall through to process.env
  }

  const baseUrl = (vars["ZULIP_URL"] ?? process.env["ZULIP_URL"] ?? "").trim();
  const email = (vars["ZULIP_BOT_EMAIL"] ?? process.env["ZULIP_BOT_EMAIL"] ?? "").trim();
  const apiKey = (vars["ZULIP_API_KEY"] ?? process.env["ZULIP_API_KEY"] ?? "").trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("ZULIP_URL");
  if (!email) missing.push("ZULIP_BOT_EMAIL");
  if (!apiKey) missing.push("ZULIP_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required Zulip config vars: ${missing.join(", ")}. ` +
        `Set them in ${envPath} or as environment variables.`,
    );
  }

  return { baseUrl, email, apiKey };
}
