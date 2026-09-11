// Captured from stave v0.4.0 on 2026-09-06 in a throwaway root; paths are the temp root's
// (the random mktemp suffix was replaced with the literal `/tmp/stave-samples` so this file is deterministic).
// Every constant holds the exact stdout (or, for SAMPLE_PROSE_*_STDERR, the exact stderr) the binary emitted.
// Source repos: file:///tmp/stave-samples/src/{api,web}.git (bare clones, two commits on main).

/** `setup --json` when config.yaml already exists (exit 1). Captured first because the throwaway root needed a pre-written config.yaml to keep `root` off ~/stave. Exit code: 1. */
export const SAMPLE_ERROR_CONFIG_EXISTS = String.raw`{
  "error": {
    "code": "config_exists",
    "details": {
      "path": "/tmp/stave-samples/config.yaml"
    },
    "message": "config already exists at /tmp/stave-samples/config.yaml; re-run with --force to rewrite it"
  }
}
`;

/** `setup --force --json` (exit 0). Success shape; `--force` was required because config.yaml pre-existed (see above). Directories were created fresh. Exit code: 0. */
export const SAMPLE_SETUP = String.raw`{
  "agentWorkDir": "/tmp/stave-samples/stave-root/agent-work",
  "bareReposDir": "/tmp/stave-samples/stave-root/bare-repos",
  "configPath": "/tmp/stave-samples/config.yaml",
  "created": [
    "/tmp/stave-samples/stave-root",
    "/tmp/stave-samples/stave-root/bare-repos",
    "/tmp/stave-samples/stave-root/agent-work"
  ],
  "existed": [
    "/tmp/stave-samples/config.yaml"
  ],
  "root": "/tmp/stave-samples/stave-root"
}
`;

/** `config show --json` after setup, before any repos were registered (repos: {}). Exit code: 0. */
export const SAMPLE_CONFIG_SHOW = String.raw`{
  "agentWorkDir": "/tmp/stave-samples/stave-root/agent-work",
  "bareReposDir": "/tmp/stave-samples/stave-root/bare-repos",
  "configPath": "/tmp/stave-samples/config.yaml",
  "defaultBase": "main",
  "exists": true,
  "memory": {
    "binary": "marmot",
    "default": false,
    "provider": "marmot"
  },
  "repos": {},
  "root": "/tmp/stave-samples/stave-root",
  "summon": {
    "commands": {
      "claude": "claude",
      "codex": "codex",
      "cursor": "cursor-agent"
    },
    "default": "codex"
  },
  "tethers": {
    "enabled": true,
    "strongThreshold": 3
  }
}
`;

/** `repos add api file:///tmp/stave-samples/src/api.git --json` (exit 0). Exit code: 0. */
export const SAMPLE_REPOS_ADD = String.raw`{
  "adopted": false,
  "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
  "defaultBranch": "main",
  "name": "api",
  "url": "file:///tmp/stave-samples/src/api.git"
}
`;

/** `repos add api <url> --json` again (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_REPO_EXISTS = String.raw`{
  "error": {
    "code": "repo_exists",
    "details": {
      "repo": "api"
    },
    "message": "repo \"api\" is already registered"
  }
}
`;

/** `repos add api-dup <url> --dry-run --json` (exit 0). Exit code: 0. */
export const SAMPLE_REPOS_ADD_DRY_RUN = String.raw`{
  "dryRun": true,
  "plan": [
    "dry-run: create /tmp/stave-samples/stave-root",
    "dry-run: create /tmp/stave-samples/stave-root/bare-repos",
    "dry-run: create /tmp/stave-samples/stave-root/agent-work",
    "dry-run: git clone --bare file:///tmp/stave-samples/src/api.git /tmp/stave-samples/stave-root/bare-repos/api-dup.git",
    "dry-run: git --git-dir /tmp/stave-samples/stave-root/bare-repos/api-dup.git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*",
    "dry-run: git --git-dir /tmp/stave-samples/stave-root/bare-repos/api-dup.git fetch --all --prune",
    "dry-run: git --git-dir /tmp/stave-samples/stave-root/bare-repos/api-dup.git remote set-head origin --auto",
    "note: would discover default branch for \"api-dup\"",
    "registered api-dup at /tmp/stave-samples/stave-root/bare-repos/api-dup.git"
  ]
}
`;

