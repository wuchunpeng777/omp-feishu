/** 解析 omp collab 链接（与 collab-web Sm() 对齐）。 */

import { decodeBase64Url } from "./crypto.ts";

export const KEY_BYTES = 32;
export const WRITE_TOKEN_BYTES = 16;
export const DEFAULT_RELAY = "wss://my.omp.sh";

export type ParsedCollabLink = {
  wsUrl: string;
  roomId: string;
  key: Uint8Array;
  writeToken?: Uint8Array;
};

export type LinkError = { error: string };

const ROOM_PATH =
  /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const LOCAL_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
};

function relayOrigin(origin: string): { origin: string } | LinkError {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { error: `Invalid relay URL: ${origin}` };
  }
  let scheme: string;
  switch (parsed.protocol) {
    case "wss:":
    case "https:":
      scheme = "wss:";
      break;
    case "ws:":
    case "http:":
      scheme = "ws:";
      break;
    default:
      return { error: `Unsupported relay URL scheme: ${parsed.protocol}` };
  }
  if (scheme === "ws:" && !LOCAL_HOSTS[parsed.hostname]) {
    return {
      error: "relay link must be wss:// (plain ws:// is only allowed for localhost)",
    };
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  return { origin: `${scheme}//${parsed.hostname}${port}` };
}

export function parseCollabLink(input: string): ParsedCollabLink | LinkError {
  let raw = input.trim().replace(/%23/gi, "#");
  const bare = BARE_LINK.exec(raw);
  if (bare) {
    raw = `${DEFAULT_RELAY}/r/${bare[1]}.${bare[2]}`;
  } else if (!raw.includes("://")) {
    raw = `wss://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Invalid collab link: ${input}` };
  }

  if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
    const nested = parseCollabLink(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    if (!("error" in nested)) return nested;
  }

  const origin = relayOrigin(url.origin);
  if ("error" in origin) return origin;

  const path = ROOM_PATH.exec(url.pathname);
  if (!path) {
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (hash && url.protocol !== "http:" && url.protocol !== "https:") {
      return parseCollabLink(hash);
    }
    return { error: "Collab link must contain a /r/<roomId> path" };
  }

  const roomId = path[1]!;
  const secret =
    path[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!secret) return { error: "Collab link is missing the <key> part" };

  const decoded = decodeBase64Url(secret);
  if (
    !decoded ||
    (decoded.byteLength !== KEY_BYTES &&
      decoded.byteLength !== KEY_BYTES + WRITE_TOKEN_BYTES)
  ) {
    return {
      error: "Collab link key must be 32 (view) or 48 (full) base64url bytes",
    };
  }

  const key = decoded.subarray(0, KEY_BYTES);
  const writeToken =
    decoded.byteLength > KEY_BYTES ? decoded.subarray(KEY_BYTES) : undefined;
  return {
    wsUrl: `${origin.origin}/r/${roomId}`,
    roomId,
    key,
    writeToken,
  };
}

export function isFullControl(link: ParsedCollabLink): boolean {
  return link.writeToken !== undefined && link.writeToken.byteLength === WRITE_TOKEN_BYTES;
}
