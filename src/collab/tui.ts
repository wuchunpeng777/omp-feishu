/** 发现本机交互式 omp TUI，并向其注入 /collab。 */

export type TuiProcess = {
  pid: number;
  cwd?: string;
  parentPid?: number;
};

export function isRpcCommand(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  return /(?:^|\s)--mode(?:\s+|=)rpc(?:-ui)?(?:\s|$)/.test(commandLine);
}

export function isWorkerCommand(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  return commandLine.includes("__omp_worker") || commandLine.includes("omp-feishu");
}

export function isInteractiveTui(name: string | undefined, commandLine: string | undefined): boolean {
  if (isRpcCommand(commandLine) || isWorkerCommand(commandLine)) return false;
  const cmd = commandLine ?? "";
  const exe = (name ?? "").toLowerCase();
  if (exe === "omp.exe" || /(^|[\\/])omp(\.exe)?(\s|$)/.test(cmd)) return true;
  return cmd.includes("pi-coding-agent");
}

/** omp.exe 是包装进程，真正 TUI / collab pid 是子进程 bun pi-coding-agent。 */
export function collapseTuiTree(rows: TuiProcess[]): TuiProcess[] {
  const listed = new Set(rows.map((row) => row.pid));
  const dropParents = new Set<number>();
  for (const row of rows) {
    if (row.parentPid != null && listed.has(row.parentPid)) dropParents.add(row.parentPid);
  }
  return rows.filter((row) => !dropParents.has(row.pid)).sort((a, b) => a.pid - b.pid);
}

function parseJsonList(raw: string): unknown[] {
  const text = raw.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function runPowerShell(script: string, args: string[] = []): Promise<string> {
  const file = `${process.env.TEMP || process.env.TMP || "."}\\omp-feishu-${Bun.hash(script).toString(16)}.ps1`;
  await Bun.write(file, script);
  const proc = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
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
    throw new Error((stderr || stdout).trim() || `powershell exited ${code}`);
  }
  return stdout;
}

const LIST_SCRIPT = `
param()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ProcCwd {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint a, bool b, int p);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr p, int c, ref PBI i, int l, out int r);
  [StructLayout(LayoutKind.Sequential)]
  struct PBI {
    public IntPtr ExitStatus, PebBaseAddress, Affinity, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, int s, out IntPtr n);
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      PBI pbi = new PBI();
      int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return "";
      byte[] ptrBuf = new byte[8];
      IntPtr nread;
      if (!ReadProcessMemory(h, IntPtr.Add(pbi.PebBaseAddress, 0x20), ptrBuf, 8, out nread)) return "";
      long procParams = BitConverter.ToInt64(ptrBuf, 0);
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, new IntPtr(procParams + 0x38), us, 16, out nread)) return "";
      short len = BitConverter.ToInt16(us, 0);
      long buf = BitConverter.ToInt64(us, 8);
      if (len <= 0 || len > 2048) return "";
      byte[] path = new byte[len];
      if (!ReadProcessMemory(h, new IntPtr(buf), path, len, out nread)) return "";
      return Encoding.Unicode.GetString(path).TrimEnd((char)92);
    } finally { CloseHandle(h); }
  }
}
'@
Get-CimInstance Win32_Process -Filter "Name='omp.exe' OR Name='bun.exe' OR Name='node.exe'" | ForEach-Object {
  $cmd = [string]$_.CommandLine
  $name = [string]$_.Name
  if ($name -ne 'omp.exe' -and $cmd -notmatch 'pi-coding-agent') { return }
  if ($cmd -match '__omp_worker') { return }
  if ($cmd -match 'omp-feishu') { return }
  if ($cmd -match '--mode(\\s+|=)rpc') { return }
  [pscustomobject]@{
    pid = $_.ProcessId
    parentPid = $_.ParentProcessId
    cwd = [ProcCwd]::Get($_.ProcessId)
    commandLine = $cmd
    name = $name
  }
} | ConvertTo-Json -Compress
`;

