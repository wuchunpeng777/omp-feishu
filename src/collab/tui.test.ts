import { expect, test } from "bun:test";
import {
  collapseTuiTree,
  isInteractiveTui,
  isRpcCommand,
} from "./tui.ts";

test("rpc 和 worker 不是可接入 TUI", () => {
  expect(isRpcCommand("omp --mode rpc")).toBe(true);
  expect(isInteractiveTui("omp.exe", "omp --mode rpc")).toBe(false);
  expect(
    isInteractiveTui(
      "bun.exe",
      'bun "C:\\x\\pi-coding-agent\\dist\\cli.js" --mode rpc',
    ),
  ).toBe(false);
  expect(
    isInteractiveTui(
      "bun.exe",
      "bun C:\\x\\pi-coding-agent\\dist\\cli.js __omp_worker_daemon_broker",
    ),
  ).toBe(false);
});

test("omp 包装进程和 bun agent 都算交互 TUI", () => {
  expect(isInteractiveTui("omp.exe", '"C:\\Users\\TU\\.bun\\bin\\omp.exe"')).toBe(true);
  expect(
    isInteractiveTui("bun.exe", 'bun "C:\\x\\pi-coding-agent\\dist\\cli.js"'),
  ).toBe(true);
});

test("同一棵进程树只留子 agent", () => {
  expect(
    collapseTuiTree([
      { pid: 302348, parentPid: 299340, cwd: "C:\\a" },
      { pid: 303376, parentPid: 302348, cwd: "C:\\a" },
      { pid: 10664, parentPid: 41812, cwd: "C:\\b" },
    ]),
  ).toEqual([
    { pid: 10664, parentPid: 41812, cwd: "C:\\b" },
    { pid: 303376, parentPid: 302348, cwd: "C:\\a" },
  ]);
});
