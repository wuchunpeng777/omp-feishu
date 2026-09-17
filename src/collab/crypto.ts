/** 与 omp collab-web 一致的 AES-GCM 封包。 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export async function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new Error(`Room key must be 32 bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey(
    "raw",
    asArrayBuffer(raw),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealFrame(
  key: CryptoKey,
  payload: unknown,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(payload));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv, 0);
  out.set(cipher, 12);
  return out;
}

export async function openFrame(
  key: CryptoKey,
  sealed: Uint8Array,
): Promise<unknown> {
  if (sealed.byteLength <= 12) {
    throw new Error("Sealed frame too short");
  }
  const iv = asArrayBuffer(sealed.subarray(0, 12));
  const cipher = asArrayBuffer(sealed.subarray(12));
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher),
  );
  return JSON.parse(decoder.decode(plain));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const withPad =
    padded.length % 4 === 0
      ? padded
      : padded + "=".repeat(4 - padded.length % 4);
  try {
    const bin = atob(withPad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