const INJECT_SCRIPT = `
param([int]$ProcessId, [string]$B64)
if (-not $B64) { throw "missing text" }
$Text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConInject {
  const uint KEY_EVENT = 1;
  const uint GENERIC_READ_WRITE = 0xC0000000u;
  const uint FILE_SHARE_READ_WRITE = 3;
  const uint OPEN_EXISTING = 3;
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr p, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] r, int n, out int w);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint m);
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEY_EVENT_RECORD {
    public int bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public ushort UnicodeChar;
    public uint dwControlKeyState;
  }
  static INPUT_RECORD Key(bool down, char ch) {
    INPUT_RECORD rec = new INPUT_RECORD();
    rec.EventType = (ushort)KEY_EVENT;
    rec.KeyEvent.bKeyDown = down ? 1 : 0;
    rec.KeyEvent.wRepeatCount = 1;
    ushort vk;
    uint mods = 0;
    if (ch == (char)13) {
      vk = 0x0D;
      rec.KeyEvent.UnicodeChar = 13;
    } else if (ch == (char)27) {
      vk = 0x1B;
      rec.KeyEvent.UnicodeChar = 0;
    } else {
      rec.KeyEvent.UnicodeChar = ch;
      short mapped = VkKeyScan(ch);
      if (mapped == -1) {
        vk = ch == '/' ? (ushort)0xBF : (ushort)char.ToUpper(ch);
      } else {
        vk = (ushort)(mapped & 0xFF);
        if ((mapped & 0x100) != 0) mods |= 0x0010;
        if ((mapped & 0x200) != 0) mods |= 0x0008;
        if ((mapped & 0x400) != 0) mods |= 0x0002;
      }
    }
    rec.KeyEvent.wVirtualKeyCode = vk;
    rec.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKey(vk, 0);
    rec.KeyEvent.dwControlKeyState = mods;
    return rec;
  }
  public static string Send(int pid, string text) {
    FreeConsole();
    if (!AttachConsole((uint)pid)) return "attach_failed";
    IntPtr conin = CreateFile("CONIN$", GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (conin == new IntPtr(-1)) return "conin_failed";
    try {
      INPUT_RECORD[] recs = new INPUT_RECORD[text.Length * 2];
      int i = 0;
      foreach (char ch in text) {
        recs[i++] = Key(true, ch);
        recs[i++] = Key(false, ch);
      }
      int written;
      if (!WriteConsoleInput(conin, recs, recs.Length, out written)) return "write_failed";
      if (written != recs.Length) return "write_short:" + written;
      return "ok";
    } finally {
      CloseHandle(conin);
      FreeConsole();
    }
  }
}
'@
[ConInject]::Send($ProcessId, $Text)
`;

const PARENT_SCRIPT = `
param([int]$ProcessId)
(Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId").ParentProcessId
`;

async function listWindowsTui(): Promise<TuiProcess[]> {
  const raw = await runPowerShell(LIST_SCRIPT);
  const rows: TuiProcess[] = [];
  for (const item of parseJsonList(raw)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as {
      pid?: unknown;
      parentPid?: unknown;
      cwd?: unknown;
      commandLine?: unknown;
      name?: unknown;
    };
    const pid = typeof rec.pid === "number" ? rec.pid : Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const commandLine = typeof rec.commandLine === "string" ? rec.commandLine : undefined;
    const name = typeof rec.name === "string" ? rec.name : undefined;
    if (!isInteractiveTui(name, commandLine)) continue;
    const parentRaw =
      typeof rec.parentPid === "number" ? rec.parentPid : Number(rec.parentPid);
    const parentPid = Number.isInteger(parentRaw) && parentRaw > 0 ? parentRaw : undefined;
    const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : undefined;
    rows.push({ pid, cwd, parentPid });
  }
  return collapseTuiTree(rows);
}

async function listPosixTui(): Promise<TuiProcess[]> {
  const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,args="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return [];
  const rows: TuiProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const args = match[3];
    if (!isInteractiveTui(undefined, args)) continue;
    let cwd: string | undefined;
    try {
      cwd = (await Bun.file(`/proc/${pid}/cwd`).text().catch(() => "")).trim() || undefined;
    } catch {
      cwd = undefined;
    }
    rows.push({
      pid,
      cwd,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : undefined,
    });
  }
  return collapseTuiTree(rows);
}

export async function listTuiProcesses(): Promise<TuiProcess[]> {
  try {
    if (process.platform === "win32") return await listWindowsTui();
    return await listPosixTui();
  } catch {
    return [];
  }
}

export async function parentOf(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === "win32") {
      const raw = await runPowerShell(PARENT_SCRIPT, [String(pid)]);
      const value = Number(raw.trim());
      return Number.isInteger(value) && value > 0 ? value : undefined;
    }
    const proc = Bun.spawn(["ps", "-o", "ppid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return undefined;
    const value = Number(stdout.trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 往目标 TUI 控制台打字，相当于在编辑器里输入 `text`（含 Escape 清草稿）。 */
export async function typeIntoTui(pid: number, text: string): Promise<void> {
  if (process.platform === "win32") {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    const result = (await runPowerShell(INJECT_SCRIPT, [String(pid), b64])).trim();
    if (result !== "ok") {
      throw new Error(`无法附加到 pid ${pid} 的控制台（${result}）`);
    }
    return;
  }
  const proc = Bun.spawn(["bash", "-c", 'printf %s "$1" > "/proc/$2/fd/0"', "bash", text, String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `无法写入 pid ${pid} 的 stdin`);
}

export async function startCollabOnTui(pid: number): Promise<void> {
  await typeIntoTui(pid, "\u001b");
  await Bun.sleep(80);
  await typeIntoTui(pid, "/collab\r");
}
