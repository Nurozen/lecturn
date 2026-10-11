# Android-local device broker

A separate Android `app_process` daemon owns native grants and typed privileged
operations. Linux providers run as an ordinary guest user and receive only the
agent credential. The VM, native APK, provisioning, provider installation, and
init/SELinux integration belong to the parent runtime build.

## Build and focused checks

Requires JDK 21+, Android SDK 36 / D8 and NDK r27; host path tests also use
`cc` (override with `CC`). Nothing is downloaded or started.

```sh
BROKER_OUT=/absolute/scratch/broker-build ./build.sh
ORG_JSON_JAR=/absolute/existing/org-json.jar \
  BROKER_OUT=/absolute/scratch/broker-build ./test.sh
```

Outputs are `lecturn-device-broker.jar` (dex) and `liblecturn_securefs.so` (ARM64).
Override `JAVA_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME`, `NDK_HOST_TAG` for
other hosts. Default output is local ignored `artifacts/`. Host tests exercise
policy, protocol, runtime snapshots, Java/native path validation and the stdio client; they do **not** execute
Android Binder/SELinux or the kernel's `openat2` implementation.

## Provisioning boundary

The trusted Android launcher invokes `dev.lecturn.broker.Broker` with three
arguments: absolute JNI library path, control-token file path, agent-token file
path. Provision the JAR/library/launcher root-owned and immutable to app/guest
UIDs. The process requires UID 0. The experimental SymbaOS userdebug integration uses
its existing permissive `su` domain while global SELinux stays Enforcing. This
is not production SELinux containment; a dedicated enforcing domain remains
future work. Linux providers remain ordinary guest processes. This directory intentionally contains no bootstrap,
ADB, init or policy-widening script.

The APK `com.cloudgatherer.lecturn.symba` creates a private mode-0600 file containing
64 random hex digits under its canonical `/data/data/<package>/files/` or
`/data/user_de/0/<package>/files/`. It owns this control token. A root-owned,
mode-0600 `/data/local/symba-runtime/state/agent-token` holds a different 64-hex
agent token. Only the latter is copied to a private file owned by the unprivileged
guest provider user. Tokens may have one final newline. Symlinks, shared modes,
hardlinks, oversized token files and equal token values are rejected.

The parent must keep the control token, status file, host APK data and Android
root paths outside guest mounts and provider access. Forward **only** guest
loopback 18769 to Android loopback 18769. Never forward 18768. Both native
listeners bind to `127.0.0.1`; VM networking must preserve this separation.

## Native control contract

Native HTTP clients use `Host: 127.0.0.1:18768` and
`Authorization: Bearer <control token>`. Browser Origin/Referer requests are
rejected. No CORS, redirects, chunked requests or unauthenticated control exists.
POST bodies require `Content-Type: application/json` and Content-Length, with a
384 KiB bound. Header bound is 8 KiB. Requests have a bounded read deadline.

- `GET /v1/state`: schemaVersion 1 with runtime `{status,message}`, `uiUrl`,
  activity `{state,threadId,title,detail,taskUrl,completedSteps,totalSteps}`,
  policy `{revision,fullAccess,computerUse}`, capabilities `{appData,computerUse}`.
- `POST /v1/ui/bootstrap`: `{}`. HTTP 200 returns **only**
  `{schemaVersion:1,pairingUrl,expiresAt}`, not a state response. Requires fresh
  ready state and rechecks runtime/authenticated health. HTTP 409 means a runtime
  operation is in progress; HTTP 503 `ui_bootstrap_unavailable` means no fresh
  ready runtime, and `ui_bootstrap_failed` means minting/response validation failed.
  No upstream response or credential appears in errors. This endpoint exists
  only on CONTROL and never creates a receipt. Responses have `Cache-Control: no-store`.
- `POST /v1/policy`: `{expectedRevision,fullAccess,computerUse}`. Revision conflicts
  return 409; computerUse requires fullAccess. Response includes applied state.
- `POST /v1/runtime/start`, `POST /v1/runtime/stop`: `{}`. Receipt follows the
  parent's transition; failed transitions return 503. Start may acknowledge
  `starting`; only authenticated Lecturn health produces `ready`. An overlapping
  poll/transition can return retryable 409. Stop confirms stopped with status.
- `GET /v1/receipts`: the last 128 in-memory bounded operation receipts. They
  contain operation, policy revision, time, result and ID; no file names, contents
  or credentials. Failed mutations require reconciliation before retry because a
  directory fsync failure can occur after a successful rename/unlink.

