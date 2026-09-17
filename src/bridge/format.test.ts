import { expect, test } from "bun:test";
import { formatSnapshot } from "./format.ts";
import type { GuestSnapshot } from "../collab/types.ts";

function snap(partial: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    status: "live",
    readOnly: false,
    header: { title: "omp", cwd: "/tmp" },
    entries: [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ],
    state: { isStreaming: false, model: { provider: "x", id: "y" } },
    agents: [],
    streamingEnded: true,
    tools: [],
    subagentProgress: [],
    subagentLifecycle: [],
    notices: [],
    ...partial,
  };
}

test("collab 卡片有离开", () => {
  const view = formatSnapshot(snap(), "demo");
  expect(view.buttons.map((b) => b.action)).toContain("leave");
  expect(view.buttons.map((b) => b.action)).toContain("abort");
});

test("RPC 卡片不露离开", () => {
  const view = formatSnapshot(snap(), "omp", { showLeave: false });
  expect(view.buttons.map((b) => b.action)).not.toContain("leave");
  expect(view.markdown).toContain("/tmp");
  expect(view.markdown).toContain("hi");
});
