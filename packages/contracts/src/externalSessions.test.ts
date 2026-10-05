import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EXTERNAL_SESSIONS_LIST_MAX_LIMIT,
  ExternalSessionsListError,
  ExternalSessionsListInput,
} from "./externalSessions.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

describe("ExternalSessionsListInput", () => {
  const decodeInput = Schema.decodeUnknownSync(ExternalSessionsListInput);

  it("rejects limits above the ceiling", () => {
    expect(
      decodeInput({ providerInstanceId: "codex", limit: EXTERNAL_SESSIONS_LIST_MAX_LIMIT }).limit,
    ).toBe(EXTERNAL_SESSIONS_LIST_MAX_LIMIT);
    expect(() =>
      decodeInput({ providerInstanceId: "codex", limit: EXTERNAL_SESSIONS_LIST_MAX_LIMIT + 1 }),
    ).toThrow();
    expect(() => decodeInput({ providerInstanceId: "codex", limit: 0 })).toThrow();
  });
});

describe("ExternalSessionsListError", () => {
  it("derives a stable message from request context without leaking the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new ExternalSessionsListError({
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      reason: "unreadable",
      cwd: "/workspace",
      cause,
    });

    expect(error.message).toBe(
      "Failed to list external sessions for provider 'claudeAgent' in '/workspace' (unreadable).",
    );
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });
});
