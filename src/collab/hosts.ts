/** 调用本机 `omp collab list/link`，并枚举未分享的 TUI。 */

import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { startCollabOnTui, listTuiProcesses, parentOf } from "./tui.ts";

export type CollabAccess = "view" | "control";

export type CollabHost = {
  instanceId: string;
  generation?: number;
  pid?: number;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  participantCount?: number;
  relayConnected?: boolean;
  inputRequired?: boolean;
  access?: CollabAccess;
  [key: string]: unknown;
};

export type LiveConversation = {
  sharing: boolean;
  pid?: number;
  parentPid?: number;
  instanceId?: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  model?: string;
  access?: CollabAccess;
  relayConnected?: boolean;
  inputRequired?: boolean;
};

export type CollabLinkResult = {
  version?: number;
  instanceId: string;
  generation?: number;
  access: CollabAccess;
  url: string;
};

async function runOmp(ompBin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([ompBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const detail = (stderr || stdout).trim() || `omp exited ${code}`;
    throw new Error(detail);
  }
  return stdout;
}

export function modelLabel(model: unknown): string | undefined {
  if (typeof model === "string" && model.length > 0) return model;
  if (!model || typeof model !== "object") return undefined;
  const rec = model as { provider?: unknown; id?: unknown };
  if (typeof rec.provider === "string" && typeof rec.id === "string") {
    return `${rec.provider}/${rec.id}`;
  }
  return undefined;
}

function asHost(raw: unknown): CollabHost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.instanceId !== "string" || rec.instanceId.length === 0) return undefined;
  const access = rec.access === "view" || rec.access === "control" ? rec.access : undefined;
  const pid = typeof rec.pid === "number" && Number.isInteger(rec.pid) ? rec.pid : undefined;
  return {
    ...rec,
    instanceId: rec.instanceId,
    pid,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
    sessionName: typeof rec.sessionName === "string" ? rec.sessionName : undefined,
    cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
    model: modelLabel(rec.model) ?? (typeof rec.model === "string" ? rec.model : undefined),
    access,
    relayConnected: typeof rec.relayConnected === "boolean" ? rec.relayConnected : undefined,
    inputRequired: typeof rec.inputRequired === "boolean" ? rec.inputRequired : undefined,
  };
}

export async function listCollabHosts(ompBin = "omp"): Promise<CollabHost[]> {
  const raw = await runOmp(ompBin, ["collab", "list", "--json"]);
  const parsed = JSON.parse(raw) as { hosts?: unknown[] };
  if (!Array.isArray(parsed.hosts)) return [];
  const hosts: CollabHost[] = [];
  for (const item of parsed.hosts) {
    const host = asHost(item);
    if (host) hosts.push(host);
  }
  return hosts;
}

export async function fetchCollabLink(
  selector: string,
  access: CollabAccess,
  ompBin = "omp",
): Promise<CollabLinkResult> {
  const args = ["collab", "link", selector, "--json"];
  if (access === "view") args.push("--view");
  const raw = await runOmp(ompBin, args);
  const parsed = JSON.parse(raw) as CollabLinkResult;
  if (!parsed?.url) throw new Error("omp collab link 没有返回 url");
  return parsed;
}

function sessionDirForCwd(cwd: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
  const resolved = resolve(cwd);
  const homeRel = relative(homedir(), resolved);
  let dirName: string;
  if (homeRel === "" || (!homeRel.startsWith("..") && !isAbsolute(homeRel))) {
    const encoded = homeRel.replace(/[/\\:]/g, "-");
    dirName = encoded ? `-${encoded}` : "-";
  } else {
    dirName = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  }
  return join(agentDir, "sessions", dirName);
}

async function sessionMetaForCwd(
  cwd: string | undefined,
  sessionId?: string,
): Promise<{ sessionId?: string; sessionName?: string }> {
  if (!cwd) return {};
  try {
    const dir = sessionDirForCwd(cwd);
    const glob = new Bun.Glob("*.jsonl");
    let newest: { path: string; mtime: number } | undefined;
    for await (const name of glob.scan({ cwd: dir, onlyFiles: true })) {
      const path = join(dir, name);
      // 已知会话不能按目录的修改时间猜测，否则同目录多个 TUI 会串名。
      if (sessionId) {
        if (name.endsWith(`_${sessionId}.jsonl`)) {
          newest = { path, mtime: 0 };
          break;
        }
        continue;
      }
      const stat = await Bun.file(path).stat();
      if (!newest || stat.mtime.getTime() > newest.mtime) {
        newest = { path, mtime: stat.mtime.getTime() };
      }
    }
    if (!newest) return {};
    const input = createReadStream(newest.path, { highWaterMark: 4096 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let title: string | undefined;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as { type?: unknown; id?: unknown; title?: unknown };
        // 当前 omp 把可变标题放在首行；session 头部可能仍是改名前的标题。
        if (rec.type === "title" && typeof rec.title === "string") title = rec.title;
        if (rec.type !== "session") continue;
        if (sessionId && rec.id !== sessionId) return {};
        return {
          sessionId: typeof rec.id === "string" ? rec.id : undefined,
          sessionName: title ?? (typeof rec.title === "string" ? rec.title : undefined),
        };
      }
      return {};
    } finally {
      lines.close();
      input.destroy();
    }
  } catch {
    return {};
  }
}