/** `repos add web file:///tmp/stave-samples/src/web.git --json` (exit 0). Exit code: 0. */
export const SAMPLE_REPOS_ADD_WEB = String.raw`{
  "adopted": false,
  "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
  "defaultBranch": "main",
  "name": "web",
  "url": "file:///tmp/stave-samples/src/web.git"
}
`;

/** `repos list --json` with api and web registered (exit 0). Exit code: 0. */
export const SAMPLE_REPOS_LIST = String.raw`[
  {
    "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
    "defaultBranch": "main",
    "name": "api",
    "tetherCount": 0,
    "url": "file:///tmp/stave-samples/src/api.git"
  },
  {
    "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
    "defaultBranch": "main",
    "name": "web",
    "tetherCount": 0,
    "url": "file:///tmp/stave-samples/src/web.git"
  }
]
`;

/** `space init s-init --kind spike --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_INIT = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.48563Z",
    "id": "s-init",
    "kind": "spike",
    "repos": [],
    "version": 1
  },
  "spaceId": "s-init",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-init"
}
`;

/** `space create -e api -r web --json s-1` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_CREATE = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space create -e api --json s-1` re-run on an existing space (exit 1). NOTE: v0.4.0 emits `repo_already_in_space`, not `space_exists`. Exit code: 1. */
export const SAMPLE_ERROR_SPACE_CREATE_REPO_ALREADY_IN_SPACE = String.raw`{
  "error": {
    "code": "repo_already_in_space",
    "details": {
      "mode": "edit",
      "repo": "api"
    },
    "message": "space \"s-1\" already has repo \"api\" as edit"
  }
}
`;

