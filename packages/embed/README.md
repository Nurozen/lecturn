# @lecturn/embed

Embed Lecturn's chat in your app and expose your app's tools to its agents. The user approves your
app once in Lecturn; after that your app gets its own Lecturn projects, its threads show up in
Lecturn's Apps mode, and agents on those threads can call your tools.

| Entry                     | Runs in                     | Use                                                        |
| ------------------------- | --------------------------- | ---------------------------------------------------------- |
| `@lecturn/embed/node`     | Your main or server process | `connect()`: find Lecturn, pair, start the sidecar, leases |
| `@lecturn/embed/electron` | Electron main               | `mountEmbedView()`: the chat as a `WebContentsView`        |
| `@lecturn/embed/renderer` | Electron preload and page   | Pane position and host messages over IPC                   |
| `@lecturn/embed/browser`  | A web page                  | `mountEmbed()`: the chat as an iframe                      |

## Install

The packages are not published to npm yet. Vendor them from a Lecturn checkout:

```sh
vp run --filter lecturn build
vp run --filter @lecturn/embed build
node apps/server/scripts/cli.ts pack --out-dir ../my-app/vendor/lecturn
```

The kit holds the `lecturn` and `@lecturn/embed` tarballs, the `patches/` their dependencies
need, and `lecturn-pack.json`, which lists the install settings your package manager must use
(hoisted `node_modules`, the patched dependencies, allowed build scripts) and notes for packaging
into `app.asar`. Add both tarballs as dependencies and apply those settings.

## Electron in a few lines

```ts
// main process
import { connect } from "@lecturn/embed/node";
import { mountEmbedView } from "@lecturn/embed/electron";

const lecturn = await connect({
  registration: {
    appId: "dev.example.embedhost",
    name: "Embed Host",
    iconDataUrl,
    toolPrefix: "ex",
    openUrlTemplate: "embedhost://open?workspace={workspaceRoot}&thread={threadId}",
    refPrefixes: ["ex:"],
    headlessTools: {
      command: bundledNode,
      args: [counterServerPath, "--root", "{workspaceRoot}"],
      listArgs: [counterServerPath, "--list-tools"],
      cwd: "{workspaceRoot}",
    },
    liveTools: true,
    gatedTools: ["window_flash"],
    instructions: "You can increment a counter and flash the host window.",
  },
  lecturnHome: process.env.LECTURN_HOME, // tests pass a temp dir
  sidecar: {
    serverEntry: require.resolve("lecturn/dist/bin.mjs"),
    baseDir: join(app.getPath("userData"), "lecturn"),
    nodePath: bundledNode,
  },
  signal: quitting.signal,
});
const { projectId } = await lecturn.ensureWorkspace(workspaceRoot, "ws-a");
const live = await startLiveMcp(); // your own HTTP MCP server, serving window_flash
await lecturn.setLiveTools({ url: live.url, bearer: live.token });

const embed = mountEmbedView(win, {
  connection: lecturn,
  projectId,
  theme: hostTokens,
  bounds: paneRect,
});
embed.on("lecturn/navigate", ({ ref }) => focus(ref));
```

```ts
// preload of your window
import { exposeEmbedRendererIpc } from "@lecturn/embed/renderer";
exposeEmbedRendererIpc({ contextBridge, ipcRenderer });

// your page
import { reportPaneRect, sendBridge } from "@lecturn/embed/renderer";
reportPaneRect(document.querySelector("#chat-pane")!);
sendBridge({
  method: "lecturn/composer.insertMention",
  params: { ref: `ex:item/${item.id}`, label: item.name },
});
```

`reportPaneRect` keeps the view over an element of your page, so you never compute bounds yourself
after the first mount. The view runs Lecturn's web app with its own preload, partition and sandbox;
`webPreferences` can tune the rest but not those.

[`examples/embed-host`](../../examples/embed-host) is a complete host built this way.

## Registration

- `appId` is reverse-DNS (`dev.example.embedhost`). `toolPrefix` names your tools to agents as
  `<prefix>_<tool>`, so two apps never collide.
- `refPrefixes` mark references to your app's objects, such as `ex:item/42`. They show as chips in
  messages, and clicking one sends `lecturn/navigate` back to you.
