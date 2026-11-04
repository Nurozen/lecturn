import { describe, expect, it } from "vite-plus/test";

import {
  buildNewThreadLink,
  parseNewThreadLink,
  parseSquireLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
  sanitizeLinkedPrompt,
  squireLinkAppPath,
  withoutPromptLinkParams,
} from "./promptLinks.ts";

describe("sanitizeLinkedPrompt", () => {
  it("removes characters a reader cannot see and counts them", () => {
    const tagged = "rate me" + String.fromCodePoint(0xe0041, 0xe0042);
    expect(sanitizeLinkedPrompt(`a\u200Bb\u202Ec\uFEFF${tagged}`)).toEqual({
      text: "abcrate me",
      hiddenCharacters: 5,
    });
    expect(sanitizeLinkedPrompt("a\u2028b\u2029c")).toEqual({
      text: "a\nb\nc",
      hiddenCharacters: 0,
    });
  });

  it("keeps emoji sequences intact", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heart = "\u2764\uFE0F";
    expect(sanitizeLinkedPrompt(`${family} ${heart}`)).toEqual({
      text: `${family} ${heart}`,
      hiddenCharacters: 0,
    });
    expect(sanitizeLinkedPrompt("a\u200Db").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{1F468}\u200D").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{20000}\u200D\u{20001}").hiddenCharacters).toBe(1);
  });
});

describe("parseNewThreadLink", () => {
  it("reads a shared prompt with its optional repository and model", () => {
    const result = parseNewThreadLink(
      "?prompt=Rate+me&repo=https://github.com/Nurozen/lecturn.git&provider=Codex&model=gpt-5",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Rate me", hiddenCharacters: 0 },
        repository: { owner: "Nurozen", name: "lecturn" },
        provider: "codex",
        model: "gpt-5",
      },
    });
  });

  it("reads a pull request link, whose prompt is optional", () => {
    for (const pr of [
      "Nurozen/lecturn/42",
      "Nurozen/lecturn%2342",
      "https://github.com/Nurozen/lecturn/pull/42/files",
    ]) {
      expect(parseNewThreadLink(`?pr=${pr}`)).toEqual({
        ok: true,
        value: {
          kind: "pull-request",
          pullRequest: { owner: "Nurozen", name: "lecturn", number: 42 },
          prompt: null,
        },
      });
    }
  });

  it("refuses links it cannot open safely", () => {
    expect(parseNewThreadLink("?repo=a/b").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseThreadLinkPrompt("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&repo=../etc").ok).toBe(false);
    expect(parseNewThreadLink(`?prompt=${"x".repeat(8_001)}`).ok).toBe(false);
  });
});

describe("thread links", () => {
  it("reads the prompt and leaves other parameters in place", () => {
    expect(parseThreadLinkPrompt("?prompt=Fix+it")).toEqual({
      ok: true,
      value: { text: "Fix it", hiddenCharacters: 0 },
    });
    expect(parseThreadLinkPrompt("?panel=diff")).toEqual({ ok: true, value: null });
    expect(withoutPromptLinkParams("?prompt=x&panel=diff")).toBe("?panel=diff");
  });
});

