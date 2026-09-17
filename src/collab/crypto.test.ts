import { expect, test } from "bun:test";
import { decodeBase64Url, encodeBase64Url, importRoomKey, openFrame, sealFrame } from "./crypto.ts";
import { parseCollabLink } from "./link.ts";

test("AES-GCM 封包可往返", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await importRoomKey(raw);
  const payload = { t: "hello", proto: 3, name: "飞书" };
  const sealed = await sealFrame(key, payload);
  expect(sealed.byteLength).toBeGreaterThan(12);
  expect(await openFrame(key, sealed)).toEqual(payload);
});

test("解析浏览器 collab 深链", () => {
  const key = crypto.getRandomValues(new Uint8Array(48));
  const secret = encodeBase64Url(key);
  const roomId = "mgAYTZwEnpRQtca0CTgn-Q";
  const parsed = parseCollabLink(`https://my.omp.sh/#${roomId}.${secret}`);
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.roomId).toBe(roomId);
  expect(parsed.wsUrl).toBe(`wss://my.omp.sh/r/${roomId}`);
  expect(parsed.key.byteLength).toBe(32);
  expect(parsed.writeToken?.byteLength).toBe(16);
});

test("解析 32 字节 view-only 密钥", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const secret = encodeBase64Url(key);
  const parsed = parseCollabLink(`roomidvalue.${secret}`);
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.writeToken).toBeUndefined();
});

test("base64url 往返", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  expect([...decodeBase64Url(encodeBase64Url(bytes))!]).toEqual([...bytes]);
});
