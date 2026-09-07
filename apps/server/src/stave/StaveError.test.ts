import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  STAVE_CLI_ERROR_CODES,
  STAVE_ERROR_CODES,
  STAVE_HOST_ERROR_CODES,
  StaveError,
  isStaveErrorCode,
  normalizeStaveErrorCode,
  parseStaveErrorEnvelope,
  type StaveErrorEnvelope,
} from "./StaveError.ts";
import {
  SAMPLE_ERROR_CONFIG_EXISTS,
  SAMPLE_ERROR_DIRTY_WORKTREES,
  SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_ADD,
  SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_RETARGET,
  SAMPLE_ERROR_REPO_ALREADY_IN_SPACE,
  SAMPLE_ERROR_REPO_EXISTS,
  SAMPLE_ERROR_REPO_MODE_AMBIGUOUS,
  SAMPLE_ERROR_SPACE_CREATE_REPO_ALREADY_IN_SPACE,
  SAMPLE_ERROR_SPACE_NOT_FOUND,
  SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR,
  SAMPLE_SPACE_STATUS,
} from "./testing/staveJsonSamples.ts";

// references/stave/internal/space/errcode.go
const STAVE_SPACE_CODES = [
  "dirty_worktrees",
  "dependent_spaces",
  "memory_in_use",
  "space_exists",
  "space_not_found",
  "repo_not_found",
  "repo_not_in_space",
  "repo_already_in_space",
  "repo_mode_ambiguous",
  "saga_space",
  "saga_member",
  "invalid_name",
  "branch_missing",
  "ambiguous_archive",
  "archive_not_found",
  "invalid_arguments",
  "unknown",
] as const;

// references/stave/internal/space/errcode_repos.go
const STAVE_REGISTRY_CODES = [
  "repo_exists",
  "clone_failed",
  "cache_exists",
  "config_exists",
] as const;

const LECTURN_CODES = [
  "binary_missing",
  "not_setup",
  "disabled",
  "non_json_output",
  "spawn_failed",
  "timeout",
  "nested_project",
  "archived_project",
  "incarnation_mismatch",
  "membership_unknown",
  "unreadable",
  "operation_expired",
] as const;

function expectEnvelope(stdout: string): StaveErrorEnvelope {
  const envelope = parseStaveErrorEnvelope(stdout);
  if (Option.isNone(envelope)) {
    throw new Error(`expected an error envelope in ${JSON.stringify(stdout)}`);
  }
  return envelope.value;
}

describe("STAVE_ERROR_CODES", () => {
  it("lists exactly Stave's 21 codes and Lecturn's 12, with no duplicates", () => {
    const staveCodes = [...STAVE_SPACE_CODES, ...STAVE_REGISTRY_CODES];
    expect(staveCodes).toHaveLength(21);
    expect(LECTURN_CODES).toHaveLength(12);
    expect(new Set(STAVE_CLI_ERROR_CODES)).toEqual(new Set(staveCodes));
    expect(new Set(STAVE_HOST_ERROR_CODES)).toEqual(new Set(LECTURN_CODES));
    expect(STAVE_ERROR_CODES).toHaveLength(33);
    expect(new Set(STAVE_ERROR_CODES).size).toBe(STAVE_ERROR_CODES.length);
  });

  it("normalizes: known codes pass through, anything else reads as unknown", () => {
    expect(normalizeStaveErrorCode("dirty_worktrees")).toBe("dirty_worktrees");
    expect(normalizeStaveErrorCode("config_exists")).toBe("config_exists");
    expect(normalizeStaveErrorCode("timeout")).toBe("timeout");
    expect(normalizeStaveErrorCode("brand_new")).toBe("unknown");
    expect(normalizeStaveErrorCode("")).toBe("unknown");
    expect(isStaveErrorCode("saga_member")).toBe(true);
    expect(isStaveErrorCode("Saga_Member")).toBe(false);
  });
});

