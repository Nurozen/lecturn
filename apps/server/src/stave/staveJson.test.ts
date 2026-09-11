import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  decodeStaveConfigShow,
  decodeStaveDryRunPlan,
  decodeStaveMemoryAttachResult,
  decodeStaveMemoryDetachResult,
  decodeStaveMemoryFlowResult,
  decodeStaveMemoryList,
  decodeStaveMemoryProviders,
  decodeStaveMemoryStatus,
  decodeStaveReposAddResult,
  decodeStaveReposList,
  decodeStaveSagaList,
  decodeStaveSagaMutationResult,
  decodeStaveSagaStatus,
  decodeStaveSagaSyncResult,
  decodeStaveSagaTeardownResult,
  decodeStaveSetupResult,
  decodeStaveSpaceArchiveResult,
  decodeStaveSpaceDestroyResult,
  decodeStaveSpaceList,
  decodeStaveSpaceMutationResult,
  decodeStaveSpaceStatus,
  decodeStaveSpaceSyncResult,
  decodeStaveVersion,
  isStaveDryRunPlan,
  parseStaveSagaTeardownErrorDetails,
  type StaveDecodeFailure,
  type StaveDryRunPlan,
} from "./staveJson.ts";
import {
  SAMPLE_CONFIG_SHOW,
  SAMPLE_MEMORY_ATTACH,
  SAMPLE_MEMORY_DETACH,
  SAMPLE_MEMORY_LIST,
  SAMPLE_MEMORY_LIST_SPACE,
  SAMPLE_MEMORY_PROVIDERS,
  SAMPLE_MEMORY_STATUS,
  SAMPLE_PROSE_SAGA_STATUS_NOT_FOUND_STDERR,
  SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR,
  SAMPLE_REPOS_ADD,
  SAMPLE_REPOS_ADD_DRY_RUN,
  SAMPLE_REPOS_ADD_WEB,
  SAMPLE_REPOS_LIST,
  SAMPLE_SAGA_ADD,
  SAMPLE_SAGA_ARCHIVE,
  SAMPLE_SAGA_ARCHIVE_DRY_RUN,
  SAMPLE_SAGA_CREATE,
  SAMPLE_SAGA_DESTROY,
  SAMPLE_SAGA_LIST,
  SAMPLE_SAGA_REMOVE,
  SAMPLE_SAGA_STATUS,
  SAMPLE_SAGA_SYNC,
  SAMPLE_SETUP,
  SAMPLE_SPACE_ADD,
  SAMPLE_SPACE_ARCHIVE,
  SAMPLE_SPACE_CREATE,
  SAMPLE_SPACE_CREATE_DRY_RUN,
  SAMPLE_SPACE_CREATE_IN_SAGA,
  SAMPLE_SPACE_CREATE_IN_SAGA_SECOND,
  SAMPLE_SPACE_DESTROY,
  SAMPLE_SPACE_INIT,
  SAMPLE_SPACE_LIST,
  SAMPLE_SPACE_LIST_ARCHIVED,
  SAMPLE_SPACE_REMOVE,
  SAMPLE_SPACE_RESTORE,
  SAMPLE_SPACE_RETARGET,
  SAMPLE_SPACE_STATUS,
  SAMPLE_SPACE_SYNC,
  SAMPLE_SPACE_SYNC_REFERENCES_ONLY,
  SAMPLE_VERSION_OUTPUT,
} from "./testing/staveJsonSamples.ts";

function expectSuccess<A>(result: Result.Result<A, StaveDecodeFailure>): A {
  if (!Result.isSuccess(result)) {
    throw new Error(`expected a successful decode, got ${JSON.stringify(result.failure)}`);
  }
  return result.success;
}

function expectFailure<A>(result: Result.Result<A, StaveDecodeFailure>): StaveDecodeFailure {
  if (!Result.isFailure(result)) {
    throw new Error("expected the decode to fail");
  }
  return result.failure;
}

/** The real result of a mutating verb, i.e. not its `--dry-run` plan. */
function expectPayload<A>(result: Result.Result<StaveDryRunPlan | A, StaveDecodeFailure>): A {
  const value = expectSuccess(result);
  if (isStaveDryRunPlan(value)) {
    throw new Error("expected a mutation payload, got a dry-run plan");
  }
  return value;
}

function expectDryRun<A>(
  result: Result.Result<StaveDryRunPlan | A, StaveDecodeFailure>,
): StaveDryRunPlan {
  const value = expectSuccess(result);
  if (!isStaveDryRunPlan(value)) {
    throw new Error("expected a dry-run plan");
  }
  return value;
}

const ARCHIVE_DIR = "/tmp/stave-samples/stave-root/agent-work/.archive";

