import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  __resetEmbedAuthForTests,
  consumeEmbedHash,
  isEmbedLocation,
  parseEmbedHash,
  readEmbedBearerToken,
  readEmbedParentOrigin,
  setEmbedToken,
  stripEmbedHash,
} from "./embedAuth";

function installWindow(href: string) {
  const replaced: string[] = [];
  const location = new URL(href);
  const history = {
    state: { __TSR_key: "k" } as unknown,
    replaceState(state: unknown, _unused: string, next: string) {
      history.state = state;
      replaced.push(next);
      const url = new URL(next);
      location.hash = url.hash;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location, history },
  });
  return { replaced, history, location };
}

describe("isEmbedLocation", () => {
  it("matches only the /embed/ subtree", () => {
    expect(isEmbedLocation({ pathname: "/embed/env-1/project-1" })).toBe(true);
    expect(isEmbedLocation({ pathname: "/embed" })).toBe(false);
    expect(isEmbedLocation({ pathname: "/embedded/x" })).toBe(false);
    expect(isEmbedLocation({ pathname: "/env-1/thread-1" })).toBe(false);
  });
});

describe("parseEmbedHash", () => {
  it("reads the token and a valid parent origin", () => {
    expect(parseEmbedHash("#embedToken=abc&parentOrigin=http%3A%2F%2F127.0.0.1%3A5173")).toEqual({
      token: "abc",
      parentOrigin: "http://127.0.0.1:5173",
      switcher: true,
    });
  });

  it("hides the thread switcher only when the host asks", () => {
    expect(parseEmbedHash("#embedToken=abc&switcher=0")?.switcher).toBe(false);
    expect(parseEmbedHash("#embedToken=abc&switcher=1")?.switcher).toBe(true);
  });

  it("drops a parent origin that is not a bare origin", () => {
    expect(parseEmbedHash("#embedToken=abc&parentOrigin=http://127.0.0.1:5173/path")).toEqual({
      token: "abc",
      parentOrigin: null,
      switcher: true,
    });
    expect(parseEmbedHash("#embedToken=abc&parentOrigin=nope")?.parentOrigin).toBeNull();
  });

  it("ignores hashes without an embed token, including pairing tokens", () => {
    expect(parseEmbedHash("")).toBeNull();
    expect(parseEmbedHash("#token=pairing")).toBeNull();
    expect(parseEmbedHash("#embedToken=")).toBeNull();
  });
});

describe("stripEmbedHash", () => {
  it("removes the embed keys and keeps the rest", () => {
    expect(stripEmbedHash("http://h/embed/e/p#embedToken=abc&parentOrigin=x&switcher=0")).toBe(
      "http://h/embed/e/p",
    );
    expect(stripEmbedHash("http://h/embed/e/p#embedToken=abc&other=1")).toBe(
      "http://h/embed/e/p#other=1",
    );
  });

  it("leaves unrelated URLs untouched", () => {
    expect(stripEmbedHash("http://h/pair#token=t")).toBe("http://h/pair#token=t");
  });
});

describe("embed credential store", () => {
  beforeEach(() => {
    __resetEmbedAuthForTests();
  });

  afterEach(() => {
    __resetEmbedAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("takes the token out of the address bar once and keeps router history state", async () => {
    const { replaced, history, location } = installWindow(
      "http://127.0.0.1:3773/embed/env-1/project-1#embedToken=tok-1&parentOrigin=http%3A%2F%2Flocalhost%3A5173",
    );

    await expect(readEmbedBearerToken()).resolves.toBe("tok-1");
    expect(readEmbedParentOrigin()).toBe("http://localhost:5173");
    expect(replaced).toEqual(["http://127.0.0.1:3773/embed/env-1/project-1"]);
    expect(location.hash).toBe("");
    expect(history.state).toEqual({ __TSR_key: "k" });

    // A second read must not re-parse a hash the router might have restored.
    location.hash = "#embedToken=stale";
    await expect(readEmbedBearerToken()).resolves.toBe("tok-1");
    expect(replaced).toHaveLength(1);
  });

  it("serves a refreshed token on the next read", async () => {
    installWindow("http://127.0.0.1:3773/embed/env-1/project-1#embedToken=tok-1");
    expect(consumeEmbedHash()?.token).toBe("tok-1");

    setEmbedToken("tok-2");
    await expect(readEmbedBearerToken()).resolves.toBe("tok-2");
  });

  it("has no bearer when the page was opened without one", async () => {
    const { replaced } = installWindow("http://127.0.0.1:3773/embed/env-1/project-1");
    await expect(readEmbedBearerToken()).resolves.toBeNull();
    expect(replaced).toEqual([]);
  });
});
