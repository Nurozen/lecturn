// Shared by the MCP Apps host and the embed bridge peers, which cannot depend on each other's packages.

export type JsonRpcId = string | number;

export const JSON_RPC_MAX_MESSAGE_BYTES = 256 * 1024;
export const JSON_RPC_MAX_PENDING_REQUESTS = 16;

const encoder = new TextEncoder();

/** UTF-8 size of the serialized message; unserializable values count as over any cap. */
export function jsonBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