- `openUrlTemplate` is how Lecturn's **Open in** button reopens your app at a thread.
- `headlessTools` is an MCP server over stdio that Lecturn starts on demand, one process per
  workspace, with `{workspaceRoot}` substituted in `args`, `listArgs`, `env` and `cwd`. It works
  while your app is closed.
- `liveTools: true` means your running app serves more tools over HTTP (see Live tools).
- `gatedTools` always need approval, subject to the thread's permission mode.
- `embedOrigins` lists the loopback origins allowed to frame Lecturn, with their port
  (`http://127.0.0.1:5173`) or a port wildcard (`http://127.0.0.1:*`). Only iframe hosts need it.
- `instructions` (at most 8 KB) reach the agent on every thread of your app.

The user approves the headless command (including `listArgs` and `env`) and `embedOrigins`. If
either changes, your app's access pauses until the user approves again.

Lecturn removes `ELECTRON_RUN_AS_NODE` from tool processes. If your tools run on your Electron
binary in Node mode, set `env: { ELECTRON_RUN_AS_NODE: "1" }` yourself.

### Declare `listArgs`

`listArgs` is a second argument list for the same command that prints your tool definitions as
JSON (`{ "tools": [...] }` or a bare array) and exits. Lecturn runs it when the user grants your
app and on each `ensureWorkspace`, and caches the result, so agents see your tools from the first
turn. It must not take any lock or state your app holds: it can run while your app or another
tool process owns the workspace.

Without `listArgs`, Lecturn learns your tools by starting the full tool server the first time a
thread lists tools. Codex gives MCP servers only 10 seconds to start, so a slow start can leave a
thread without your tools.

## Tool calls

Every call carries `_meta["lecturn/context"]`
(`{ projectId, threadId, workspaceRoot, turnId }`) and `_meta["lecturn/approval"]`
(`{ approved, requestId? }`).

- `approved: true` means the user already approved this call, or the thread runs in Auto or Full
  access, where tools run without asking. Run the call; do not ask the user again yourself.
- To ask about one call, return a result with `_meta["lecturn/approval-required"]: { reason }`.
  In Supervised and Auto-accept edits, Lecturn shows the reason, and on approval sends the call
  again with `{ approved: true, requestId }`. With the per-app Read-only ceiling, Lecturn refuses it.
- A tool whose definition has `_meta.ui.resourceUri` renders its MCP App resource as a card in
  every Lecturn client. Without `"model"` in `_meta.ui.visibility`, agents do not see the tool.
  Other `_meta` keys in definitions are dropped.

On Cursor, a call waiting for approval fails after 60 seconds, because Cursor's tool timeout
cannot be raised.

## Live tools

```ts
await lecturn.setLiveTools({ url: "http://127.0.0.1:43123/mcp", bearer });
```

Your running app serves these as a Streamable HTTP MCP server on loopback, checking the bearer.
`setLiveTools` publishes the endpoint and renews a 60-second lease every 20 seconds; Lecturn lists
the tools again each time a lease starts. If your app stops renewing, or calls `clearLiveTools()`,
live calls answer that the app is closed, and Lecturn shows that on your threads.

## Theming

`theme` is `"light"`, `"dark"`, or `{ theme, styles }`, and `embed.setTheme(...)` changes it
later. `styles.variables` sets Lecturn's own CSS variables, and unknown names are dropped:
`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`,
`--popover-foreground`, `--muted`, `--muted-foreground`, `--secondary`, `--secondary-foreground`,
`--border`, `--input`, `--primary`, `--primary-foreground`, `--accent`, `--accent-foreground`,
`--ring`, `--destructive` (the stop button of a running turn), `--radius`, `--font-sans`,
`--font-mono`.

`styles.css.fonts` may carry only `@font-face` rules whose sources are `data:` URLs, at most
200 KB, because the view cannot fetch fonts from your origin. The whole theme must fit Lecturn's
256 KB bridge message; `mountEmbedView` throws, naming the size, when it does not.

## Talking to the view

- To the view: `insertMention({ ref, label, iconUrl? })`, `setDraft(text)`, `openThread(threadId)`,
  `newThread({ title?, appData? })`, `openProviders()`, `setTheme(theme)`.
