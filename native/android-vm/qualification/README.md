# Offline guest qualification

Target: guest UID 1000, Node **24.14.1**, Codex **0.160.1**, Claude Code
**2.1.291**, Lecturn **0.0.51-nightly.20261008.98**. This folder owns no server,
broker, Android-host, phone, ADB, or cloud changes.

## Run by the parent inside the guest

Copy this folder together, then run as UID 1000:

```sh
python3 qualify.py --guest
# Optional if installed somewhere else:
python3 qualify.py --guest --package /opt/lecturn-tools/node_modules/lecturn
```

The runner requires `unshare --user --map-current-user --net`; it verifies a new
network namespace with no external interfaces. Namespace failure is fatal, with
no online fallback. This extra namespace qualifies offline negotiation; it does
not substitute for native-guest sandbox enforcement testing.

Every test gets a fresh synthetic working directory, HOME, CODEX_HOME, Claude
config directory, and an allowlisted environment. Provider/account credentials
are neither copied nor inspected. No login, account/status RPC, model discovery,
MCP invocation, prompt, `turn/start`, provider substitution, or running server
connection is issued. No changes are made to port 3773 or its data.

Evidence remains in the printed `lecturn-offline-qualification-*` temporary
folder: `results.json`, captured PID/argv records, separate stdout/stderr, generated
schema, and real app-server JSONL transcripts. Nonzero exit means some probe
failed. `NOT_RUN` entries remain unqualified even when the exit is zero. Delete
only the exact printed evidence folder when no longer needed.

The checks cover:

- Exact CLI versions and installed Lecturn package version/entry hash.
- Generated Codex schema and Claude advertised permission choices.
- A separate real Codex stdio app-server for each of the four modes:
  `initialize` → `initialized` → ephemeral `thread/start` →
  `thread/unsubscribe` → EOF/process teardown. Effective approval policy,
  reviewer, sandbox type, network flag, cwd, and disposal status are checked.
  Auth requirements, timeouts, missing fields, rejected modes, or changed
  permissions fail; the script never retries with weaker settings.
- Packaged `node-pty`: real terminal child, input, resize acknowledged by the
  child, expected terminal dimensions, and clean exit.
- Native `node:sqlite`: parameter binding, column metadata, commit, rollback,
  on-disk reopen. This exercises the native API used by Lecturn's Node SQLite
  adapter, not Lecturn migrations or its full persistence service.
- Packaged `@ff-labs/fff-node`: real synthetic-file index, filename search,
  content search, and destroy. Dependencies resolve from the installed Lecturn
  package, never a repository mock or a newly installed replacement.

All spawned processes have captured PIDs and bounded waits. Node's PTY child has
its own PID record and deadline. Overall guest execution is capped; termination
cleans up owned processes. No name-based process killing is used.

## Findings verified locally

Local Mac CLI versions match the pins. `--version`, `--help`, and generated-schema
checks passed with fresh synthetic homes. Five harness selfchecks plus Python
and JavaScript syntax checks passed. **No guest/device execution occurred here.**
The previously reported phone sandbox passes and active server are parent-provided
context, not new verification by this folder.

Mappings below are from the current repository at
`0ba3c1cbcc92c62cb45c2707a8b993a6344fbd66`, not a claim that the installed nightly's
bundle or UI has been exercised. The source package.json says `0.0.50`; the guest
script separately gates the requested installed nightly pin.

| Lecturn mode            | Codex thread policy / sandbox / reviewer         | Claude SDK options                                                                      |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `approval-required`     | `untrusted` / `read-only` / `user`               | `permissionMode` omitted; provider default, with Lecturn `canUseTool` approval callback |
| `auto-accept-edits`     | `on-request` / `workspace-write` / `user`        | `permissionMode: acceptEdits`                                                           |
| `auto` (approve for me) | `on-request` / `workspace-write` / `auto_review` | `permissionMode: auto`                                                                  |
| `full-access`           | `never` / `danger-full-access` / `user`          | `permissionMode: bypassPermissions`, `allowDangerouslySkipPermissions: true`            |