The APK must display native confirmation that **full access applies to every
Lecturn task and all eligible installed user-0 apps**. Computer use has a separate
native confirmation. Native policy is never read from a provider/auth file and
cannot be changed on the agent listener. Grants start disabled; broker restart,
runtime control start/stop, observed stop or runtime instance change revokes them.
Capabilities report adapter support, not effective permission or proven SELinux
access. File access also requires the grant, current user 0 and unlocked CE data.
After the first CE unlock, background file access can continue while the screen
is locked or off. Computer use additionally requires an interactive, unlocked
screen. Switching away from user 0 or unknown user/unlock state refuses both.

## Runtime adapter supplied by parent

`/data/local/symba-runtime/bin/runtime-control` and every ancestor must be
root-owned, non-symlink and not group/world writable, except the platform `/data`
directory may be system:system (1000:1000) with exactly mode 0771. This exception
does not apply to descendants or symlinks. The executable accepts
exactly `start`, `stop`, or `status`, returns within 30 seconds, and writes at most
64 KiB of JSON to stdout:

```json
{ "schemaVersion": 1, "status": "starting", "instanceId": "unique-runtime-boot-id" }
```

Statuses are stopped, starting, ready, error. `instanceId` is required for
starting/ready, stable during a boot, and changes on every restart. An optional
string `message` of at most 512 characters is accepted, including with `starting`;
it is not forwarded into broker state. Start returns
after actual transition to starting/ready; stop returns only when stopped. Spawned
runtime processes must detach their stdout/stderr before this executable exits.
Environment is limited to `PATH=/system/bin`, `LANG=C`; use fixed absolute paths.
The broker never invokes a missing executable.

Parent atomically provisions root-owned mode-0600
`/data/local/symba-runtime/state/runtime.json`:

```json
{
  "schemaVersion": 1,
  "uiUrl": "http://127.0.0.1:3773",
  "lecturnBearerToken": "REAL_LECTURN_ACCESS_TOKEN"
}
```

The phone-side 3773 endpoint must reach guest Lecturn. This file never enters the
guest/provider mount namespace. The bearer needs `access:write` and all current
standard client scopes (`orchestration:read`, `orchestration:operate`,
`terminal:operate`, `review:write`, `relay:read`) to mint a browser link; a
read-only bearer can pass health but bootstrap will fail. The broker fetches the actual authenticated
`GET /api/orchestration/shell` with redirects disabled. The source contract is
`packages/contracts/src/orchestration.ts` (`OrchestrationShellSnapshot`,
`OrchestrationThreadShell`) and `environmentHttp.ts` (`shellSnapshot`).

Pending approvals/user input/plans, running turn/session, background liveness,
and current plan progress drive activity. The highest-priority nonarchived
thread is selected, with validated updatedAt breaking ties. The environment ID
comes from `GET /.well-known/lecturn/environment` at the same fixed loopback
origin. `taskUrl` is `http://127.0.0.1:3773/<encoded environmentId>/<encoded threadId>`,
matching fullweb's `routes/_chat.$environmentId.$threadId.tsx` (the `_chat`
layout has no URL segment). Only validated fields from the current authenticated
snapshot drive routing; no selected thread means null. API/descriptor failures
clear both URLs and mark activity stale; a last successful snapshot also expires
after 10 seconds. No predicted progress. Polling does not hold up state reads.

### Android host pairing integration

`GET /v1/state.uiUrl` stays credential-free and stable. The host's existing
state parser must not parse the bootstrap response. When a ready WebView lacks
an authenticated session, native code calls `POST /v1/ui/bootstrap {}` with its
control bearer, validates schemaVersion 1, expiry and the literal loopback URL,
then loads `pairingUrl` privately. It has the exact form
`http://127.0.0.1:3773/pair#token=<one-time credential>`.

The broker uses real `POST /api/auth/pairing-token` with the private Lecturn bearer
and `{label:"Lecturn Android host"}`; omitted scopes select standard client
scopes, not administrative browser access. Fullweb reads/removes the fragment and
exchanges `{credential}` at `POST /api/auth/browser-session`, which sets the
WebView cookie. The broker must not consume that one-time token itself: its HTTP
connection cannot install the browser's cookie. See `auth/http.ts`,
`environmentHttp.ts`, `environments/primary/auth.ts` and `shared/remote.ts`.

Keep pairing responses/URLs only in native process/private WebView storage,
never in status, notifications, logs, saved state, intents, or agent APIs. Do not
mint on every state poll. Reuse an authenticated WebView; confirm
`GET /api/auth/session` returns boolean `authenticated:true` before navigating
to the latest fresh `activity.taskUrl`. On expired/consumed pairing, request a
fresh link through native retry, never reuse the old URL. Redirects and non-JSON
or malformed upstream responses fail closed. No APK edits are included here;
the host owner must add this native bootstrap call to its existing auth check.

