/**
 * access.ts — Access control for DM and stream messages.
 * Manages access.json: DM policy, stream group policies, pairing.
 * REQ-ACCESS-DM-01..09, REQ-ACCESS-STREAM-01..08, REQ-ACCESS-STATIC-01..03
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "./log.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DmPolicy = "pairing" | "allowlist" | "disabled";
export type ChunkMode = "length" | "newline";

export type GroupPolicy = {
  requireMention: boolean;
  senderAllowlist: string[];
};

export type PendingEntry = {
  email: string;
  code: string;
  messageCount: number;
  createdAt: number;
};

export type AccessConfig = {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  pending: Record<string, PendingEntry>;
  ackReaction: string;
  textChunkLimit: number;
  chunkMode: ChunkMode;
};

export type DmCheckResult =
  | { action: "allow" }
  | { action: "drop" }
  | { action: "pairing"; reply: string };

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS: AccessConfig = {
  dmPolicy: "pairing",
  allowFrom: [],
  groups: { "*": { requireMention: true, senderAllowlist: ["*"] } },
  pending: {},
  ackReaction: "eyes",
  textChunkLimit: 4000,
  chunkMode: "length",
};

const MAX_PENDING = 3;          // REQ-ACCESS-DM-06
const MAX_PENDING_MSGS = 2;     // REQ-ACCESS-DM-07
const PENDING_TTL_MS = 3600000; // REQ-ACCESS-DM-08 (1 hour)

// ── File I/O ─────────────────────────────────────────────────────────────────

function accessJsonPath(): string {
  return path.join(
    process.env.HOME ?? "",
    ".claude",
    "channels",
    "zulip",
    "access.json",
  );
}

function loadFromDisk(): AccessConfig {
  const p = accessJsonPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("ENOENT")) {
      log(`access: failed to load ${p}: ${msg}, using defaults`);
    }
    return { ...DEFAULTS };
  }
}

function saveToDisk(config: AccessConfig): void {
  const p = accessJsonPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// ── Access Manager ───────────────────────────────────────────────────────────

export type AccessManager = {
  config: () => AccessConfig;
  reload: () => void;

  checkDm: (senderEmail: string) => DmCheckResult;
  checkStream: (
    streamName: string,
    senderEmail: string,
    mentionsBotName: boolean,
  ) => boolean;
  isAllowedPermissionResponder: (email: string) => boolean;

  startWatching: () => void;
  stopWatching: () => void;
};

export function createAccessManager(staticMode: boolean): AccessManager {
  let cfg = loadFromDisk();
  let watcher: fs.FSWatcher | null = null;

  function reload(): void {
    cfg = loadFromDisk();
    purgeExpiredPending();
  }

  function purgeExpiredPending(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of Object.entries(cfg.pending)) {
      if (now - entry.createdAt > PENDING_TTL_MS) {
        delete cfg.pending[key];
        changed = true;
      }
    }
    if (changed) saveToDisk(cfg);
  }

  function effectiveDmPolicy(): DmPolicy {
    // REQ-ACCESS-STATIC-02
    if (staticMode) return "allowlist";
    return cfg.dmPolicy;
  }

  function emailMatches(list: string[], email: string): boolean {
    if (list.includes("*")) return true;
    return list.some(
      (e) => e.toLowerCase() === email.toLowerCase(),
    );
  }

  function checkDm(senderEmail: string): DmCheckResult {
    purgeExpiredPending();
    const policy = effectiveDmPolicy();

    // REQ-ACCESS-DM-02
    if (policy === "disabled") return { action: "drop" };

    // REQ-ACCESS-DM-03, REQ-ACCESS-DM-04
    if (emailMatches(cfg.allowFrom, senderEmail)) return { action: "allow" };

    // allowlist policy: not in list → drop
    if (policy === "allowlist") return { action: "drop" };

    // pairing policy: not in allowFrom → pairing flow
    // REQ-ACCESS-DM-05..08
    const existing = Object.values(cfg.pending).find(
      (e) => e.email.toLowerCase() === senderEmail.toLowerCase(),
    );

    if (existing) {
      // REQ-ACCESS-DM-07
      if (existing.messageCount >= MAX_PENDING_MSGS) return { action: "drop" };
      existing.messageCount++;
      saveToDisk(cfg);
      return {
        action: "pairing",
        reply: `Your pairing code is still: ${existing.code}. Please share it with my operator.`,
      };
    }

    // REQ-ACCESS-DM-06
    if (Object.keys(cfg.pending).length >= MAX_PENDING) return { action: "drop" };

    const code = crypto.randomBytes(3).toString("hex");
    cfg.pending[code] = {
      email: senderEmail,
      code,
      messageCount: 1,
      createdAt: Date.now(),
    };
    saveToDisk(cfg);

    return {
      action: "pairing",
      reply: `I don't recognize you yet. Share this code with my operator to get access: ${code}. They'll run /zulip:access pair ${code} in their terminal.`,
    };
  }

  function checkStream(
    streamName: string,
    senderEmail: string,
    mentionsBotName: boolean,
  ): boolean {
    // REQ-ACCESS-STREAM-01..08
    const policy =
      cfg.groups[streamName] ?? cfg.groups["*"] ?? null;

    // REQ-ACCESS-STREAM-03
    if (!policy) return false;

    // REQ-ACCESS-STREAM-05
    if (policy.requireMention && !mentionsBotName) return false;

    // REQ-ACCESS-STREAM-06, REQ-ACCESS-STREAM-07
    return emailMatches(policy.senderAllowlist, senderEmail);
  }

  function isAllowedPermissionResponder(email: string): boolean {
    // REQ-PERM-05, REQ-SEC-06
    return emailMatches(cfg.allowFrom, email);
  }

  function startWatching(): void {
    if (staticMode || watcher) return; // REQ-ACCESS-STATIC-01
    const p = accessJsonPath();
    try {
      watcher = fs.watch(p, () => {
        log("access: config changed, reloading");
        reload();
      });
    } catch {
      log("access: unable to watch access.json (file may not exist yet)");
    }
  }

  function stopWatching(): void {
    watcher?.close();
    watcher = null;
  }

  return {
    config: () => cfg,
    reload,
    checkDm,
    checkStream,
    isAllowedPermissionResponder,
    startWatching,
    stopWatching,
  };
}