describe("stave --json reads", () => {
  it("config show: resolved paths, repo registry, memory and summon tables", () => {
    const config = expectSuccess(decodeStaveConfigShow(SAMPLE_CONFIG_SHOW));
    expect(config.agentWorkDir).toBe("/tmp/stave-samples/stave-root/agent-work");
    expect(config.exists).toBe(true);
    expect(Object.keys(config.repos)).toEqual([]);
    expect(config.memory.default).toBe(false);
    expect(config.memory.provider).toBe("marmot");
    expect(config.summon.default).toBe("codex");
    expect(config.summon.commands).toEqual({
      claude: "claude",
      codex: "codex",
      cursor: "cursor-agent",
    });
    expect(config.tethers.strongThreshold).toBe(3);
  });

  it("repos list: one row per registered bare repo", () => {
    const rows = expectSuccess(decodeStaveReposList(SAMPLE_REPOS_LIST));
    expect(rows.map((row) => row.name)).toEqual(["api", "web"]);
    const [api] = rows;
    expect(api?.url).toBe("file:///tmp/stave-samples/src/api.git");
    expect(api?.bareRepoPath).toBe("/tmp/stave-samples/stave-root/bare-repos/api.git");
    expect(api?.defaultBranch).toBe("main");
    expect(api?.tetherCount).toBe(0);
  });

  it("repos list: defaultBranch is optional", () => {
    const rows = expectSuccess(
      decodeStaveReposList(
        JSON.stringify([{ name: "x", url: "u", bareRepoPath: "/b/x.git", tetherCount: 2 }]),
      ),
    );
    expect(rows[0]?.defaultBranch).toBeUndefined();
    expect(rows[0]?.tetherCount).toBe(2);
  });

  it("space list: live rows carry the reconciliation identity and default archived to false", () => {
    const rows = expectSuccess(decodeStaveSpaceList(SAMPLE_SPACE_LIST));
    expect(rows.map((row) => row.id)).toEqual(["s-1", "s-init"]);
    const [s1, sInit] = rows;
    expect(s1?.logicalId).toBe("s-1");
    expect(s1?.manifestCreatedAt).toBe("2026-09-07T04:49:29.505337Z");
    expect(s1?.manifestVersion).toBe(1);
    expect(s1?.archived).toBe(false);
    expect(s1?.archiveBasename).toBeUndefined();
    expect(s1?.memberOf).toBeUndefined();
    expect(s1?.memories).toEqual([]);
    expect(s1?.repos.map((repo) => repo.mode)).toEqual(["edit", "reference"]);
    expect(s1?.kind).toBeUndefined();
    expect(sInit?.kind).toBe("spike");
    expect(sInit?.repos).toEqual([]);
    expect(sInit?.isSaga).toBe(false);
  });

  it("space list --archived: rows are flagged and name their .archive/ entry", () => {
    const [row] = expectSuccess(decodeStaveSpaceList(SAMPLE_SPACE_LIST_ARCHIVED));
    expect(row?.archived).toBe(true);
    expect(row?.archiveBasename).toBe("s-1");
    expect(row?.path).toBe(`${ARCHIVE_DIR}/s-1`);
    expect(row?.logicalId).toBe("s-1");
    expect(row?.manifestCreatedAt).toBe("2026-09-07T04:49:29.505337Z");
    expect(row?.repos).toEqual([
      { name: "api", mode: "edit" },
      { name: "web", mode: "reference" },
    ]);
  });

  it("space list: a saga member row names its saga", () => {
    const [row] = expectSuccess(
      decodeStaveSpaceList(
        JSON.stringify([
          {
            id: "m-1",
            path: "/w/m-1",
            isSaga: false,
            memberOf: "saga-1",
            repos: [{ name: "api", mode: "edit" }],
            logicalId: "m-1",
            manifestCreatedAt: "2026-09-07T04:49:30.241723Z",
            manifestVersion: 1,
            memories: [{ name: "default", provider: "marmot", id: "m-1", owned: true }],
          },
        ]),
      ),
    );
    expect(row?.memberOf).toBe("saga-1");
    expect(row?.memories[0]?.owned).toBe(true);
  });

  it("space status: manifest repos and live worktree rows", () => {
    const status = expectSuccess(decodeStaveSpaceStatus(SAMPLE_SPACE_STATUS));
    expect(status.spaceId).toBe("s-1");
    expect(status.spacePath).toBe("/tmp/stave-samples/stave-root/agent-work/s-1");
    expect(status.manifest.id).toBe("s-1");
    expect(status.manifest.version).toBe(1);
    expect(status.manifest.repos.map((repo) => repo.bareRepoPath)).toEqual([
      "/tmp/stave-samples/stave-root/bare-repos/api.git",
      "/tmp/stave-samples/stave-root/bare-repos/web.git",
    ]);
    expect(status.manifest.repos[0]?.branch).toBe("stave/s-1/api");
    expect(status.manifest.repos[1]?.ref).toBe("origin/main");
    expect(status.manifest.memories).toEqual([]);
    expect(status.manifest.saga).toBeUndefined();

    const [api, web] = status.repos;
    expect(api).toMatchObject({
      name: "api",
      mode: "edit",
      exists: true,
      dirty: false,
      ahead: 0,
      behind: 0,
      path: "/tmp/stave-samples/stave-root/agent-work/s-1/api",
      branch: "stave/s-1/api",
    });
    expect(web?.path).toBe("/tmp/stave-samples/stave-root/agent-work/s-1/references/web");
    expect(web?.branch).toBeUndefined();
    expect(status.memories).toEqual([]);
  });

  it("space status: memory rows carry the freshness probe", () => {
    const status = expectSuccess(
      decodeStaveSpaceStatus(
        JSON.stringify({
          spaceId: "s",
          spacePath: "/w/s",
          manifest: { id: "s", createdAt: "2026-01-01T00:00:00Z" },
          repos: [],
          memories: [
            { name: "default", provider: "marmot", id: "s", owned: true, state: "2 unpushed" },
            { name: "wiki", provider: "marmot", id: "wiki", owned: false },
          ],
        }),
      ),
    );
    expect(status.memories[0]?.state).toBe("2 unpushed");
    expect(status.memories[1]?.state).toBeUndefined();
    expect(status.manifest.repos).toEqual([]);
  });

  it("saga list: saga rows list members, member rows name their saga", () => {
    const rows = expectSuccess(decodeStaveSagaList(SAMPLE_SAGA_LIST));
    expect(rows.map((row) => row.id)).toEqual(["m-1", "m-2", "s-init", "saga-1"]);
    const saga = rows.find((row) => row.isSaga);
    expect(saga?.members).toEqual(["m-1", "m-2"]);
    expect(saga?.kind).toBe("saga");
    expect(saga?.logicalId).toBe("saga-1");
    expect(saga?.path).toBe("/tmp/stave-samples/stave-root/agent-work/saga-1");
    const [m1] = rows;
    expect(m1?.memberOf).toBe("saga-1");
    expect(m1?.members).toEqual([]);
    expect(m1?.logicalId).toBe("m-1");
  });

  it("saga status: snake_case keys read as camelCase", () => {
    const status = expectSuccess(decodeStaveSagaStatus(SAMPLE_SAGA_STATUS));
    expect(status.sagaId).toBe("saga-1");
    expect(status.notes).toEqual([]);
    expect(status.members.map((member) => member.id)).toEqual(["m-1", "m-2"]);
    const [m1] = status.members;
    expect(m1?.state).toBe("live");
    expect(m1?.dirty).toBe(false);
    expect(m1?.after).toEqual([]);
    expect(m1?.prs).toEqual([]);
    expect(m1?.repos[0]).toMatchObject({
      name: "api",
      branch: "stave/m-1/api",
      base: "origin/main",
      baseHealth: "ok",
      ahead: 0,
      behind: 0,
    });
    expect(m1?.repos[0]?.mergedVia).toBeUndefined();
    expect(m1?.repos[0]).not.toHaveProperty("base_health");
  });

  it("saga status: merged bases, PR stamps and notes", () => {
    const status = expectSuccess(
      decodeStaveSagaStatus(
        JSON.stringify({
          saga_id: "saga-1",
          members: [
            {
              id: "m-1",
              after: [],
              state: "live",
              dirty: true,
              repos: [
                {
                  name: "api",
                  branch: "stave/m-1/api",
                  base: "origin/main",
                  ahead: 2,
                  behind: 0,
                  base_health: "merged",
                  merged_via: "pr",
                },
              ],
              prs: [
                {
                  repo: "api",
                  number: 12,
                  state: "MERGED",
                  merged_at: "2026-09-05T10:00:00Z",
                  base_ref_name: "main",
                },
              ],
            },
            {
              id: "m-2",
              after: ["m-1"],
              state: "archived",
              error: "/w/.archive/m-2",
              dirty: false,
            },
          ],
          notes: [{ kind: "degraded", member: "m-2", text: "member m-2 is archived" }],
        }),
      ),
    );
    const [m1, m2] = status.members;
    expect(m1?.dirty).toBe(true);
    expect(m1?.repos[0]?.baseHealth).toBe("merged");
    expect(m1?.repos[0]?.mergedVia).toBe("pr");
    expect(m1?.prs[0]).toEqual({
      repo: "api",
      number: 12,
      state: "MERGED",
      mergedAt: "2026-09-05T10:00:00Z",
      baseRefName: "main",
    });
    expect(m2?.after).toEqual(["m-1"]);
    expect(m2?.state).toBe("archived");
    expect(m2?.error).toBe("/w/.archive/m-2");
    expect(m2?.repos).toEqual([]);
    expect(status.notes).toEqual([
      { kind: "degraded", member: "m-2", text: "member m-2 is archived" },
    ]);
  });

  it("memory providers: availability and capabilities", () => {
    const [marmot] = expectSuccess(decodeStaveMemoryProviders(SAMPLE_MEMORY_PROVIDERS));
    expect(marmot?.name).toBe("marmot");
    expect(marmot?.binary).toBe("marmot");
    expect(marmot?.available).toBe(true);
    expect(marmot?.default).toBe(true);
    expect(marmot?.capabilities).toEqual(["dens", "refs", "links", "warrens"]);
    expect(marmot?.error).toBeUndefined();
  });

  it("memory list: empty across the root, one row per space when scoped", () => {
    expect(expectSuccess(decodeStaveMemoryList(SAMPLE_MEMORY_LIST))).toEqual([]);
    const [row] = expectSuccess(decodeStaveMemoryList(SAMPLE_MEMORY_LIST_SPACE));
    expect(row?.spaceId).toBe("s-init");
    expect(row?.spacePath).toBe("/tmp/stave-samples/stave-root/agent-work/s-init");
    expect(row?.attachments).toEqual([]);
  });

  it("memory status: attachment lifetime and links", () => {
    const status = expectSuccess(decodeStaveMemoryStatus(SAMPLE_MEMORY_STATUS));
    expect(status.spaceId).toBe("s-init");
    const [attachment] = status.attachments;
    expect(attachment).toMatchObject({
      name: "default",
      provider: "marmot",
      id: "s-init",
      owned: true,
      lifetime: "task",
    });
    expect(attachment?.links).toEqual([]);
    expect(attachment?.state).toBeUndefined();
  });

  it("version: prose header yields the bare version", () => {
    expect(expectSuccess(decodeStaveVersion(SAMPLE_VERSION_OUTPUT))).toEqual({ version: "0.4.0" });
    expect(expectFailure(decodeStaveVersion("stave: command not found")).reason).toBe("not_json");
  });
});