export function mergeConversations(
  hosts: CollabHost[],
  tuis: Array<{
    pid: number;
    parentPid?: number;
    cwd?: string;
    sessionId?: string;
    sessionName?: string;
  }>,
): LiveConversation[] {
  const byPid = new Map<number, LiveConversation>();
  const extra: LiveConversation[] = [];
  for (const host of hosts) {
    const conv: LiveConversation = {
      sharing: true,
      pid: host.pid,
      instanceId: host.instanceId,
      sessionId: host.sessionId,
      sessionName: host.sessionName,
      cwd: host.cwd,
      model: modelLabel(host.model) ?? (typeof host.model === "string" ? host.model : undefined),
      access: host.access,
      relayConnected: host.relayConnected,
      inputRequired: host.inputRequired,
    };
    if (typeof host.pid === "number") byPid.set(host.pid, conv);
    else extra.push(conv);
  }
  const wrappers = new Set<number>();
  for (const tui of tuis) {
    if (tui.parentPid != null) wrappers.add(tui.parentPid);
  }
  for (const tui of tuis) {
    if (wrappers.has(tui.pid) && !byPid.has(tui.pid)) continue;
    const existing =
      byPid.get(tui.pid) ?? (tui.parentPid != null ? byPid.get(tui.parentPid) : undefined);
    if (existing) {
      existing.cwd = existing.cwd || tui.cwd;
      existing.sessionId = existing.sessionId || tui.sessionId;
      existing.sessionName = existing.sessionName || tui.sessionName;
      if (existing.parentPid == null && tui.parentPid != null) existing.parentPid = tui.parentPid;
      continue;
    }
    extra.push({
      sharing: false,
      pid: tui.pid,
      cwd: tui.cwd,
      sessionId: tui.sessionId,
      sessionName: tui.sessionName,
      ...(tui.parentPid != null ? { parentPid: tui.parentPid } : {}),
    });
  }
  const merged = [...byPid.values(), ...extra];
  merged.sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0) || (a.instanceId ?? "").localeCompare(b.instanceId ?? ""));
  return merged;
}

export async function listLiveConversations(ompBin = "omp"): Promise<LiveConversation[]> {
  const [hosts, tuis] = await Promise.all([listCollabHosts(ompBin), listTuiProcesses()]);
  return Promise.all(
    mergeConversations(hosts, tuis).map(async (conversation) => {
      const meta = await sessionMetaForCwd(conversation.cwd, conversation.sessionId);
      return {
        ...conversation,
        sessionId: meta.sessionId ?? conversation.sessionId,
        sessionName: meta.sessionName ?? conversation.sessionName,
      };
    }),
  );
}

export function resolveConversation<
  T extends {
    pid?: number;
    instanceId?: string;
    sessionId?: string;
    sessionName?: string;
  },
>(conversations: T[], selector: string): T | undefined {
  const trimmed = selector.trim();
  if (!trimmed) return undefined;
  if (/^#?\d+$/.test(trimmed)) {
    const n = Number(trimmed.replace("#", ""));
    if (n >= 1 && n <= conversations.length) return conversations[n - 1];
    const byPid = conversations.find((c) => c.pid === n);
    if (byPid) return byPid;
  }
  const lower = trimmed.toLowerCase();
  return conversations.find(
    (c) =>
      c.instanceId === trimmed ||
      c.instanceId?.toLowerCase().startsWith(lower) ||
      c.sessionId?.toLowerCase().startsWith(lower) ||
      c.sessionName === trimmed,
  );
}

export function resolveHost(
  hosts: CollabHost[],
  selector: string,
): CollabHost | undefined {
  return resolveConversation(hosts, selector);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}


export async function ensureCollabHost(
  conversation: LiveConversation,
  ompBin = "omp",
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<CollabHost> {
  if (conversation.sharing && conversation.instanceId) {
    return {
      instanceId: conversation.instanceId,
      pid: conversation.pid,
      sessionId: conversation.sessionId,
      sessionName: conversation.sessionName,
      cwd: conversation.cwd,
      model: conversation.model,
      access: conversation.access,
      relayConnected: conversation.relayConnected,
      inputRequired: conversation.inputRequired,
    };
  }
  if (!conversation.pid) {
    throw new Error("这个会话还没开 collab，而且找不到对应的 TUI 进程");
  }
  await startCollabOnTui(conversation.pid);
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const pollMs = opts?.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const hosts = await listCollabHosts(ompBin);
    const found = hosts.find(
      (host) =>
        host.pid != null &&
        (host.pid === conversation.pid || host.pid === conversation.parentPid),
    );
    if (found) return found;
    for (const host of hosts) {
      if (host.pid == null) continue;
      const ppid = await parentOf(host.pid);
      if (ppid === conversation.pid) return host;
    }
  }
  throw new Error(
    `已向 pid ${conversation.pid} 发送 /collab，但 ${Math.round(timeoutMs / 1000)} 秒内没有出现在 collab 列表。可在该 TUI 里手动执行 /collab 后再 /attach`,
  );
}