describe("link round trips", () => {
  it("builds a link that parses back to the same prompt", () => {
    const link = buildNewThreadLink({
      prompt: "Swear count & rating?",
      repository: { owner: "Nurozen", name: "lecturn" },
      provider: "claudeAgent",
      model: "opus",
    });
    const path = promptLinkAppPath(link);
    expect(path).toBe(new URL(link).pathname + new URL(link).search);
    const parsed = parseNewThreadLink(new URL(link).search);
    expect(parsed.ok && parsed.value.kind === "new" && parsed.value.prompt.text).toBe(
      "Swear count & rating?",
    );
  });

  it("maps app scheme and hosted links to in-app paths, and nothing else", () => {
    expect(promptLinkAppPath("lecturn://new?prompt=hi")).toBe("/new?prompt=hi");
    expect(promptLinkAppPath("lecturn-dev://threads/env-1/thread-1")).toBe("/env-1/thread-1");
    expect(promptLinkAppPath("https://lecturn.cloudgatherer.net/env-1/thread-1?prompt=go")).toBe(
      "/env-1/thread-1?prompt=go",
    );
    expect(promptLinkAppPath("https://lecturn.cloudgatherer.net/settings/general")).toBeNull();
    expect(promptLinkAppPath("https://evil.test/new?prompt=hi")).toBeNull();
    expect(promptLinkAppPath("lecturn://app/index.html")).toBeNull();
    expect(promptLinkAppPath("lecturn-thread://threads/env-1/thread-1")).toBeNull();
  });

  it("hands an in-app path to the installed app", () => {
    expect(promptLinkDeepLink("/new?prompt=hi")).toBe("lecturn://new?prompt=hi");
    expect(promptLinkDeepLink("/env-1/thread-1?prompt=hi")).toBe(
      "lecturn://threads/env-1/thread-1?prompt=hi",
    );
  });

  it("maps Squire deep links both ways", () => {
    expect(promptLinkAppPath("lecturn://squires/env-1/squire-1?item=card-1")).toBe(
      "/squires/env-1/squire-1?item=card-1",
    );
    expect(promptLinkAppPath("lecturn-dev://squires/env-1/squire-1")).toBe(
      "/squires/env-1/squire-1",
    );
    expect(promptLinkAppPath("lecturn://squires/env-1")).toBeNull();
    expect(promptLinkAppPath("lecturn://squires/env-1/squire-1/extra")).toBeNull();
    expect(
      promptLinkAppPath("https://lecturn.cloudgatherer.net/squires/env-1/squire-1"),
    ).toBeNull();
    expect(promptLinkDeepLink("/squires/env-1/squire-1?item=card-1")).toBe(
      "lecturn://squires/env-1/squire-1?item=card-1",
    );
    const link = promptLinkDeepLink("/squires/env-1/squire-1?item=card-1", "lecturn-preview");
    expect(promptLinkAppPath(link)).toBe("/squires/env-1/squire-1?item=card-1");
  });

  it("maps Squire room deep links both ways", () => {
    expect(promptLinkAppPath("lecturn://squires/env-1/rooms/room-1")).toBe(
      "/squires/env-1/rooms/room-1",
    );
    expect(promptLinkAppPath("lecturn://squires/env-1/rooms")).toBeNull();
    expect(promptLinkAppPath("lecturn://squires/env-1/rooms/room-1/extra")).toBeNull();
    expect(promptLinkDeepLink("/squires/env-1/rooms/room-1")).toBe(
      "lecturn://squires/env-1/rooms/room-1",
    );
  });

  it("reads Squire links for in-app navigation", () => {
    expect(parseSquireLink("lecturn://squires/env-1/squire-1?item=card-1&x=1")).toEqual({
      kind: "squire",
      environmentId: "env-1",
      squireId: "squire-1",
      item: "card-1",
    });
    expect(parseSquireLink("lecturn://squires/env-1/squire-1?item=")).toMatchObject({
      item: null,
    });
    expect(parseSquireLink("lecturn://squires/env%201/rooms/room-1")).toEqual({
      kind: "room",
      environmentId: "env 1",
      roomId: "room-1",
    });
    for (const refused of [
      "lecturn://threads/env-1/thread-1",
      "lecturn://apps/com.rw",
      "lecturn://squires/env-1",
      "lecturn://squires/env-1/%E0",
      "lecturn-thread://squires/env-1/squire-1",
      "https://lecturn.cloudgatherer.net/squires/env-1/squire-1",
    ]) {
      expect(parseSquireLink(refused)).toBeNull();
    }
    expect(
      squireLinkAppPath({ kind: "squire", environmentId: "env 1", squireId: "s", item: "c&d" }),
    ).toBe("/squires/env%201/s?item=c%26d");
  });

  it("maps app deep links both ways", () => {
    expect(promptLinkAppPath("lecturn://apps/com.rw")).toBe("/apps/com.rw");
    expect(promptLinkAppPath("lecturn-preview://apps/com.rw/threads/env-1/thread-1")).toBe(
      "/env-1/thread-1?sidebar=apps&app=com.rw",
    );
    expect(promptLinkAppPath("lecturn://apps/not-an-app-id")).toBeNull();
    expect(promptLinkAppPath("https://lecturn.cloudgatherer.net/apps/com.rw")).toBeNull();
    expect(promptLinkDeepLink("/apps/com.rw")).toBe("lecturn://apps/com.rw");
    expect(promptLinkDeepLink("/env-1/thread-1?sidebar=apps&app=com.rw", "lecturn-dev")).toBe(
      "lecturn-dev://apps/com.rw/threads/env-1/thread-1",
    );
  });
});