describe("stave --json mutation results", () => {
  it("space init|create|add|remove|restore|retarget share the manifest result", () => {
    const cases = [
      ["s-init", SAMPLE_SPACE_INIT, 0],
      ["s-1", SAMPLE_SPACE_CREATE, 2],
      ["s-1", SAMPLE_SPACE_ADD, 3],
      ["s-1", SAMPLE_SPACE_REMOVE, 2],
      ["s-1", SAMPLE_SPACE_RESTORE, 2],
      ["s-1", SAMPLE_SPACE_RETARGET, 2],
    ] as const;
    for (const [spaceId, sample, repoCount] of cases) {
      const result = expectPayload(decodeStaveSpaceMutationResult(sample));
      expect(result.spaceId).toBe(spaceId);
      expect(result.spacePath).toBe(`/tmp/stave-samples/stave-root/agent-work/${spaceId}`);
      expect(result.manifest.id).toBe(spaceId);
      expect(result.manifest.repos).toHaveLength(repoCount);
      expect(result.notes).toEqual([]);
    }
    const init = expectPayload(decodeStaveSpaceMutationResult(SAMPLE_SPACE_INIT));
    expect(init.manifest.kind).toBe("spike");
    const added = expectPayload(decodeStaveSpaceMutationResult(SAMPLE_SPACE_ADD));
    expect(added.manifest.repos.map((repo) => `${repo.name}:${repo.mode}`)).toEqual([
      "api:edit",
      "web:reference",
      "web:edit",
    ]);
  });

  it("space create --saga: the enrolment note survives", () => {
    const first = expectPayload(decodeStaveSpaceMutationResult(SAMPLE_SPACE_CREATE_IN_SAGA));
    expect(first.spaceId).toBe("m-1");
    expect(first.notes).toEqual(["added m-1 to saga saga-1"]);
    const second = expectPayload(
      decodeStaveSpaceMutationResult(SAMPLE_SPACE_CREATE_IN_SAGA_SECOND),
    );
    expect(second.manifest.repos[0]?.branch).toBe("stave/m-2/api");
  });

  it("space archive: destination and memory fate", () => {
    const archived = expectPayload(decodeStaveSpaceArchiveResult(SAMPLE_SPACE_ARCHIVE));
    expect(archived.spaceId).toBe("s-1");
    expect(archived.archivedPath).toBe(`${ARCHIVE_DIR}/s-1`);
    expect(archived.memory).toBe("keep");
    expect(archived.notes).toEqual([]);
  });

  it("space destroy: destroyed flag", () => {
    const destroyed = expectPayload(decodeStaveSpaceDestroyResult(SAMPLE_SPACE_DESTROY));
    expect(destroyed.spaceId).toBe("s-1");
    expect(destroyed.destroyed).toBe(true);
    expect(destroyed.memory).toBe("keep");
    expect(destroyed.spacePath).toBe("/tmp/stave-samples/stave-root/agent-work/s-1");
  });

  it("space sync: per-repo actions with drift counts", () => {
    const synced = expectSuccess(decodeStaveSpaceSyncResult(SAMPLE_SPACE_SYNC));
    expect(synced.spaceId).toBe("s-1");
    expect(synced.manifest.repos).toHaveLength(2);
    expect(synced.repos).toEqual([
      { name: "api", mode: "edit", action: "drift-reported", ahead: 0, behind: 0 },
      { name: "web", mode: "reference", action: "updated", ahead: 0, behind: 0 },
    ]);
    expect(synced.notes).toEqual([]);

    const referencesOnly = expectSuccess(
      decodeStaveSpaceSyncResult(SAMPLE_SPACE_SYNC_REFERENCES_ONLY),
    );
    expect(referencesOnly.repos.map((repo) => `${repo.name}:${repo.action}`)).toEqual([
      "web:updated",
    ]);
  });

  it("repos add: registration outcome", () => {
    const api = expectPayload(decodeStaveReposAddResult(SAMPLE_REPOS_ADD));
    expect(api.name).toBe("api");
    expect(api.adopted).toBe(false);
    expect(api.bareRepoPath).toBe("/tmp/stave-samples/stave-root/bare-repos/api.git");
    expect(api.defaultBranch).toBe("main");
    expect(api.url).toBe("file:///tmp/stave-samples/src/api.git");
    expect(api.notes).toEqual([]);
    const web = expectPayload(decodeStaveReposAddResult(SAMPLE_REPOS_ADD_WEB));
    expect(web.bareRepoPath).toBe("/tmp/stave-samples/stave-root/bare-repos/web.git");
  });

  it("setup: which paths were created and which already existed", () => {
    const setup = expectSuccess(decodeStaveSetupResult(SAMPLE_SETUP));
    expect(setup.configPath).toBe("/tmp/stave-samples/config.yaml");
    expect(setup.root).toBe("/tmp/stave-samples/stave-root");
    expect(setup.bareReposDir).toBe("/tmp/stave-samples/stave-root/bare-repos");
    expect(setup.agentWorkDir).toBe("/tmp/stave-samples/stave-root/agent-work");
    expect(setup.created).toEqual([
      "/tmp/stave-samples/stave-root",
      "/tmp/stave-samples/stave-root/bare-repos",
      "/tmp/stave-samples/stave-root/agent-work",
    ]);
    expect(setup.existed).toEqual(["/tmp/stave-samples/config.yaml"]);
  });

  it("saga create|add|remove: roster inside the saga manifest", () => {
    const created = expectPayload(decodeStaveSagaMutationResult(SAMPLE_SAGA_CREATE));
    expect(created.sagaId).toBe("saga-1");
    expect(created.spacePath).toBe("/tmp/stave-samples/stave-root/agent-work/saga-1");
    expect(created.manifest.kind).toBe("saga");
    expect(created.manifest.version).toBe(2);
    expect(created.manifest.saga?.members).toEqual([]);
    expect(created.notes).toEqual(["added reference repo web to saga-1"]);

    const added = expectPayload(decodeStaveSagaMutationResult(SAMPLE_SAGA_ADD));
    expect(added.manifest.saga?.members.map((member) => member.id)).toEqual([
      "m-1",
      "m-2",
      "s-init",
    ]);
    expect(added.manifest.saga?.members[0]?.createdAt).toBe("2026-09-07T04:49:30.241723Z");
    expect(added.manifest.saga?.members[0]?.after).toEqual([]);
    expect(added.manifest.saga?.members[0]?.prs).toEqual([]);
    expect(added.notes).toEqual([]);

    const removed = expectPayload(decodeStaveSagaMutationResult(SAMPLE_SAGA_REMOVE));
    expect(removed.manifest.saga?.members.map((member) => member.id)).toEqual(["m-1", "m-2"]);
  });

  it("saga sync: member states with their repo rows, plus the saga's own references", () => {
    const synced = expectPayload(decodeStaveSagaSyncResult(SAMPLE_SAGA_SYNC));
    expect(synced.sagaId).toBe("saga-1");
    expect(synced.spacePath).toBe("/tmp/stave-samples/stave-root/agent-work/saga-1");
    expect(synced.members.map((member) => [member.id, member.state])).toEqual([
      ["m-1", "live"],
      ["m-2", "live"],
    ]);
    expect(synced.members[0]?.repos[0]).toEqual({
      name: "api",
      mode: "edit",
      action: "drift-reported",
      ahead: 0,
      behind: 0,
    });
    expect(synced.members[0]?.note).toBeUndefined();
    expect(synced.repos).toEqual([
      { name: "web", mode: "reference", action: "updated", ahead: 0, behind: 0 },
    ]);
    expect(synced.notes).toEqual([]);
  });

  it("saga archive: members in teardown order, then the saga space", () => {
    const archived = expectPayload(decodeStaveSagaTeardownResult(SAMPLE_SAGA_ARCHIVE));
    expect(archived.sagaId).toBe("saga-1");
    expect(archived.action).toBe("archived");
    expect(archived.memory).toBe("keep");
    expect(archived.sagaPath).toBe("/tmp/stave-samples/stave-root/agent-work/saga-1");
    expect(archived.sagaArchivedPath).toBe(`${ARCHIVE_DIR}/saga-1`);
    expect(archived.members).toEqual([
      {
        id: "m-2",
        action: "archived",
        path: "/tmp/stave-samples/stave-root/agent-work/m-2",
        archivedPath: `${ARCHIVE_DIR}/m-2`,
      },
      {
        id: "m-1",
        action: "archived",
        path: "/tmp/stave-samples/stave-root/agent-work/m-1",
        archivedPath: `${ARCHIVE_DIR}/m-1`,
      },
    ]);
    expect(archived.notes).toHaveLength(3);
  });

  it("saga destroy: no archive destinations", () => {
    const destroyed = expectPayload(decodeStaveSagaTeardownResult(SAMPLE_SAGA_DESTROY));
    expect(destroyed.sagaId).toBe("saga-2");
    expect(destroyed.action).toBe("destroyed");
    expect(destroyed.sagaPath).toBe("/tmp/stave-samples/stave-root/agent-work/saga-2");
    expect(destroyed.sagaArchivedPath).toBeUndefined();
    expect(destroyed.members).toEqual([
      { id: "m-3", action: "destroyed", path: "/tmp/stave-samples/stave-root/agent-work/m-3" },
    ]);
    expect(destroyed.notes).toEqual(["destroyed m-3", "destroyed saga-2"]);
  });

  it("saga archive: a member already archived is reported as skipped", () => {
    const result = expectPayload(
      decodeStaveSagaTeardownResult(
        JSON.stringify({
          sagaId: "saga-3",
          action: "archived",
          memory: "keep",
          sagaPath: "/w/saga-3",
          sagaArchivedPath: "/w/.archive/saga-3",
          members: [
            {
              id: "m-9",
              action: "skipped",
              note: "already archived",
              path: "/w/m-9",
              archivedPath: "/w/.archive/m-9",
            },
          ],
        }),
      ),
    );
    expect(result.members[0]?.action).toBe("skipped");
    expect(result.members[0]?.note).toBe("already archived");
    expect(result.members[0]?.archivedPath).toBe("/w/.archive/m-9");
    expect(result.notes).toEqual([]);
  });

  it("memory attach: the attachment and the manifest it was written to", () => {
    const attached = expectPayload(decodeStaveMemoryAttachResult(SAMPLE_MEMORY_ATTACH));
    expect(attached.spaceId).toBe("s-init");
    expect(attached.spacePath).toBe("/tmp/stave-samples/stave-root/agent-work/s-init");
    expect(attached.attachments).toEqual([
      { name: "default", provider: "marmot", id: "s-init", owned: true, linked: [] },
    ]);
    expect(attached.manifest.memories).toEqual([
      { name: "default", provider: "marmot", id: "s-init", owned: true },
    ]);
    expect(attached.notes).toEqual([]);
  });

  it("memory detach: the fate that applied and the handoff note", () => {
    const detached = expectPayload(decodeStaveMemoryDetachResult(SAMPLE_MEMORY_DETACH));
    expect(detached.spaceId).toBe("s-init");
    expect(detached.detached).toEqual([
      { name: "default", provider: "marmot", id: "s-init", owned: true, fate: "keep" },
    ]);
    expect(detached.manifest.memories).toEqual([]);
    expect(detached.notes).toHaveLength(1);
    expect(detached.notes[0]).toContain("den s-init kept");
  });

  it("memory sync|propose: per-alias outcomes with the push handoff", () => {
    const flow = expectPayload(
      decodeStaveMemoryFlowResult(
        JSON.stringify({
          spaceId: "s-init",
          results: [
            {
              alias: "default",
              warren: "team",
              outcome: "proposed",
              branch: "stave/s-init",
              commit: "abc123",
              pushCommand: "git -C /w/warren push origin stave/s-init",
              contributed: { notes: 3 },
            },
            { alias: "wiki", outcome: "failed", detail: "unreachable" },
          ],
        }),
      ),
    );
    expect(flow.spaceId).toBe("s-init");
    expect(flow.results.map((row) => row.outcome)).toEqual(["proposed", "failed"]);
    expect(flow.results[0]?.pushCommand).toBe("git -C /w/warren push origin stave/s-init");
    expect(flow.results[0]?.contributed).toEqual({ notes: 3 });
    expect(flow.results[1]?.detail).toBe("unreachable");
    expect(flow.results[1]?.contributed).toBeUndefined();
    expect(flow.notes).toEqual([]);
  });

  it("--dry-run answers decode through the mutation decoders as plans", () => {
    const reposAdd = expectDryRun(decodeStaveReposAddResult(SAMPLE_REPOS_ADD_DRY_RUN));
    expect(reposAdd.plan).toHaveLength(9);
    expect(reposAdd.plan[3]).toContain("git clone --bare");

    const spaceCreate = expectDryRun(decodeStaveSpaceMutationResult(SAMPLE_SPACE_CREATE_DRY_RUN));
    expect(spaceCreate.plan).toHaveLength(6);
    expect(spaceCreate.plan[0]).toBe(
      "dry-run: create space directory /tmp/stave-samples/stave-root/agent-work/s-dry",
    );

    const sagaArchive = expectDryRun(decodeStaveSagaTeardownResult(SAMPLE_SAGA_ARCHIVE_DRY_RUN));
    expect(sagaArchive.plan).toHaveLength(10);
    expect(sagaArchive.plan[1]).toBe("dry-run: 1. archive member m-2");

    const plain = expectSuccess(decodeStaveDryRunPlan(SAMPLE_SAGA_ARCHIVE_DRY_RUN));
    expect(plain.dryRun).toBe(true);
    expect(plain.plan).toEqual(sagaArchive.plan);
    expect(expectFailure(decodeStaveDryRunPlan(SAMPLE_SAGA_ARCHIVE)).reason).toBe("schema");
  });

  it("isStaveDryRunPlan only accepts dryRun:true", () => {
    expect(isStaveDryRunPlan({ dryRun: true, plan: [] })).toBe(true);
    expect(isStaveDryRunPlan({ dryRun: false, plan: [] })).toBe(false);
    expect(isStaveDryRunPlan({ spaceId: "s" })).toBe(false);
    expect(isStaveDryRunPlan(null)).toBe(false);
  });
});

