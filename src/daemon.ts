/** 后台跑飞书长连接：关终端不跟着死。 */

import { openSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadOmpConfig } from "./config.ts";

export function daemonFiles(dataDir: string): { pidFile: string; logFile: string } {
  return {
    pidFile: join(dataDir, "bot.pid"),
    logFile: join(dataDir, "bot.log"),
  };
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadDotEnv(entry: string): Promise<Record<string, string>> {
  const candidates = [join(process.cwd(), ".env"), join(dirname(entry), "..", ".env")];
  const merged: Record<string, string> = {};
  const seen = new Set<string>();
  for (const path of candidates) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      Object.assign(merged, parseDotEnv(await readFile(path, "utf8")));
    } catch {
      /* no file */
    }
  }
  return merged;
}

function childEnv(dot: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...dot };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(
      err && typeof err === "object" && "code" in err && err.code === "EPERM",
    );
  }
}

async function readPid(pidFile: string): Promise<number | undefined> {
  try {
    const raw = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    return Number.isInteger(raw) && raw > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function runningPid(pidFile: string): Promise<number | undefined> {
  const pid = await readPid(pidFile);
  if (pid !== undefined && pidAlive(pid)) return pid;
  if (pid !== undefined) await unlink(pidFile).catch(() => {});
  return undefined;
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

export async function daemonUp(entry: string): Promise<void> {
  const { dataDir } = loadOmpConfig();
  const { pidFile, logFile } = daemonFiles(dataDir);
  await mkdir(dataDir, { recursive: true });
  const existing = await runningPid(pidFile);
  if (existing !== undefined) {
    console.log(`已在跑 pid=${existing}\n日志 ${logFile}`);
    return;
  }
  const fd = openSync(logFile, "a");
  const proc = Bun.spawn([process.execPath, entry], {
    cwd: process.cwd(),
    env: childEnv(await loadDotEnv(entry)),
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    detached: true,
    windowsHide: true,
  });
  const pid = proc.pid;
  proc.unref();
  if (!pid) {
    console.error("拉起后台进程失败");
    process.exitCode = 1;
    return;
  }
  await writeFile(pidFile, `${pid}\n`);
  await Bun.sleep(800);
  if (!pidAlive(pid)) {
    await unlink(pidFile).catch(() => {});
    console.error(`进程立刻退出，看日志 ${logFile}`);
    process.exitCode = 1;
    return;
  }
  console.log(`后台已启动 pid=${pid}\n日志 ${logFile}\n停：bun run down`);
}

export async function daemonDown(): Promise<void> {
  const { dataDir } = loadOmpConfig();
  const { pidFile, logFile } = daemonFiles(dataDir);
  const pid = await runningPid(pidFile);
  if (pid === undefined) {
    console.log("没有在跑的后台进程。");
    return;
  }
  await killTree(pid);
  await Bun.sleep(300);
  await unlink(pidFile).catch(() => {});
  console.log(`已停止 pid=${pid}\n日志 ${logFile}`);
}

export async function daemonStatus(): Promise<void> {
  const { dataDir } = loadOmpConfig();
  const { pidFile, logFile } = daemonFiles(dataDir);
  const pid = await runningPid(pidFile);
  if (pid === undefined) {
    console.log(`未在跑\n日志 ${logFile}`);
    return;
  }
  console.log(`在跑 pid=${pid}\n日志 ${logFile}`);
}