/** `space create -e api --dry-run --json s-dry` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_CREATE_DRY_RUN = String.raw`{
  "dryRun": true,
  "plan": [
    "dry-run: create space directory /tmp/stave-samples/stave-root/agent-work/s-dry",
    "dry-run: write /tmp/stave-samples/stave-root/agent-work/s-dry/.stave.yaml",
    "dry-run: write /tmp/stave-samples/stave-root/agent-work/s-dry/AGENTS.md",
    "dry-run: link /tmp/stave-samples/stave-root/agent-work/s-dry/CLAUDE.md -> AGENTS.md",
    "dry-run: fetch /tmp/stave-samples/stave-root/bare-repos/api.git",
    "dry-run: add edit worktree stave/s-dry/api from origin/main at /tmp/stave-samples/stave-root/agent-work/s-dry/api"
  ]
}
`;

/** `space status s-1 --json` (exit 0); s-1 has api (edit) and web (reference). Exit code: 0. */
export const SAMPLE_SPACE_STATUS = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "memories": [],
  "repos": [
    {
      "ahead": 0,
      "base": "origin/main",
      "behind": 0,
      "branch": "stave/s-1/api",
      "dirty": false,
      "exists": true,
      "mode": "edit",
      "name": "api",
      "path": "/tmp/stave-samples/stave-root/agent-work/s-1/api"
    },
    {
      "ahead": 0,
      "behind": 0,
      "dirty": false,
      "exists": true,
      "mode": "reference",
      "name": "web",
      "path": "/tmp/stave-samples/stave-root/agent-work/s-1/references/web",
      "ref": "origin/main"
    }
  ],
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space add s-1 web --edit --json` (exit 0); web is now present as both reference and edit. Exit code: 0. */
export const SAMPLE_SPACE_ADD = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "base": "origin/main",
        "branch": "stave/s-1/web",
        "mode": "edit",
        "name": "web",
        "path": "web"
      }
    ],
    "version": 1
  },
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space add s-1 web --edit --json` again (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_REPO_ALREADY_IN_SPACE = String.raw`{
  "error": {
    "code": "repo_already_in_space",
    "details": {
      "mode": "edit",
      "repo": "web"
    },
    "message": "space \"s-1\" already has repo \"web\" as edit"
  }
}
`;

/** `space add s-1 api --json` with neither --edit nor --reference (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_ADD = String.raw`{
  "error": {
    "code": "invalid_arguments",
    "message": "choose exactly one of --edit or --reference"
  }
}
`;

/** `space remove s-1 web --json` while web is present in both modes (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_REPO_MODE_AMBIGUOUS = String.raw`{
  "error": {
    "code": "repo_mode_ambiguous",
    "details": {
      "modes": [
        "reference",
        "edit"
      ],
      "repo": "web"
    },
    "message": "space \"s-1\" has repo \"web\" as both reference and edit; pass --edit or --reference to choose"
  }
}
`;

/** `space remove s-1 web --edit --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_REMOVE = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space sync s-1 --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_SYNC = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "repos": [
    {
      "action": "drift-reported",
      "ahead": 0,
      "behind": 0,
      "mode": "edit",
      "name": "api"
    },
    {
      "action": "updated",
      "ahead": 0,
      "behind": 0,
      "mode": "reference",
      "name": "web"
    }
  ],
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space sync s-1 --references-only --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_SYNC_REFERENCES_ONLY = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "repos": [
    {
      "action": "updated",
      "ahead": 0,
      "behind": 0,
      "mode": "reference",
      "name": "web"
    }
  ],
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space sync nope --json` (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_SPACE_NOT_FOUND = String.raw`{
  "error": {
    "code": "space_not_found",
    "message": "space \"nope\" is not live (no .stave.yaml at /tmp/stave-samples/stave-root/agent-work/nope)"
  }
}
`;

/** `space retarget s-1 --repo api --base main --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_RETARGET = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space retarget s-1 --json` without --repo (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_INVALID_ARGUMENTS_SPACE_RETARGET = String.raw`{
  "error": {
    "code": "invalid_arguments",
    "message": "--repo is required"
  }
}
`;

/** `space archive s-1 --json` after appending to s-1/api/README.md (exit 1). Exit code: 1. */
export const SAMPLE_ERROR_DIRTY_WORKTREES = String.raw`{
  "error": {
    "code": "dirty_worktrees",
    "details": {
      "repos": [
        "api"
      ]
    },
    "message": "space \"s-1\" has dirty editable worktrees: api"
  }
}
`;

/** `space archive s-1 --force --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_ARCHIVE = String.raw`{
  "archivedPath": "/tmp/stave-samples/stave-root/agent-work/.archive/s-1",
  "memory": "keep",
  "spaceId": "s-1"
}
`;

/** `space list --archived --json` with s-1 archived (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_LIST_ARCHIVED = String.raw`[
  {
    "archiveBasename": "s-1",
    "archived": true,
    "createdAt": "2026-09-07T04:49:29Z",
    "id": "s-1",
    "isSaga": false,
    "logicalId": "s-1",
    "manifestCreatedAt": "2026-09-07T04:49:29.505337Z",
    "manifestVersion": 1,
    "memories": [],
    "path": "/tmp/stave-samples/stave-root/agent-work/.archive/s-1",
    "repos": [
      {
        "mode": "edit",
        "name": "api"
      },
      {
        "mode": "reference",
        "name": "web"
      }
    ]
  }
]
`;

/** `space restore s-1 --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_RESTORE = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.505337Z",
    "id": "s-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/s-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      },
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "version": 1
  },
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `space list --json` with s-init and restored s-1 live (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_LIST = String.raw`[
  {
    "createdAt": "2026-09-07T04:49:29Z",
    "id": "s-1",
    "isSaga": false,
    "logicalId": "s-1",
    "manifestCreatedAt": "2026-09-07T04:49:29.505337Z",
    "manifestVersion": 1,
    "memories": [],
    "path": "/tmp/stave-samples/stave-root/agent-work/s-1",
    "repos": [
      {
        "mode": "edit",
        "name": "api"
      },
      {
        "mode": "reference",
        "name": "web"
      }
    ]
  },
  {
    "createdAt": "2026-09-07T04:49:29Z",
    "id": "s-init",
    "isSaga": false,
    "kind": "spike",
    "logicalId": "s-init",
    "manifestCreatedAt": "2026-09-07T04:49:29.48563Z",
    "manifestVersion": 1,
    "memories": [],
    "path": "/tmp/stave-samples/stave-root/agent-work/s-init",
    "repos": []
  }
]
`;

/** `space destroy s-1 --json` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_DESTROY = String.raw`{
  "destroyed": true,
  "memory": "keep",
  "spaceId": "s-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-1"
}
`;

/** `saga create saga-1 -r web --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_CREATE = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:30.17658Z",
    "id": "saga-1",
    "kind": "saga",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "saga": {
      "members": []
    },
    "version": 2
  },
  "notes": [
    "added reference repo web to saga-1"
  ],
  "sagaId": "saga-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/saga-1"
}
`;

/** `space create --saga saga-1 -e api --json m-1` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_CREATE_IN_SAGA = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:30.241723Z",
    "id": "m-1",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/m-1/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      }
    ],
    "version": 1
  },
  "notes": [
    "added m-1 to saga saga-1"
  ],
  "spaceId": "m-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/m-1"
}
`;

/** `space create --saga saga-1 -e api --json m-2` (exit 0). Exit code: 0. */
export const SAMPLE_SPACE_CREATE_IN_SAGA_SECOND = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:30.343338Z",
    "id": "m-2",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/api.git",
        "base": "origin/main",
        "branch": "stave/m-2/api",
        "mode": "edit",
        "name": "api",
        "path": "api"
      }
    ],
    "version": 1
  },
  "notes": [
    "added m-2 to saga saga-1"
  ],
  "spaceId": "m-2",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/m-2"
}
`;

/** `saga add saga-1 s-init --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_ADD = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:30.17658Z",
    "id": "saga-1",
    "kind": "saga",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "saga": {
      "members": [
        {
          "createdAt": "2026-09-07T04:49:30.241723Z",
          "id": "m-1"
        },
        {
          "createdAt": "2026-09-07T04:49:30.343338Z",
          "id": "m-2"
        },
        {
          "createdAt": "2026-09-07T04:49:29.48563Z",
          "id": "s-init"
        }
      ]
    },
    "version": 2
  },
  "sagaId": "saga-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/saga-1"
}
`;

/** `saga remove saga-1 s-init --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_REMOVE = String.raw`{
  "manifest": {
    "createdAt": "2026-09-07T04:49:30.17658Z",
    "id": "saga-1",
    "kind": "saga",
    "repos": [
      {
        "bareRepoPath": "/tmp/stave-samples/stave-root/bare-repos/web.git",
        "mode": "reference",
        "name": "web",
        "path": "references/web",
        "ref": "origin/main"
      }
    ],
    "saga": {
      "members": [
        {
          "createdAt": "2026-09-07T04:49:30.241723Z",
          "id": "m-1"
        },
        {
          "createdAt": "2026-09-07T04:49:30.343338Z",
          "id": "m-2"
        }
      ]
    },
    "version": 2
  },
  "sagaId": "saga-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/saga-1"
}
`;