describe("stave --json forward compatibility", () => {
  it("ignores keys this build has not learned, top-level and nested", () => {
    const status = expectSuccess(
      decodeStaveSpaceStatus(
        JSON.stringify({
          spaceId: "s",
          spacePath: "/w/s",
          futureTopLevel: { anything: true },
          manifest: {
            id: "s",
            createdAt: "2026-01-01T00:00:00Z",
            futureManifestKey: 1,
            repos: [
              {
                name: "api",
                mode: "edit",
                path: "api",
                bareRepoPath: "/b/api.git",
                futureRepoKey: [],
              },
            ],
          },
          repos: [
            {
              name: "api",
              mode: "edit",
              path: "/w/s/api",
              exists: true,
              dirty: false,
              ahead: 0,
              behind: 0,
              futureRowKey: "x",
            },
          ],
        }),
      ),
    );
    expect(status).not.toHaveProperty("futureTopLevel");
    expect(status.manifest).not.toHaveProperty("futureManifestKey");
    expect(status.manifest.repos[0]).not.toHaveProperty("futureRepoKey");
    expect(status.repos[0]).not.toHaveProperty("futureRowKey");
    expect(status.repos[0]?.name).toBe("api");
  });

  it("reads nil slices and omitted notes as empty arrays", () => {
    const result = expectPayload(
      decodeStaveSpaceMutationResult(
        JSON.stringify({
          spaceId: "s",
          spacePath: "/w/s",
          manifest: { id: "s", createdAt: "2026-01-01T00:00:00Z", repos: null, memories: null },
        }),
      ),
    );
    expect(result.manifest.repos).toEqual([]);
    expect(result.manifest.memories).toEqual([]);
    expect(result.notes).toEqual([]);

    const [row] = expectSuccess(
      decodeStaveSpaceList(
        JSON.stringify([{ id: "s", path: "/w/s", isSaga: false, repos: null, logicalId: "s" }]),
      ),
    );
    expect(row?.repos).toEqual([]);
    expect(row?.memories).toEqual([]);
    expect(expectSuccess(decodeStaveReposList("null"))).toEqual([]);
  });

  it("reads closed string sets it does not know as unknown", () => {
    const synced = expectSuccess(
      decodeStaveSpaceSyncResult(
        JSON.stringify({
          spaceId: "s",
          spacePath: "/w/s",
          manifest: {
            id: "s",
            createdAt: "2026-01-01T00:00:00Z",
            repos: [{ name: "m", mode: "mirror", path: "m", bareRepoPath: "/b/m.git" }],
          },
          repos: [{ name: "m", mode: "mirror", action: "future", ahead: 0, behind: 0 }],
        }),
      ),
    );
    expect(synced.manifest.repos[0]?.mode).toBe("unknown");
    expect(synced.repos[0]?.mode).toBe("unknown");
    expect(synced.repos[0]?.action).toBe("unknown");

    const sagaStatus = expectSuccess(
      decodeStaveSagaStatus(
        JSON.stringify({
          saga_id: "saga",
          members: [{ id: "m", state: "weird", dirty: false }],
        }),
      ),
    );
    expect(sagaStatus.members[0]?.state).toBe("unknown");

    const archived = expectPayload(
      decodeStaveSpaceArchiveResult(
        JSON.stringify({ spaceId: "s", archivedPath: "/w/.archive/s", memory: "later" }),
      ),
    );
    expect(archived.memory).toBe("unknown");
  });

  it("space list error rows carry a null logicalId and default the manifest fields", () => {
    const [row] = expectSuccess(
      decodeStaveSpaceList(
        JSON.stringify([
          {
            id: "broken",
            path: "/w/broken",
            isSaga: false,
            error: "yaml: line 3: mapping values are not allowed",
            logicalId: null,
          },
        ]),
      ),
    );
    expect(row?.error).toContain("yaml: line 3");
    expect(row?.logicalId).toBeNull();
    expect(row?.manifestVersion).toBe(0);
    expect(row?.archived).toBe(false);
    expect(row?.manifestCreatedAt).toBeUndefined();
    expect(row?.repos).toEqual([]);
  });
});