- From the view: `lecturn/navigate` (`{ ref }`), `lecturn/thread.changed` (`{ threadId }`),
  `lecturn/turn.state` (`{ threadId, state }`), `lecturn/ready` (`{ threadId }`), and `error`.
- `composerPlaceholder` (at most 200 characters) replaces the prompt shown in the empty composer,
  for example `"Ask for changes…"`; `setComposerPlaceholder(text | null)` changes it later, and
  `null` brings back Lecturn's own. Prompts for approvals and questions stay Lecturn's.
- `onDescribeRefs(refs)` (a mount option) names references the view shows without a label, such
  as ones the agent wrote. Return `{ [ref]: label }` for the ones you know; the rest show as
  written. A chip you inserted keeps its label on the sent message, so the view never asks for it.
- `switcher: false` hides the view's own thread switcher when your app lists threads itself.
  `lecturn.listThreads(projectId)` and `lecturn.subscribeThreads(projectId, listener)` give you
  that list. `setThreadAppData(threadId, appData, subtitle?)` stores up to 1 KB of your own data
  and an 80-character subtitle on a thread.
- `lecturn.updateHostContext({ threadId } | { projectId }, text)` tells the next turns what your
  app shows right now, in at most 4 KB.

## In a web page

```ts
import { mountEmbed } from "@lecturn/embed/browser";

const { url, token } = await fetchTarget(); // your server calls lecturn.embedTarget(projectId)
const embed = mountEmbed(container, {
  url,
  token,
  theme: "dark",
  onTokenRefresh: () => fetchRefreshedTarget(), // lecturn.refreshEmbedToken(projectId)
});
```

The page's origin must be in `embedOrigins`; the view answers no other parent. Embed tokens last
at most 15 minutes, and the view asks `onTokenRefresh` for a new one ahead of expiry.

## The sidecar and the live switch

`connect()` uses the user's own Lecturn when it runs on this machine and has approved your app.
Otherwise it starts a private Lecturn server for your app (the sidecar) in `sidecar.baseDir`, so
your app works before the user approves it or when Lecturn is not running. `connection.mode` is
`"user-server"` or `"sidecar"`.

While on the sidecar, `connect()` checks every 2 seconds for the user's Lecturn and asks it to pair.
When the user approves, the connection switches over without a restart: it recreates your
workspaces, copies the sidecar's threads, moves the live lease, and reloads mounted views at the
copied threads. The sidecar's originals then show read-only as **Continued in Lecturn**. If the
user's Lecturn goes away, the connection switches back. After the user denies pairing,
`requestPairingAgain()` asks again.

`lecturn.status.subscribe(listener)` reports both: `{ type: "status", mode, pairing, app }`, and
on each switch `{ type: "mode", mode, environmentId, projectIdsByWorkspaceRoot, threadIdMap }`.
Project and thread ids differ between servers, so key your mounts, caches and thread lists by
workspace root, never by project id, and resolve a copied thread's history through
`copiedFrom.sourceThreadId`. A view mounted with `connection` follows the switch itself. A view
mounted with `target` (an `EmbedTargetSource`, for hosts whose `connect()` runs elsewhere) needs
`embed.retarget(projectId, threadId)` on each `mode` event.

## Host lifetime

The sidecar never outlives the process that started it:

- Pass your app's lifetime as `signal`. Aborting it while `connect()` is still starting the sidecar
  stops that process, and `connect()` rejects with the signal's reason only once the process has
  exited. Aborting it later closes the connection.
- The promise `connect()` returns also has `close()`, which works before it settles. Before ready,
  it stops a starting sidecar and resolves once the process has exited; after ready, it is the
  connection's `close()`.
- If your process exits without closing, crashes included, the sidecar notices and shuts itself
  down: it watches a pipe that only your process holds, and its parent process.

```ts
const quitting = new AbortController();
app.on("before-quit", () => quitting.abort());
const connection = await connect({ registration, sidecar, signal: quitting.signal });
```

A sidecar that another process of your app already runs in the same `baseDir` is attached to, not
started, and is left running when this process closes. `nodePath` defaults to your own binary run
as Node (`ELECTRON_RUN_AS_NODE=1` under Electron).
