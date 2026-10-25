import { describe, expect, it } from "vite-plus/test";

import { isJsonRpcId, jsonBytes } from "./jsonRpcFrame.ts";

describe("jsonBytes", () => {
  it("counts UTF-8 bytes of the serialized value", () => {
    expect(jsonBytes({ a: 1 })).toBe(7);
    expect(jsonBytes("é")).toBe(4);
  });

  it("treats values JSON cannot serialize as unbounded or empty", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(jsonBytes(10n)).toBe(Number.POSITIVE_INFINITY);
    expect(jsonBytes(undefined)).toBe(0);
  });
});

describe("isJsonRpcId", () => {
  it("accepts strings and finite numbers only", () => {
    expect(isJsonRpcId("a")).toBe(true);
    expect(isJsonRpcId(0)).toBe(true);
    expect(isJsonRpcId(Number.NaN)).toBe(false);
    expect(isJsonRpcId(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonRpcId(null)).toBe(false);
    expect(isJsonRpcId(undefined)).toBe(false);
  });
});
