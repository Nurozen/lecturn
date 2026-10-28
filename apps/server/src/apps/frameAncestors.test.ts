import { expect, it } from "@effect/vitest";
import { AppsError } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as FrameAncestors from "./frameAncestors.ts";
import { AppRegistryService } from "./services.ts";
import { makeAppStatus } from "./testing/appStatusFixture.ts";

const apps = [
  makeAppStatus({
    appId: "dev.example.one",
    state: "granted",
    embedOrigins: ["http://127.0.0.1:5173", "http://localhost:*"],
  }),
  makeAppStatus({
    appId: "dev.example.two",
    state: "granted",
    embedOrigins: ["http://127.0.0.1:5173", "https://127.0.0.1:8443"],
  }),
  makeAppStatus({
    appId: "dev.example.denied",
    state: "denied",
    embedOrigins: ["http://127.0.0.1:1"],
  }),
  makeAppStatus({
    appId: "dev.example.revoked",
    state: "revoked",
    embedOrigins: ["http://127.0.0.1:2"],
  }),
  makeAppStatus({
    appId: "dev.example.pending",
    state: "pairing-requested",
    embedOrigins: ["http://127.0.0.1:3"],
  }),
];

const csp = (headers: Readonly<Record<string, string>>) => headers["Content-Security-Policy"];

const withRegistry = (list: AppRegistryService["Service"]["list"]) => {
  const calls = { count: 0 };
  const layer = Layer.mock(AppRegistryService)({
    list: Effect.suspend(() => {
      calls.count++;
      return list;
    }),
  });
  return { calls, layer };
};

describe("frameAncestors", () => {
  it("matches the embed route and nothing that merely shares its prefix", () => {
    expect(FrameAncestors.isEmbedPath("/embed")).toBe(true);
    expect(FrameAncestors.isEmbedPath("/embed/env/project/thread")).toBe(true);
    expect(FrameAncestors.isEmbedPath("/embedded")).toBe(false);
    expect(FrameAncestors.isEmbedPath("/threads/embed/x")).toBe(false);
  });

  it("lists only granted apps' origins, as declared and once each", () => {
    expect(FrameAncestors.embedFrameAncestorSources(apps)).toEqual([
      "'self'",
      "http://127.0.0.1:5173",
      "http://localhost:*",
      "https://127.0.0.1:8443",
    ]);
    expect(FrameAncestors.embedFrameAncestorSources([])).toEqual(["'self'"]);
  });

  it.effect("frames /embed for granted origins and every other page for Lecturn only", () => {
    const registry = withRegistry(Effect.succeed(apps));
    return Effect.gen(function* () {
      const headersFor = yield* FrameAncestors.make;
      expect(csp(yield* headersFor("/embed/env/project"))).toBe(
        "frame-ancestors 'self' http://127.0.0.1:5173 http://localhost:* https://127.0.0.1:8443",
      );
      const before = registry.calls.count;
      for (const pathname of ["/", "/index.html", "/threads/abc", "/pair", "/embedded"]) {
        expect(csp(yield* headersFor(pathname))).toBe("frame-ancestors 'self'");
      }
      expect(registry.calls.count).toBe(before);
    }).pipe(Effect.provide(registry.layer));
  });

  it.effect("reads grants per request, so a revoke stops framing without a restart", () => {
    let current = apps;
    const registry = withRegistry(Effect.sync(() => current));
    return Effect.gen(function* () {
      const headersFor = yield* FrameAncestors.make;
      expect(csp(yield* headersFor("/embed/env/project"))).toContain("http://127.0.0.1:5173");
      current = [];
      expect(csp(yield* headersFor("/embed/env/project"))).toBe("frame-ancestors 'self'");
    }).pipe(Effect.provide(registry.layer));
  });

  it.effect("falls back to Lecturn-only framing when the grants cannot be read", () => {
    const registry = withRegistry(
      Effect.fail(new AppsError({ code: "unavailable", message: "storage down" })),
    );
    return Effect.gen(function* () {
      const headersFor = yield* FrameAncestors.make;
      expect(csp(yield* headersFor("/embed/env/project"))).toBe("frame-ancestors 'self'");
    }).pipe(Effect.provide(registry.layer));
  });
});
