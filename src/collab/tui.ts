/** 发现本机交互式 omp TUI，并向其注入 /collab。 */

export type TuiProcess = {
  pid: number;
  cwd?: string;
};

function isRpcCommand(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  return /(?:^|\s)--mode(?:\s+|=)rpc(?:-ui)?(?:\s|$)/.test(commandLine);
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
Get-CimInstance Win32_Process -Filter "Name='omp.exe'" | ForEach-Object {
  $cmd = [string]$_.CommandLine
  if ($cmd -match '--mode(\\s+|=)rpc') { return }
  [pscustomobject]@{
    pid = $_.ProcessId
    cwd = [ProcCwd]::Get($_.ProcessId)
    commandLine = $cmd
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
  const uint WM_CHAR = 0x0102;
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] r, int n, out int w);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
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
    rec.KeyEvent.UnicodeChar = ch;
    rec.KeyEvent.wVirtualKeyCode = ch == (char)13 ? (ushort)0x0D : ch == (char)27 ? (ushort)0x1B : (ushort)char.ToUpper(ch);
    return rec;
  }
  public static string Send(int pid, string text) {
    FreeConsole();
    if (!AttachConsole((uint)pid)) return "attach_failed";
    try {
      IntPtr hwnd = GetConsoleWindow();
      IntPtr hin = GetStdHandle(-10);
      foreach (char ch in text) {
        if (hwnd != IntPtr.Zero) PostMessage(hwnd, WM_CHAR, (IntPtr)ch, IntPtr.Zero);
        if (hin != IntPtr.Zero && hin != new IntPtr(-1)) {
          INPUT_RECORD[] recs = new INPUT_RECORD[] { Key(true, ch), Key(false, ch) };
          int written;
          WriteConsoleInput(hin, recs, 2, out written);
        }
      }
      return "ok";
    } finally { FreeConsole(); }
  }
}
'@
[ConInject]::Send($ProcessId, $Text)
`;

async function listWindowsTui(): Promise<TuiProcess[]> {
  const raw = await runPowerShell(LIST_SCRIPT);
  const rows: TuiProcess[] = [];
  for (const item of parseJsonList(raw)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { pid?: unknown; cwd?: unknown; commandLine?: unknown };
    const pid = typeof rec.pid === "number" ? rec.pid : Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isRpcCommand(typeof rec.commandLine === "string" ? rec.commandLine : undefined)) continue;
    const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : undefined;
    rows.push({ pid, cwd });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

async function listPosixTui(): Promise<TuiProcess[]> {
  const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,args="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return [];
  const rows: TuiProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2];
    if (!/(^|[\\/])omp(\.exe)?(\s|$)/.test(args) && !args.includes("pi-coding-agent")) continue;
    if (isRpcCommand(args)) continue;
    if (args.includes("__omp_worker") || args.includes("omp-feishu")) continue;
    let cwd: string | undefined;
    try {
      cwd = (await Bun.file(`/proc/${pid}/cwd`).text().catch(() => "")).trim() || undefined;
    } catch {
      cwd = undefined;
    }
    if (!cwd) {
      try {
        const link = await Bun.spawn(["readlink", "-f", `/proc/${pid}/cwd`], { stdout: "pipe" }).exited;
        void link;
      } catch {
        /* ignore */
      }
    }
    rows.push({ pid, cwd });
  }
  return rows;
}

export async function listTuiProcesses(): Promise<TuiProcess[]> {
  try {
    if (process.platform === "win32") return await listWindowsTui();
    return await listPosixTui();
  } catch {
    return [];
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
  await typeIntoTui(pid, `\u001b/collab\r`);
}
