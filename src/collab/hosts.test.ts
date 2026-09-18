import { expect, test } from "bun:test";
import { mergeConversations, modelLabel, resolveConversation } from "./hosts.ts";

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
