import { describe, expect, it, vi } from "vite-plus/test";

const registry = vi.hoisted(() => ({
  squire: true,
  shell: null as { readonly squire?: { squireId: string; role: "home" | "probe" } } | null,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: { readonly kind: string }) =>
      atom.kind === "config"
        ? { environment: { capabilities: { squire: registry.squire } } }
        : registry.shell,
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({ kind: "config" }) },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => ({ kind: "shell" }) },
}));
vi.mock("../../state/squire", () => ({}));

import { extractAgentNotificationDeepLink } from "../agent-awareness/notificationPayload";
import {
  appSquireHomeThreadLookup,
  parseSquireRoutePath,
  resolveSquireThreadPath,
  type SquireHomeThreadLookup,
} from "./squireLinks";

const homeOf: SquireHomeThreadLookup = (environmentId, threadId) =>
  environmentId === "env 1" && threadId === "home" ? "sq/1" : null;

function resolveWith(
  shell: (typeof registry)["shell"],
  path = "/threads/env-1/home-thread",
  squire = true,
) {
  registry.shell = shell;
  registry.squire = squire;
  return resolveSquireThreadPath(path, appSquireHomeThreadLookup);
}

describe("resolveSquireThreadPath", () => {
  it("opens a marked home thread's Squire screen", () => {
    expect(resolveWith({ squire: { squireId: "release", role: "home" } })).toBe(
      "/squires/env-1/release",
    );
  });

  it("keeps a probe fork, an ordinary thread, and an unhydrated shell on the thread", () => {
    expect(resolveWith({ squire: { squireId: "release", role: "probe" } })).toBe(
      "/threads/env-1/home-thread",
    );
    expect(resolveWith({})).toBe("/threads/env-1/home-thread");
    expect(resolveWith(null)).toBe("/threads/env-1/home-thread");
  });

  it("keeps the thread path while the environment does not advertise Squires", () => {
    expect(resolveWith({ squire: { squireId: "release", role: "home" } }, undefined, false)).toBe(
      "/threads/env-1/home-thread",
    );
  });

  it("preserves the account query a notification tap adds", () => {
    const tap = extractAgentNotificationDeepLink({
      notification: {
        request: { content: { data: { environmentId: "env 1", threadId: "home" } } },
      },
    });
    expect(resolveSquireThreadPath(`${tap}?accountId=acct`, homeOf)).toBe(
      "/squires/env%201/sq%2F1?accountId=acct",
    );
  });

  it("rewrites React Navigation's slashless paths and leaves thread sub-routes alone", () => {
    expect(resolveSquireThreadPath("threads/env%201/home", homeOf)).toBe("squires/env%201/sq%2F1");
    expect(resolveSquireThreadPath("/threads/env%201/home/files", homeOf)).toBe(
      "/threads/env%201/home/files",
    );
    expect(resolveSquireThreadPath("/threads/env%201/%E0%A4%A", homeOf)).toBe(
      "/threads/env%201/%E0%A4%A",
    );
  });
});

describe("parseSquireRoutePath", () => {
  it("reads a Squire screen but not a room", () => {
    expect(parseSquireRoutePath("/squires/env%201/sq%2F1?item=card-1")).toEqual({
      environmentId: "env 1",
      squireId: "sq/1",
    });
    expect(parseSquireRoutePath("/squires/env-1/rooms/room-1")).toBeNull();
    expect(parseSquireRoutePath("/threads/env-1/home")).toBeNull();
  });
});