Codex sets the reviewer explicitly on every thread/turn so `auto_review` does
not remain selected after a mode switch. Turn sandbox types are `readOnly`,
`workspaceWrite`, and `dangerFullAccess`. Codex CLI equivalents are
`-a untrusted -s read-only` (schema accepts `untrusted`; CLI parsing not exercised),
`-a on-request -s workspace-write`, `--approve-for-me`, and
`--dangerously-bypass-approvals-and-sandbox`. The generated restricted sandbox
schemas default `networkAccess` to false; workspace-write also defaults
`writableRoots` to `[]`, `excludeTmpdirEnvVar` and `excludeSlashTmp` to false.
That is not a claim that temporary directories are write-protected.

Claude flags are `--permission-mode acceptEdits`, `--permission-mode auto`, and
`--permission-mode bypassPermissions --allow-dangerously-skip-permissions`.
The adapter's permission options do not enable an OS sandbox. Full access also
allows tool callbacks in the adapter; other modes surface callbacks to Lecturn
when Claude requests them. Approval mode and filesystem isolation are distinct.

Actual drift worth preserving:

- Codex **0.160.1 generated app-server schema still accepts `untrusted`**. Its
  top-level CLI help lists only `on-request` and `never`. Do not retire the
  app-server mapping based on help/docs alone; guest negotiation is the next proof.
- Shared `ProviderApprovalPolicy` still includes **`on-failure`**, but this
  generated Codex schema does **not**. None of the four runtime modes maps to it.
  Passing it through as though supported would be incorrect.
- Codex reviewer schema accepts `user`, `auto_review`, and legacy
  `guardian_subagent`; Lecturn uses `auto_review`. Granular approval objects
  exist in the Codex schema but are absent from the shared string-only policy.
- Claude **2.1.291 help lists `manual`, not `default`**, alongside `acceptEdits`,
  `auto`, `bypassPermissions`, `dontAsk`, and `plan`. Lecturn omits the field for
  approval-required. Do not send a guessed `default` value or claim that an
  omitted mode's effective behavior was verified. `plan` is not one of the four
  runtime permission modes; Lecturn models interaction mode separately.

Source pointers:
[shared contracts](../../../packages/contracts/src/orchestration.ts),
[Codex mapping](../../../apps/server/src/provider/Layers/CodexSessionRuntime.ts),
[Claude mapping and tool callback](../../../apps/server/src/provider/Layers/ClaudeAdapter.ts),
[SQLite adapter](../../../packages/shared/src/nodeSqliteClient.ts),
[search adapter](../../../apps/server/src/workspace/WorkspaceSearchIndex.ts).

## MCP registration: later, by the parent

```sh
python3 register-mcp.py          # prints the exact commands; makes no changes
python3 register-mcp.py --apply  # guest UID 1000, fresh normal-user config only
```

This registers `symba-mobile` for Codex and Claude's **user scope**, with Python
stdio and only these nonsecret references:

- `/home/lecturn/.config/symba/mobile_mcp.py`
- `/home/lecturn/.config/symba/agent-token`

It never embeds or reads the token. It does not start the bridge or invoke a
mobile tool. The existing bridge client requires nonroot execution and validates
ownership/private permissions when it eventually reads the token. Provisioning
the client/token and exercising the bridge belong to the parent. Apply refuses
existing provider config/auth files rather than overwriting them; a second-command
failure can leave the first registration present and is reported as partial.

## Remaining qualification

No authentication or inference was used. Claude auto-classifier availability,
actual approval/deny behavior, sandbox enforcement during turns, mode switching,
full UI integration, nightly bundle/source parity, background provider sessions,
Android permission gates, and MCP device calls remain unverified. Codex's
`auto_review` schema describes model-assisted review; starting a no-turn thread
does not exercise that reviewer. An unauthenticated thread-start rejection is
an explicit failure/limitation, not proof that a weaker mode should be selected.

Local rerun, without guest operations:

```sh
python3 qualify.py --local-contracts
python3 selfcheck.py
node --check dependencies.mjs
```