describe("stave --json decode failures", () => {
  it("prose stdout is not_json", () => {
    const failure = expectFailure(
      decodeStaveSpaceStatus(SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR),
    );
    expect(failure.reason).toBe("not_json");
    expect(failure.detail.length).toBeGreaterThan(0);
    expect(
      expectFailure(decodeStaveSagaStatus(SAMPLE_PROSE_SAGA_STATUS_NOT_FOUND_STDERR)).reason,
    ).toBe("not_json");
  });

  it("empty stdout is not_json", () => {
    expect(expectFailure(decodeStaveSpaceList("")).reason).toBe("not_json");
    expect(expectFailure(decodeStaveConfigShow("   \n")).reason).toBe("not_json");
  });

  it("JSON of the wrong shape is a schema failure with a detail", () => {
    const empty = expectFailure(decodeStaveSpaceStatus("{}"));
    expect(empty.reason).toBe("schema");
    expect(empty.detail.length).toBeGreaterThan(0);

    const wrongShape = expectFailure(decodeStaveSpaceList(SAMPLE_SPACE_STATUS));
    expect(wrongShape.reason).toBe("schema");
    expect(wrongShape.detail.length).toBeGreaterThan(0);

    expect(expectFailure(decodeStaveSagaTeardownResult(SAMPLE_SPACE_ARCHIVE)).reason).toBe(
      "schema",
    );
    expect(expectFailure(decodeStaveConfigShow('{"configPath":1}')).reason).toBe("schema");
  });
});