## Typed file and screen operations

Agent HTTP on 18769 exposes only `POST /v1/tools/call` with `{name,arguments}`.
Every file or package-list action requires fullAccess plus positively known
current user 0 and unlocked CE. Before first CE unlock, after a user switch, or
when user/CE state is unknown, access fails closed for every root (including DE).
A locked or noninteractive screen alone does not block background file work.
Screen leases, capture, input and launch also require no keyguard/device lock
and an interactive screen.

Full access includes app-owned `.pem`, `.key`, `keys` directories and credential
databases, including credential-manager app data; package/file keywords are not
security boundaries. The controller APK and the exact Android system KeyChain
package `com.android.keychain` remain excluded. Other users, arbitrary
shell/Binder operations and paths outside the fixed roots are unavailable.

File calls take `root`, `package`, `path`. Roots are fixed:

| root      | user-0 directory                                                                   |
| --------- | ---------------------------------------------------------------------------------- |
| ce        | `/data/data/<package>` (canonical CE; no `/data/user/0` symlink)                   |
| de        | `/data/user_de/0/<package>`                                                        |
| shared    | `/data/media/0/Android/data/<package>`                                             |
| media     | `/data/media/0/Android/media/<package>`                                            |
| obb       | `/data/media/0/Android/obb/<package>`                                              |
| storage   | `/data/media/0` excluding the top-level `Android` subtree (requires `package: ""`) |
| downloads | `/data/media/0/Download` (requires `package: ""`)                                  |
| documents | `/data/media/0/Documents` (requires `package: ""`)                                 |

`storage` covers DCIM, Pictures, Movies, Music, Recordings and other owner shared
files, including files directly in `/data/media/0`. Its `Android` subtree is
blocked case-insensitively and hidden from listings; use `shared`, `media` or
`obb` with an eligible installed package instead. This preserves the controller
and KeyChain exclusions and installed-package check. No `/storage/emulated/0`
symlink alias, other-user root, removable-volume root or global `/` is exposed.

`mobile_list_files` allows an empty path and at most 512 entries;
`mobile_read_file` accepts optional integer `offset` (default 0) and `length`
(default/max 262144, minimum 1). A large regular file is read in bounded chunks;
the response retains base64 `data`, `encoding`, `untrusted` and adds `offset`,
`bytesRead`, `fileTotalBytes`, `eof`. The size and bytes come from the same opened
FD. EOF or an offset beyond EOF returns an empty chunk. Size/mtime/ctime changes
during a chunk fail; separate chunks are not a snapshot of a concurrently edited
file. `mobile_write_file` and `mobile_delete_file` still require a regular file no
larger than 256 KiB (262144 bytes), including the existing destination of a
replacement. Writes encode bytes as base64 in `data`; the encoded limit is
349528 characters and the HTTP body limit remains 384 KiB. There is no append,
chunk upload, directory creation, or recursive delete. Larger photos, videos and
databases can be read in chunks but cannot be created, replaced or deleted by
these tools. Upload sessions would need bounded staging, expiry/cleanup and
grant-epoch binding through commit; the current stage/commit handles live only
within one request. Full access widens eligible locations, not these operation
limits.

JNI anchors resolution with directory FDs and Linux `openat2` BENEATH /
NO_SYMLINKS / NO_MAGICLINKS. There is no realpath-then-open fallback. Missing
kernel support fails closed. Regular file hardlinks and special files are denied.
Writes stage in the resolved parent, preserve ownership/mode/SELinux label, fsync,
recheck grant epoch and current-user CE availability, then rename atomically under the policy
lock. Delete is non-recursive. Revocation prevents subsequent mutation commits;
action admission and completed responses cannot recall bytes already disclosed.

These are bounded file operations, **not live database or app-format editors**.
Concurrent app writers, ACL/xattr fidelity beyond SELinux, and app lifecycle
coordination are not supported. Stop the target app through an approved lifecycle
before edits and reconcile ambiguous failure receipts. App-owned key material
stored in ordinary files is included in Full access. System keystore directories
(such as `/data/misc/keystore`) are outside the fixed roots; symlinks and traversal
cannot reach them. Hardware-backed non-exportable TEE/StrongBox keys are not files
this API can extract, and it exposes no hardware key service. The `.lecturn-`
filename prefix remains reserved for internal atomic-write staging.

