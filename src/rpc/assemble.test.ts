import { expect, test } from "bun:test";
import { FrameAssembler } from "./assemble.ts";

test("非 chunk 原样返回", () => {
  const assembler = new FrameAssembler();
  const frame = { type: "ready", protocolVersion: 1 };
  expect(assembler.ingest(frame)).toEqual(frame);
});

test("按 index 拼回完整 JSON", () => {
  const assembler = new FrameAssembler();
  const payload = { type: "response", command: "get_state", success: true };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const mid = Math.ceil(bytes.byteLength / 2);
  const chunks = [bytes.subarray(0, mid), bytes.subarray(mid)];
  expect(
    assembler.ingest({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index: 1,
      count: 2,
      byteLength: bytes.byteLength,
      data: chunks[1]!.toString("base64"),
    }),
  ).toBeUndefined();
  expect(
    assembler.ingest({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index: 0,
      count: 2,
      byteLength: bytes.byteLength,
      data: chunks[0]!.toString("base64"),
    }),
  ).toEqual(payload);
});

test("byteLength 对不上就抛", () => {
  const assembler = new FrameAssembler();
  expect(() =>
    assembler.ingest({
      type: "rpc_chunk",
      chunkId: "rpc-2",
      index: 0,
      count: 1,
      byteLength: 99,
      data: Buffer.from("{}").toString("base64"),
    }),
  ).toThrow(/byteLength/);
});