describe("parseStaveSagaTeardownErrorDetails", () => {
  it("reads the mid-walk progress the README documents", () => {
    const details = parseStaveSagaTeardownErrorDetails({
      completed: [
        {
          id: "jf-2",
          action: "archived",
          path: "/w/agent-work/jf-2",
          archivedPath: "/w/agent-work/.archive/jf-2",
        },
      ],
      failedAt: "member",
      failedMember: "jf-1",
    });
    expect(Option.isSome(details)).toBe(true);
    const progress = Option.getOrThrow(details);
    expect(progress.failedAt).toBe("member");
    expect(progress.failedMember).toBe("jf-1");
    expect(progress.completed).toEqual([
      {
        id: "jf-2",
        action: "archived",
        path: "/w/agent-work/jf-2",
        archivedPath: "/w/agent-work/.archive/jf-2",
      },
    ]);
  });

  it("is none when the failure was not mid-walk", () => {
    expect(Option.isNone(parseStaveSagaTeardownErrorDetails({ repos: ["api"] }))).toBe(true);
    expect(Option.isNone(parseStaveSagaTeardownErrorDetails(null))).toBe(true);
  });

  it("reads an unfamiliar failure stage as unknown", () => {
    const details = Option.getOrThrow(
      parseStaveSagaTeardownErrorDetails({ completed: [], failedAt: "later" }),
    );
    expect(details.failedAt).toBe("unknown");
    expect(details.completed).toEqual([]);
    expect(details.failedMember).toBeUndefined();
  });
});