/** `saga list --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_LIST = String.raw`[
  {
    "id": "m-1",
    "isSaga": false,
    "logicalId": "m-1",
    "memberOf": "saga-1",
    "path": "/tmp/stave-samples/stave-root/agent-work/m-1"
  },
  {
    "id": "m-2",
    "isSaga": false,
    "logicalId": "m-2",
    "memberOf": "saga-1",
    "path": "/tmp/stave-samples/stave-root/agent-work/m-2"
  },
  {
    "id": "s-init",
    "isSaga": false,
    "kind": "spike",
    "logicalId": "s-init",
    "path": "/tmp/stave-samples/stave-root/agent-work/s-init"
  },
  {
    "id": "saga-1",
    "isSaga": true,
    "kind": "saga",
    "logicalId": "saga-1",
    "members": [
      "m-1",
      "m-2"
    ],
    "path": "/tmp/stave-samples/stave-root/agent-work/saga-1"
  }
]
`;

/** `saga status saga-1 --json` (exit 0); frozen snake_case contract. Exit code: 0. */
export const SAMPLE_SAGA_STATUS = String.raw`{
  "members": [
    {
      "dirty": false,
      "id": "m-1",
      "repos": [
        {
          "ahead": 0,
          "base": "origin/main",
          "base_health": "ok",
          "behind": 0,
          "branch": "stave/m-1/api",
          "name": "api"
        }
      ],
      "state": "live"
    },
    {
      "dirty": false,
      "id": "m-2",
      "repos": [
        {
          "ahead": 0,
          "base": "origin/main",
          "base_health": "ok",
          "behind": 0,
          "branch": "stave/m-2/api",
          "name": "api"
        }
      ],
      "state": "live"
    }
  ],
  "saga_id": "saga-1"
}
`;

