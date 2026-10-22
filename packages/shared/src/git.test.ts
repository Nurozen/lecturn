import type { VcsStatusRemoteResult, VcsStatusResult } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  applyGitStatusStreamEvent,
  formatGeneratedBranchName,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseOriginUrlFromGitConfig,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:Nurozen/Lecturn.git")).toBe(
      "github.com/nurozen/lecturn",
    );
    expect(normalizeGitRemoteUrl("https://github.com/Nurozen/Lecturn.git")).toBe(
      "github.com/nurozen/lecturn",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/Nurozen/Lecturn")).toBe(
      "github.com/nurozen/lecturn",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:Nurozen/platform/Lecturn.git")).toBe(
      "gitlab.com/nurozen/platform/lecturn",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/Nurozen/platform/Lecturn.git")).toBe(
      "gitlab.com/nurozen/platform/lecturn",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });

  it("normalizes SCP-like remotes with non-git SSH users", () => {
    expect(normalizeGitRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(
      "gitlab.example.com/group/project",
    );
    expect(normalizeGitRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(
      "bitbucket.org/workspace/repo",
    );
  });

  it("gives an Azure DevOps repository the same key over SSH as over HTTPS", () => {
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/Nurozen/Platform/Lecturn")).toBe(
      "dev.azure.com/nurozen/platform/_git/lecturn",
    );
    expect(
      normalizeGitRemoteUrl("ssh://git@ssh.dev.azure.com:22/v3/Nurozen/Platform/Lecturn"),
    ).toBe("dev.azure.com/nurozen/platform/_git/lecturn");
    expect(
      normalizeGitRemoteUrl("https://Nurozen@dev.azure.com/Nurozen/Platform/_git/Lecturn"),
    ).toBe("dev.azure.com/nurozen/platform/_git/lecturn");
  });

  it("puts the organization back in the host on the name dev.azure.com replaced", () => {
    expect(
      normalizeGitRemoteUrl("Nurozen@vs-ssh.visualstudio.com:v3/Nurozen/Platform/Lecturn"),
    ).toBe("nurozen.visualstudio.com/platform/_git/lecturn");
    expect(normalizeGitRemoteUrl("https://Nurozen.visualstudio.com/Platform/_git/Lecturn")).toBe(
      "nurozen.visualstudio.com/platform/_git/lecturn",
    );
  });

  it("leaves an Azure SSH host it cannot read as the path it was given", () => {
    // Not `v3`, and not four segments: rewriting either would invent a repository that the web
    // spelling has no name for, so the remote stands as it arrived.
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v4/Nurozen/Platform/Lecturn")).toBe(
      "ssh.dev.azure.com/v4/nurozen/platform/lecturn",
    );
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/Nurozen/Lecturn")).toBe(
      "ssh.dev.azure.com/v3/nurozen/lecturn",
    );
  });
});

