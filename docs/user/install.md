# Install Lecturn

Lecturn runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

`npx lecturn` needs Node.js 22.16+ (22.x), 23.11+ (23.x), or 24.10 and later.
The native desktop app and its WSL backends include their own server runtime. SSH
hosts on Apple Silicon macOS or Linux x64 need no Node.js; other SSH hosts need a
compatible Node.js and npm.

You need an installed, authenticated provider before starting a thread. You can
launch Lecturn and configure providers afterwards.

## Choose an installation

Start with the [Lecturn installation guide](./lecturn-installation.md) for desktop downloads,
mobile access, and runtime distribution.

## Command line

The standalone CLI command is `lecturn`. To run it without installing (needs
Node.js, see [Requirements](#requirements)):

```bash
npx lecturn@latest
```

To install the self-contained CLI without Node.js, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Nurozen/lecturn/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Nurozen/lecturn/main/scripts/install.ps1 | iex
```

The script downloads the executable from a Lecturn release and is unavailable
until Lecturn publishes standalone CLI release archives. It puts `lecturn` in
`~/.local/bin`. If your shell reports `command not found` afterwards, that
directory is not on your `PATH` yet; the installer prints the line to add. Set
`LECTURN_CHANNEL=nightly` to install the nightly train, or `LECTURN_VERSION` to
pin an exact version. The executable is built for Apple Silicon Macs, Linux x64,
and Windows x64; on other platforms the script tells you to use `npx lecturn`
instead.

| Task                                             | Command                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Start the server and open the web app            | `lecturn`                                                      |
| Start the server without a browser               | `lecturn serve`                                                |
| Keep it running in the background (macOS, Linux) | `lecturn service install` ([details](./background-service.md)) |
| Move to the newest release                       | `lecturn update`                                               |
| Remove it again                                  | `lecturn uninstall`                                            |

With `npx`, run the same commands as `npx lecturn@latest <command>`. Service
installation and `lecturn update` stay unavailable until a Lecturn runtime is
published; see [Running in the background](./background-service.md). Run
`lecturn --help` for the full reference.

### Intel Macs

There is no `lecturn` executable for Intel Macs (the desktop app is available)
because Node cannot produce a single executable there. Use `npx lecturn`, or
build a server from source with Node.js 24 and `vp` (see
[Vite+](https://viteplus.dev/guide/)):

```bash
git clone https://github.com/Nurozen/lecturn
cd lecturn && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`lecturn update` and the background service do not apply to a server run this
way; update it with `git pull` and a rebuild.

## Desktop app

Download a Lecturn installer from [GitHub Releases](https://github.com/Nurozen/lecturn/releases).

On Debian or Ubuntu, install the `.deb` with `sudo apt install ./Lecturn-*.deb`. The `.deb`
updates itself like the other desktop builds. It asks for your password to install each update. If
your desktop has no password prompt, the update fails. Download the new `.deb` and install it the
same way.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. Lecturn installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
lecturn app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `lecturn app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

The phone connects to a server on another machine. See the
[Lecturn installation guide](./lecturn-installation.md#iphone-and-ipad) for how to get the mobile app, then follow
[remote access](./remote-access.md) to link it through Lecturn Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider       | Install and authenticate                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude         | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor         | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build     | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| GitHub Copilot | Install [GitHub Copilot CLI](https://github.com/features/copilot/cli), then run `copilot login`.                                                          |
| OpenCode       | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity    | Install and sign in with Google from Lecturn's provider settings.                                                                                         |

Provider CLIs must be on the server's `PATH`. If Lecturn cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

On macOS, Lecturn opens while it loads your shell environment and detects providers in the
background. Progress appears in the bottom-right corner; settings and navigation remain usable.
Shell loading and provider detection each allow up to 15 seconds. If detection times out, the
indicator turns grey with a retry button and a link to that provider's settings. Lecturn also
retries on its own, waiting a little longer each time (up to a minute), so detection recovers
once a busy machine frees up. A provider that was already detected stays usable through one
slow background check. You can retry without restarting, or configure an explicit
executable path to bypass shell discovery. New turns wait for their provider to be ready;
existing running turns continue. Brief connection interruptions do not restart provider
detection. The progress indicator is hidden while an environment is disconnected and resumes
from its current status after reconnecting.

If a provider cannot start, use the recovery panel to retry or open settings. **Show details**
keeps the technical error available for troubleshooting.

GitHub Copilot needs a Copilot subscription. See [GitHub Copilot](./providers-copilot.md) for
install options, token sign-in, and organization policy.

Lecturn warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Lecturn can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Lecturn does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[GitHub Copilot](./providers-copilot.md), and [Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Lecturn](./updating.md): update the app and connected servers.