/** `saga sync saga-1 --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_SYNC = String.raw`{
  "members": [
    {
      "id": "m-1",
      "repos": [
        {
          "action": "drift-reported",
          "ahead": 0,
          "behind": 0,
          "mode": "edit",
          "name": "api"
        }
      ],
      "state": "live"
    },
    {
      "id": "m-2",
      "repos": [
        {
          "action": "drift-reported",
          "ahead": 0,
          "behind": 0,
          "mode": "edit",
          "name": "api"
        }
      ],
      "state": "live"
    }
  ],
  "repos": [
    {
      "action": "updated",
      "ahead": 0,
      "behind": 0,
      "mode": "reference",
      "name": "web"
    }
  ],
  "sagaId": "saga-1",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/saga-1"
}
`;

/** `saga archive saga-1 --dry-run --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_ARCHIVE_DRY_RUN = String.raw`{
  "dryRun": true,
  "plan": [
    "dry-run: saga archive plan for saga-1 (members in reverse topological order, saga space last):",
    "dry-run: 1. archive member m-2",
    "dry-run: 2. archive member m-1",
    "dry-run: 3. archive saga space saga-1",
    "dry-run: remove worktree /tmp/stave-samples/stave-root/agent-work/m-2/api",
    "dry-run: archive /tmp/stave-samples/stave-root/agent-work/m-2 to /tmp/stave-samples/stave-root/agent-work/.archive/m-2",
    "dry-run: remove worktree /tmp/stave-samples/stave-root/agent-work/m-1/api",
    "dry-run: archive /tmp/stave-samples/stave-root/agent-work/m-1 to /tmp/stave-samples/stave-root/agent-work/.archive/m-1",
    "dry-run: remove worktree /tmp/stave-samples/stave-root/agent-work/saga-1/references/web",
    "dry-run: archive /tmp/stave-samples/stave-root/agent-work/saga-1 to /tmp/stave-samples/stave-root/agent-work/.archive/saga-1"
  ]
}
`;

/** `saga archive saga-1 --json` (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_ARCHIVE = String.raw`{
  "action": "archived",
  "members": [
    {
      "action": "archived",
      "archivedPath": "/tmp/stave-samples/stave-root/agent-work/.archive/m-2",
      "id": "m-2",
      "path": "/tmp/stave-samples/stave-root/agent-work/m-2"
    },
    {
      "action": "archived",
      "archivedPath": "/tmp/stave-samples/stave-root/agent-work/.archive/m-1",
      "id": "m-1",
      "path": "/tmp/stave-samples/stave-root/agent-work/m-1"
    }
  ],
  "memory": "keep",
  "notes": [
    "archived m-2 to /tmp/stave-samples/stave-root/agent-work/.archive/m-2",
    "archived m-1 to /tmp/stave-samples/stave-root/agent-work/.archive/m-1",
    "archived saga-1 to /tmp/stave-samples/stave-root/agent-work/.archive/saga-1"
  ],
  "sagaArchivedPath": "/tmp/stave-samples/stave-root/agent-work/.archive/saga-1",
  "sagaId": "saga-1",
  "sagaPath": "/tmp/stave-samples/stave-root/agent-work/saga-1"
}
`;

/** `saga destroy saga-2 --json` where saga-2 had one member m-3 (exit 0). Exit code: 0. */
export const SAMPLE_SAGA_DESTROY = String.raw`{
  "action": "destroyed",
  "members": [
    {
      "action": "destroyed",
      "id": "m-3",
      "path": "/tmp/stave-samples/stave-root/agent-work/m-3"
    }
  ],
  "memory": "keep",
  "notes": [
    "destroyed m-3",
    "destroyed saga-2"
  ],
  "sagaId": "saga-2",
  "sagaPath": "/tmp/stave-samples/stave-root/agent-work/saga-2"
}
`;

