# Install Lecturn

Lecturn runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

Command-line use, SSH hosts, and WSL backends need Node.js 22.16+ (22.x), 23.11+
(23.x), or 24.10 and later. The native desktop app includes its server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch Lecturn and configure providers afterwards.

## Choose an installation

Start with the [Lecturn installation guide](./lecturn-installation.md) for desktop downloads,
mobile access, and runtime distribution. The standalone CLI command is `lecturn`.

## Desktop app

Download a Lecturn installer from [GitHub Releases](https://github.com/Nurozen/lecturn/releases).

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. Lecturn installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

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

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider       | Install and authenticate                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Codex          | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.            |
| Claude         | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.     |
| Cursor         | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                            |
| Grok Build     | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                               |
| GitHub Copilot | Install [GitHub Copilot CLI](https://github.com/features/copilot/cli), then run `copilot login`. |
| OpenCode       | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                         |
| Antigravity    | Install and sign in with Google from Lecturn's provider settings.                                |

Provider CLIs must be on the server's `PATH`. If Lecturn cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

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
