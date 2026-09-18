import { expect, test } from "bun:test";
import { assistantTurnError, retryFinalError } from "./session.ts";

test("agent_end 抽出助手 stopReason=error", () => {
  const text = assistantTurnError({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "429 overloaded" }],
      },
    ],
  });
  expect(text).toBe("429 overloaded");
});

test("willRetry 的 agent_end 不当成终态错误", () => {
  expect(
    assistantTurnError({
      type: "agent_end",
      willRetry: true,
      errorMessage: "529 overloaded",
      messages: [{ role: "assistant", stopReason: "error" }],
    }),
  ).toBeUndefined();
});

test("自动重试最终失败抽出 finalError", () => {
  expect(
    retryFinalError({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded_error: Overloaded",
    }),
  ).toBe("529 overloaded_error: Overloaded");
});

test("自动重试成功不报错", () => {
  expect(retryFinalError({ type: "auto_retry_end", success: true, attempt: 2 })).toBeUndefined();
});
