import { expect, test } from "bun:test";
import { parseDotEnv, pidAlive } from "./daemon.ts";

test("当前进程活着，不存在的 pid 判死", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2_147_483_647)).toBe(false);
});

test("解析 .env 行", () => {
  const env = parseDotEnv(
    "# c\nFEISHU_APP_ID=cli_x\nexport OMP_CWD=\"C:\\\\repo\"\nEMPTY=\nNOEQ\n",
  );
  expect(env.FEISHU_APP_ID).toBe("cli_x");
  expect(env.OMP_CWD).toBe("C:\\\\repo");
  expect(env.EMPTY).toBe("");
  expect(env.NOEQ).toBeUndefined();
});
