import { describe, expect, it } from "@effect/vitest";

import { createMemoryStorage, installEmbedMemoryStorage } from "./embedPersistence";

describe("embed memory storage", () => {
  it("shadows the page's localStorage so writes never reach the shared origin store", () => {
    const shared = createMemoryStorage();
    shared.setItem("lecturn:ui-state:v1", "user");
    const page = {};
    Object.defineProperty(page, "localStorage", { configurable: true, get: () => shared });

    expect(installEmbedMemoryStorage(page)).toBe(true);
    const storage = (page as { localStorage: Storage }).localStorage;
    expect(storage.getItem("lecturn:ui-state:v1")).toBeNull();
    storage.setItem("lecturn:ui-state:v1", "embed");
    storage.setItem("lecturn:composer-drafts", "draft");

    expect(shared.getItem("lecturn:ui-state:v1")).toBe("user");
    expect(shared.length).toBe(1);
    expect(storage.length).toBe(2);
    expect(storage.key(1)).toBe("lecturn:composer-drafts");
    storage.removeItem("lecturn:composer-drafts");
    expect(storage.getItem("lecturn:composer-drafts")).toBeNull();
  });
});
