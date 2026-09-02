// @effect-diagnostics nodeBuiltinImport:off - deterministic v5 ids need node:crypto's synchronous sha1 digest; the Effect Crypto service does not expose one
import * as NodeCrypto from "node:crypto";

/** RFC 4122 name-space id for fully-qualified domain names. */
export const UUID_NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function parseUuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`Invalid namespace uuid: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Deterministic RFC 4122 version-5 uuid: sha1 of the namespace uuid's bytes
 * followed by the utf-8 name, with the version and variant bits set, rendered
 * as lowercase hex. The same (namespace, name) pair always yields the same id,
 * which makes derived ids (copied attachments, forked rows) idempotent across
 * retries.
 */
export function uuidV5(namespace: string, name: string): string {
  const digest = NodeCrypto.createHash("sha1")
    .update(parseUuidBytes(namespace))
    .update(name, "utf8")
    .digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
