import { readFile, writeFile } from "node:fs/promises";

export function getSurveyRegistryPath(accountId: string): string {
  return `/tmp/zulip-surveys-${accountId}.json`;
}

export async function registerSurvey(
  accountId: string,
  messageId: string,
  options?: string[],
): Promise<void> {
  const path = getSurveyRegistryPath(accountId);
  let registry: Record<string, { registeredAt: number; options?: string[] }> = {};
  try {
    const raw = await readFile(path, "utf-8");
    registry = JSON.parse(raw);
  } catch {
    // file doesn't exist yet, start fresh
  }
  registry[messageId] = { registeredAt: Date.now(), options };
  await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
}

export async function unregisterSurvey(accountId: string, messageId: string): Promise<void> {
  const path = getSurveyRegistryPath(accountId);
  try {
    const raw = await readFile(path, "utf-8");
    const registry = JSON.parse(raw) as Record<string, unknown>;
    delete registry[messageId];
    await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
  } catch {
    // ignore if file doesn't exist
  }
}
