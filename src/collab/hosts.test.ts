import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listLiveConversations, mergeConversations, modelLabel, resolveConversation, type CollabHost, type LiveConversation } from "./hosts.ts";
import * as tui from "./tui.ts";

test("collab 主机与未分享 TUI 按 pid 合并", () => {
  const merged = mergeConversations(
    [
      {
        instanceId: "abc",
        pid: 10,
        sessionName: "live",
        cwd: "C:\\a",
        access: "control",
        relayConnected: true,
      },
    ],
    [
      { pid: 10, cwd: "C:\\a", sessionName: "ignored" },
      { pid: 20, cwd: "C:\\b", sessionName: "idle" },
    ],
  );
  expect(merged).toEqual([
    {
      sharing: true,
      pid: 10,
      instanceId: "abc",
      sessionId: undefined,
      sessionName: "live",
      cwd: "C:\\a",
      model: undefined,
      access: "control",
      relayConnected: true,
      inputRequired: undefined,
    },
    {
      sharing: false,
      pid: 20,
      cwd: "C:\\b",
      sessionId: undefined,
      sessionName: "idle",
    },
  ]);
});

test("跳过 omp.exe 包装进程，只留 bun agent 和未分享 TUI", () => {
  const merged = mergeConversations(
    [{ instanceId: "abc", pid: 303376, sessionName: "live" }],
    [
      { pid: 302348, cwd: "C:\\a" },
      { pid: 303376, parentPid: 302348, cwd: "C:\\a" },
      { pid: 10664, parentPid: 41812, cwd: "C:\\b", sessionName: "idle" },
    ],
  );
  expect(merged.map((row) => row.pid)).toEqual([10664, 303376]);
  expect(merged[0]).toMatchObject({ sharing: false, sessionName: "idle", parentPid: 41812 });
  expect(merged[1]).toMatchObject({ sharing: true, sessionName: "live", instanceId: "abc" });
});

test("按序号 pid instanceId 解析会话", () => {
  const rows = mergeConversations(
    [{ instanceId: "deadbeef", pid: 42, sessionName: "alpha" }],
    [{ pid: 99, sessionName: "beta" }],
  );
  expect(resolveConversation(rows, "1")?.sessionName).toBe("alpha");
  expect(resolveConversation(rows, "2")?.sessionName).toBe("beta");
  expect(resolveConversation(rows, "99")?.sharing).toBe(false);
  expect(resolveConversation(rows, "dead")?.instanceId).toBe("deadbeef");
  expect(resolveConversation(rows, "nope")).toBeUndefined();
});

test("模型对象压成 provider/id", () => {
  expect(modelLabel({ provider: "xai", id: "grok-4.6" })).toBe("xai/grok-4.6");
  expect(modelLabel("xai/grok-4.6")).toBe("xai/grok-4.6");
  expect(modelLabel(undefined)).toBeUndefined();
});

const fixtureCwd = join(homedir(), "omp-list-fixture");

async function withSessionFiles(
  hosts: CollabHost[],
  processes: tui.TuiProcess[],
  run: (dir: string, list: () => Promise<LiveConversation[]>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-list-names-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const spawn = Bun.spawn;
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: object) =>
    cmd[0] === "omp-name-fixture"
      ? spawn([process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify({ hosts }))})`], options)
      : spawn(cmd, options)) as typeof Bun.spawn);
  const tuiSpy = spyOn(tui, "listTuiProcesses").mockResolvedValue(processes);
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    const dir = join(root, "sessions", "-omp-list-fixture");
    await mkdir(dir, { recursive: true });
    await run(dir, () => listLiveConversations("omp-name-fixture"));
  } finally {
    spawnSpy.mockRestore();
    tuiSpy.mockRestore();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
}

test("未分享 TUI 列表读取当前 title，连续改名不沿用旧 session 标题", async () => {
  await withSessionFiles([], [{ pid: 10, cwd: fixtureCwd }], async (dir, list) => {
    const file = join(dir, "2026-10-28_active.jsonl");
    const header = JSON.stringify({ type: "session", id: "active", title: "自动生成的旧标题" });
    await writeFile(file, `${JSON.stringify({ type: "title", title: "改名后的项目" })}\n${header}\n`);
    expect((await list())[0]).toMatchObject({ sessionId: "active", sessionName: "改名后的项目" });
    await writeFile(file, `${JSON.stringify({ type: "title", title: "再次改名" })}\n${header}\n`);
    expect((await list())[0]?.sessionName).toBe("再次改名");
  });
});

test.each([
  ["旧版只有 session 头部", "", "旧版项目"],
  ["空 title 不复活旧名", JSON.stringify({ type: "title", title: "" }) + "\n", ""],
])("%s", async (_label, prefix, expected) => {
  await withSessionFiles([], [{ pid: 10, cwd: fixtureCwd }], async (dir, list) => {
    await writeFile(join(dir, "2026-10-28_legacy.jsonl"),
      prefix + JSON.stringify({ type: "session", id: "legacy", title: "旧版项目" }) + "\n");
    expect((await list())[0]?.sessionName).toBe(expected);
  });
});

test("已分享会话按 sessionId 刷新名字，不能串用同目录较新的会话", async () => {
  const hosts: CollabHost[] = [
    { instanceId: "a", pid: 10, cwd: fixtureCwd, sessionId: "first", sessionName: "缓存旧名" },
    { instanceId: "b", pid: 20, cwd: fixtureCwd, sessionId: "second", sessionName: "另一个缓存旧名" },
    { instanceId: "c", pid: 30, cwd: fixtureCwd, sessionId: "missing", sessionName: "保留主机名称" },
  ];
  await withSessionFiles(hosts, [], async (dir, list) => {
    for (const [id, title, time] of [["first", "第一个项目", 100], ["second", "第二个项目", 200]] as const) {
      const file = join(dir, `2026-10-28_${id}.jsonl`);
      await writeFile(file, [
        JSON.stringify({ type: "title", title }),
        JSON.stringify({ type: "session", id, title: "旧标题" }),
        "",
      ].join("\n"));
      await utimes(file, time, time);
    }
    expect((await list()).map(row => [row.sessionId, row.sessionName])).toEqual([
      ["first", "第一个项目"],
      ["second", "第二个项目"],
      ["missing", "保留主机名称"],
    ]);
  });
});
