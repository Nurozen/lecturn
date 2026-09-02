import { describe, expect, it } from "vite-plus/test";

import { UUID_NAMESPACE_DNS, uuidV5 } from "./uuid.ts";

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidV5", () => {
  it("matches the RFC 4122 reference vector for the DNS namespace", () => {
    expect(uuidV5(UUID_NAMESPACE_DNS, "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("emits lowercase hex with version 5 and RFC variant bits", () => {
    expect(uuidV5(UUID_NAMESPACE_DNS, "attachment-1:thread-2")).toMatch(UUID_V5_PATTERN);
  });

  it("is deterministic per name and distinct across names", () => {
    const first = uuidV5(UUID_NAMESPACE_DNS, "source:child");
    expect(uuidV5(UUID_NAMESPACE_DNS, "source:child")).toBe(first);
    expect(uuidV5(UUID_NAMESPACE_DNS, "source:other-child")).not.toBe(first);
  });

  it("rejects a malformed namespace uuid", () => {
    expect(() => uuidV5("not-a-uuid", "name")).toThrow();
  });
});
