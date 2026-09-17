/** 重组 omp RPC v2 的 rpc_chunk 帧。 */

export type RpcChunk = {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
};

type Pending = {
  count: number;
  byteLength: number;
  parts: Array<string | undefined>;
};

export class FrameAssembler {
  private readonly pending = new Map<string, Pending>();

  ingest(obj: Record<string, unknown>): Record<string, unknown> | undefined {
    if (obj.type !== "rpc_chunk") return obj;
    const chunkId = String(obj.chunkId ?? "");
    const index = Number(obj.index);
    const count = Number(obj.count);
    const byteLength = Number(obj.byteLength);
    const data = String(obj.data ?? "");
    if (!chunkId || count <= 0 || index < 0 || index >= count) {
      throw new Error("malformed rpc_chunk");
    }
    let buf = this.pending.get(chunkId);
    if (!buf) {
      buf = { count, byteLength, parts: Array.from({ length: count }) };
      this.pending.set(chunkId, buf);
    }
    buf.parts[index] = data;
    for (const part of buf.parts) {
      if (part === undefined) return undefined;
    }
    this.pending.delete(chunkId);
    const bytes = Buffer.concat(buf.parts.map((part) => Buffer.from(part!, "base64")));
    if (bytes.byteLength !== byteLength) {
      throw new Error(
        `rpc_chunk byteLength mismatch: got ${bytes.byteLength} want ${byteLength}`,
      );
    }
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  }
}