describe("parseStaveErrorEnvelope", () => {
  it("reads every captured Stave failure with its code", () => {
    const cases = [
      [SAMPLE_ERROR_CONFIG_EXISTS, "config_exists"],
      [SAMPLE_ERROR_REPO_EXISTS, "repo_exists"],
      [SAMPLE_ERROR_SPACE_CREATE_REPO_ALREADY_IN_SPACE, "repo_already_in_space"],
      [SAMPLE_ERROR_REPO_ALREADY_IN_SPACE, "repo_already_in_space"],
      [SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_ADD, "invalid_arguments"],
      [SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_RETARGET, "invalid_arguments"],
      [SAMPLE_ERROR_REPO_MODE_AMBIGUOUS, "repo_mode_ambiguous"],
      [SAMPLE_ERROR_SPACE_NOT_FOUND, "space_not_found"],
      [SAMPLE_ERROR_DIRTY_WORKTREES, "dirty_worktrees"],
    ] as const;
    for (const [sample, code] of cases) {
      const envelope = expectEnvelope(sample);
      expect(envelope.code).toBe(code);
      expect(envelope.rawCode).toBe(code);
      expect(envelope.message.length).toBeGreaterThan(0);
    }
  });

  it("carries the structured details the README documents", () => {
    expect(expectEnvelope(SAMPLE_ERROR_DIRTY_WORKTREES).details).toEqual({ repos: ["api"] });
    expect(expectEnvelope(SAMPLE_ERROR_REPO_MODE_AMBIGUOUS).details).toEqual({
      repo: "web",
      modes: ["reference", "edit"],
    });
    expect(expectEnvelope(SAMPLE_ERROR_CONFIG_EXISTS).details).toEqual({
      path: "/tmp/stave-samples/config.yaml",
    });
    expect(expectEnvelope(SAMPLE_ERROR_REPO_ALREADY_IN_SPACE).details).toEqual({
      repo: "web",
      mode: "edit",
    });
    expect(expectEnvelope(SAMPLE_ERROR_REPO_EXISTS).details).toEqual({ repo: "api" });
  });

  it("keeps the message alongside the code", () => {
    expect(expectEnvelope(SAMPLE_ERROR_SPACE_NOT_FOUND).message).toBe(
      'space "nope" is not live (no .stave.yaml at /tmp/stave-samples/stave-root/agent-work/nope)',
    );
    expect(expectEnvelope(SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_ADD).message).toBe(
      "choose exactly one of --edit or --reference",
    );
  });

  it("reads details as null when Stave omitted them", () => {
    expect(expectEnvelope(SAMPLE_ERROR_SPACE_NOT_FOUND).details).toBeNull();
    expect(expectEnvelope(SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_RETARGET).details).toBeNull();
    expect(
      expectEnvelope('{"error":{"code":"unknown","message":"boom","details":null}}').details,
    ).toBeNull();
  });

  it("normalizes a code this build has not learned but keeps the raw one", () => {
    const envelope = expectEnvelope(
      '{"error":{"code":"quota_exceeded","message":"too many spaces","details":{"limit":5}}}',
    );
    expect(envelope.code).toBe("unknown");
    expect(envelope.rawCode).toBe("quota_exceeded");
    expect(envelope.message).toBe("too many spaces");
    expect(envelope.details).toEqual({ limit: 5 });
  });

  it("is none for anything that is not exactly one error envelope", () => {
    expect(Option.isNone(parseStaveErrorEnvelope(SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR))).toBe(
      true,
    );
    expect(Option.isNone(parseStaveErrorEnvelope(SAMPLE_SPACE_STATUS))).toBe(true);
    expect(Option.isNone(parseStaveErrorEnvelope(""))).toBe(true);
    expect(Option.isNone(parseStaveErrorEnvelope("   \n"))).toBe(true);
    expect(Option.isNone(parseStaveErrorEnvelope('{"error":"x"}'))).toBe(true);
    expect(Option.isNone(parseStaveErrorEnvelope('{"error":{"code":"unknown"}}'))).toBe(true);
    expect(Option.isNone(parseStaveErrorEnvelope("{not json"))).toBe(true);
    expect(Option.isNone(parseStaveErrorEnvelope("[]"))).toBe(true);
  });
});

describe("StaveError", () => {
  it("is tagged and carries the envelope plus process context", () => {
    const error = new StaveError({
      code: "dirty_worktrees",
      message: 'space "s-1" has dirty editable worktrees: api',
      details: { repos: ["api"] },
      exitCode: 1,
      stderrTail: null,
      verb: "space archive",
    });
    expect(error._tag).toBe("StaveError");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("dirty_worktrees");
    expect(error.message).toBe('space "s-1" has dirty editable worktrees: api');
    expect(error.details).toEqual({ repos: ["api"] });
    expect(error.exitCode).toBe(1);
    expect(error.stderrTail).toBeNull();
    expect(error.verb).toBe("space archive");
  });

  it("models a spawn that never produced an envelope", () => {
    const error = new StaveError({
      code: "timeout",
      message: "stave space sync timed out after 15m",
      details: null,
      exitCode: null,
      stderrTail: "fatal: unable to access remote",
      verb: "space sync",
    });
    expect(error.code).toBe("timeout");
    expect(error.details).toBeNull();
    expect(error.exitCode).toBeNull();
    expect(error.stderrTail).toBe("fatal: unable to access remote");
  });
});