## Physical input and short screen leases

The root broker enumerates `/dev/input/event*`, qualifies touchscreen axes/direct
input properties and physical key capabilities using evdev ioctls, and checks
sysfs ancestry to exclude virtual/uinput nodes. It requires at least one direct
touchscreen and one physical key detector. All event nodes must be inspectable;
missing/read-denied/unsupported detectors fail closed. A native poll thread reads
hardware events without grabbing devices or logging coordinates/key content.
Framework-injected events do not originate in evdev. Physical events revoke only
the active computer-use lease; background file/code work retains its separate
app-wide grant. The broker never changes the physical user's input delivery.

Computer-use capability is live: it requires the monitor, a fresh heartbeat,
no pending input/topology changes, no held touch/key, 500 ms physical quiet, and
the framework injection adapter. Detector loss, `SYN_DROPPED`, or input-device
creation/removal/attribute changes fail closed (restart the broker to requalify
a changed topology). Unknown visibility/current user also refuses operations.
There is no agent/environment override, broad shell tool, or authentication bypass.

Tap/swipe/key injection uses Android's root InputManager reflection adapter with
individual asynchronous framework input events, rather than a long-lived shell
input process. It compiles against the public SDK and resolves the framework
adapter from the Android system classpath. Only one operation runs at a time.
Every event checks visible unlock plus the lease generation; a 10 ms watchdog
checks lease/detector state without waiting for visibility Binder calls. Physical revocation invalidates the lease before
cancellation acquires the per-event lock. Cancellation sends ACTION_CANCEL for
an active touch or FLAG_CANCELED key-up for a held key. A failed injection/cancel
makes capability unavailable for that broker lifetime. Cancellation cannot undo
an event already delivered. Visibility Binder calls and screenshot capture do
not hold the cancellation lock. A stalled system input Binder enqueue can still
delay cancellation; this is not a hard real-time guarantee.

Each screenshot/input/launch requires both native grants and an explicit 1–15
second lease. Lease replacement while active is rejected; releasing it permits
a new lease. Screenshot output is checked after capture and again before the
result is returned. The stdio MCP adapter emits standard PNG `image` content.
The capture adapter executes `/system/bin/screencap -p` with a 3-second, 8-MiB
bound and validates the PNG signature. Actual-device screenshot qualification
has not been performed here. Real-device injection, cancellation ordering and physical-input isolation remain
parent qualification requirements; host tests do not establish them.

### Root-local monitor qualification (no authentication or listener)

The parent may run this **read-only** entry point from its existing trusted root
launcher with the same library/classpath as the broker. It never loads credentials,
changes grants, injects input, or starts a server:

```sh
CLASSPATH=/absolute/lecturn-device-broker.jar /system/bin/app_process /system/bin \
  dev.lecturn.broker.InputMonitorProbe /absolute/liblecturn_securefs.so 15
```

It prints one JSON record per second for 1–60 seconds. The schema is
[`test/physical-input-probe.schema.json`](test/physical-input-probe.schema.json).
`ready: true` uses the real native qualification and idle checks; touching or
pressing a physical key must increment `inputOrFailureNotifications` and suppress
readiness until release/quiet. The count also includes detector failures and is
not a count of gestures. `injectionTested` is always false. This probe supplies no
production capability override. Test injection/revocation through the normal
native grants and authenticated agent tools, while a person controls the phone.

## Guest MCP and provider approvals

Run `python3 client/mobile_mcp.py --token-file <private-guest-agent-token>` as an
ordinary guest user (the CLI refuses UID 0). It is a standard newline-framed stdio MCP server supporting
initialize, ping, tools/list and tools/call. Notifications never execute tools.
PNG screenshots produce image content; file bytes are marked untrusted.

The client keeps familiar callable names `mobile_list_apps`,
`mobile_take_screenshot`, `mobile_click_on_screen_at_coordinates`,
`mobile_swipe_on_screen`, `mobile_press_button`, and `mobile_launch_app`, mapping
them to the narrow native names. Arguments follow tools/list: this is one local
phone, no arbitrary device selector, and explicit leaseId is required for screen
actions. It is not a drop-in implementation of every older mobile MCP parameter.

Parent registers this stdio server through existing provider MCP integration.
Lecturn's `provider/Layers/CodexAdapter.ts` and `ClaudeAdapter.ts` already route MCP
calls through their normal approval modes; retain those hooks. Provider approval
is an additional gate and cannot grant Android capabilities or change native
policy. This component neither edits provider configuration nor launches a
provider as root. End-to-end provider registration remains parent integration.
