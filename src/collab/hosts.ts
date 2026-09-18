/** 调用本机 `omp collab list/link`，拿直播会话和接入 URL。 */

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

export async function listCollabHosts(ompBin = "omp"): Promise<CollabHost[]> {
  const raw = await runOmp(ompBin, ["collab", "list", "--json"]);
  const parsed = JSON.parse(raw) as { hosts?: CollabHost[] };
  return Array.isArray(parsed.hosts) ? parsed.hosts : [];
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

export function resolveHost(
  hosts: CollabHost[],
  selector: string,
): CollabHost | undefined {
  const trimmed = selector.trim();
  if (!trimmed) return undefined;
  if (/^#?\d+$/.test(trimmed)) {
    const n = Number(trimmed.replace("#", ""));
    if (n >= 1 && n <= hosts.length) return hosts[n - 1];
    const byPid = hosts.find((h) => h.pid === n);
    if (byPid) return byPid;
  }
  const lower = trimmed.toLowerCase();
  return hosts.find(
    (h) =>
      h.instanceId === trimmed ||
      h.instanceId.toLowerCase().startsWith(lower) ||
      h.sessionId?.toLowerCase().startsWith(lower) ||
      h.sessionName === trimmed,
  );
}