describe("parseOriginUrlFromGitConfig", () => {
  it("reads the origin url and ignores other remotes", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "upstream"]',
      "\turl = https://github.com/other/repo.git",
      '[remote "origin"]',
      "\turl = git@github.com:Nurozen/lecturn.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("git@github.com:Nurozen/lecturn.git");
  });

  it("strips inline comments and quotes from the url value", () => {
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/repo.git # mirror\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"]\n\turl = "git@github.com:acme/repo.git"\n'),
    ).toBe("git@github.com:acme/repo.git");
  });

  it("accepts legacy dotted headers, header comments, and line continuations", () => {
    expect(parseOriginUrlFromGitConfig("[remote.origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    // Git folds the dotted form to lowercase but keeps quoted names as written.
    expect(parseOriginUrlFromGitConfig("[remote.Origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "Origin"]\n\turl = git@github.com:x/y.git\n[remote "origin"]\n\turl = git@github.com:a/b.git\n',
      ),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"] # primary\n\turl = git@github.com:a/b.git\n'),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/\\\n\t\trepo.git\n',
      ),
    ).toBe("https://github.com/acme/\t\trepo.git");
  });

  it.effect.each([
    {
      name: "full-line hash comment",
      config: '# comment " \\\n[remote "origin"]\nurl = https://github.com/Nurozen/lecturn.git\n',
    },
    {
      name: "full-line semicolon comment with CRLF",
      config:
        '; comment \\\r\n[remote "origin"]\r\nurl = https://github.com/Nurozen/lecturn.git\r\n',
    },
    {
      name: "inline value comment",
      config:
        '[remote "upstream"]\nurl = https://example.com/other # comment " \\\n[remote "origin"]\nurl = https://github.com/Nurozen/lecturn.git\n',
    },
    {
      name: "header comment",
      config:
        '[remote "upstream"] ; comment \\\n[remote "origin"]\nurl = https://github.com/Nurozen/lecturn.git\n',
    },
    {
      name: "quoted comment markers and continuation",
      config: '[remote "origin"]\nurl = "https://example.com/#;\\\nrepo.git"\n',
    },
    {
      name: "escaped quote before a comment",
      config:
        '[remote "upstream"]\nurl = "https://example.com/\\"repo" # comment \\\n[remote "origin"]\nurl = https://github.com/Nurozen/lecturn.git\n',
    },
    {
      name: "escaped backslash before newline",
      config:
        '[remote "upstream"]\nurl = https://example.com/\\\\\n[remote "origin"]\nurl = https://github.com/Nurozen/lecturn.git\n',
    },
    {
      name: "continuation indentation",
      config: '[remote "origin"]\nurl = https://github.com/Nurozen/\\\n\t\tlecturn.git\n',
    },
    {
      name: "quoted CRLF continuation",
      config: '[remote "origin"]\r\nurl = "https://github.com/Nurozen/\\\r\nlecturn.git"\r\n',
    },
  ])("matches Git for $name", ({ config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-git-config-" });
      const configPath = path.join(fixture, "config");
      yield* fileSystem.writeFileString(configPath, config);
      const gitUrl = yield* spawner.string(
        ChildProcess.make("git", ["config", "--file", configPath, "--get", "remote.origin.url"]),
      );
      expect(parseOriginUrlFromGitConfig(config)).toBe(gitUrl.trim());
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("falls back to the first remote when there is no origin", () => {
    const config = [
      '[remote "upstream"]',
      "\turl = https://github.com/acme/repo.git",
      '[remote "fork"]',
      "\turl = https://github.com/me/repo.git",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("https://github.com/acme/repo.git");
  });

  it("returns null when there is no remote section", () => {
    expect(parseOriginUrlFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
    expect(parseOriginUrlFromGitConfig("")).toBeNull();
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:Nurozen/Lecturn.git"),
    ).toBe("Nurozen/Lecturn");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/Nurozen/Lecturn.git"),
    ).toBe("Nurozen/Lecturn");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://github.com/Nurozen/Lecturn.git"),
    ).toBe("Nurozen/Lecturn");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("normalizes a UUID-shaped random callback to the canonical 8-hex form", () => {
    expect(buildTemporaryWorktreeBranchName(() => "f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      `${WORKTREE_BRANCH_PREFIX}/f4ae4e0e`,
    );
  });

  it("matches legacy UUID-shaped temporary worktree refs from older mobile builds", () => {
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12`),
    ).toBe(true);
  });

  it("rejects UUID-shaped refs that are not RFC 4122 v4", () => {
    // version nibble is not 4
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-1d48-b4f2-9cf0aa54ab12`),
    ).toBe(false);
    // variant nibble is not [89ab]
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-c4f2-9cf0aa54ab12`),
    ).toBe(false);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});

describe("formatGeneratedBranchName", () => {
  it.each(["lecturn", "lecturn/"])("joins static prefix %s with one slash", (prefix) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe("lecturn/add-search");
  });
  it("supports an empty prefix and preserves user prefix casing", () => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix: "", instructions: "" }),
    ).toBe("add-search");
    expect(
      formatGeneratedBranchName("Add Search", {
        mode: "static",
        prefix: "Team/Julius/",
        instructions: "",
      }),
    ).toBe("Team/Julius/add-search");
  });
  it.each([
    ["release..candidate", "release-candidate/add-search"],
    [" Team / Jules.lock/", "Team/Jules-lock/add-search"],
    ["-team//feature@{new}", "team/feature-new/add-search"],
    [" /?. / ", "add-search"],
  ])("normalizes invalid static prefix %s", (prefix, expected) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe(expected);
  });
  it("uses the model's semantic prefix without the stored static prefix", () => {
    expect(
      formatGeneratedBranchName("feat/Add Search", {
        mode: "semantic",
        prefix: "lecturn",
        instructions: "",
      }),
    ).toBe("feat/add-search");
  });
  it("preserves the full custom name, including case, dots and length", () => {
    const branch = `Julius/ABC-123/release.v2-${"x".repeat(70)}`;
    expect(
      formatGeneratedBranchName(` ${branch} `, {
        mode: "custom",
        prefix: "ignored",
        instructions: "",
      }),
    ).toBe(branch);
  });
});