/** `saga status nope --json`: exit 1, EMPTY stdout, prose on stderr (no JSON envelope). Exit code: 1. */
export const SAMPLE_PROSE_SAGA_STATUS_NOT_FOUND_STDERR = String.raw`open /tmp/stave-samples/stave-root/agent-work/nope/.stave.yaml: no such file or directory
`;

/** `memory providers --json` (exit 0); marmot was installed on the capture machine, so available:true. Exit code: 0. */
export const SAMPLE_MEMORY_PROVIDERS = String.raw`[
  {
    "available": true,
    "binary": "marmot",
    "capabilities": [
      "dens",
      "refs",
      "links",
      "warrens"
    ],
    "default": true,
    "name": "marmot",
    "version": "marmot v0.1.12-18-ge7ff34a-dirty (commit e7ff34a, built 2026-08-05T20:59:21Z)"
  }
]
`;

/** `memory list --json` with no attachments anywhere (exit 0). Exit code: 0. */
export const SAMPLE_MEMORY_LIST = String.raw`[]
`;

/** `memory list s-init --json` with no attachments (exit 0). Exit code: 0. */
export const SAMPLE_MEMORY_LIST_SPACE = String.raw`[
  {
    "attachments": [],
    "spaceId": "s-init",
    "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-init"
  }
]
`;

/** `memory attach s-init --json` with marmot available (exit 0). Exit code: 0. */
export const SAMPLE_MEMORY_ATTACH = String.raw`{
  "attachments": [
    {
      "id": "s-init",
      "name": "default",
      "owned": true,
      "provider": "marmot"
    }
  ],
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.48563Z",
    "id": "s-init",
    "kind": "spike",
    "memories": [
      {
        "id": "s-init",
        "name": "default",
        "owned": true,
        "provider": "marmot"
      }
    ],
    "repos": [],
    "version": 1
  },
  "spaceId": "s-init",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-init"
}
`;

/** `memory status s-init --json` after attach (exit 0). Exit code: 0. */
export const SAMPLE_MEMORY_STATUS = String.raw`{
  "attachments": [
    {
      "id": "s-init",
      "lifetime": "task",
      "links": [],
      "name": "default",
      "owned": true,
      "provider": "marmot"
    }
  ],
  "spaceId": "s-init"
}
`;

/** `memory detach s-init --json` (exit 0). Exit code: 0. */
export const SAMPLE_MEMORY_DETACH = String.raw`{
  "detached": [
    {
      "fate": "keep",
      "id": "s-init",
      "name": "default",
      "owned": true,
      "provider": "marmot"
    }
  ],
  "manifest": {
    "createdAt": "2026-09-07T04:49:29.48563Z",
    "id": "s-init",
    "kind": "spike",
    "repos": [],
    "version": 1
  },
  "notes": [
    "den s-init kept — durable residue of this task; inspect with 'marmot den status s-init'"
  ],
  "spaceId": "s-init",
  "spacePath": "/tmp/stave-samples/stave-root/agent-work/s-init"
}
`;

/** `space status nope --json`: exit 1, EMPTY stdout, prose on stderr (no JSON envelope). Exit code: 1. */
export const SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR = String.raw`open /tmp/stave-samples/stave-root/agent-work/nope/.stave.yaml: no such file or directory
`;

/** `stave version` (no --json; exit 0). Exit code: 0. */
export const SAMPLE_VERSION_OUTPUT = String.raw`stave v0.4.0
commit: unknown
date: unknown
`;
