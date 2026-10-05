# Lecturn docs

## Using Lecturn

- [Install Lecturn](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Thread notes](./user/thread-notes.md)
- [Decisions](./user/decisions.md)
- [Forking threads](./user/forking-threads.md)
- [Importing sessions](./user/importing-sessions.md)
- [Import browser sessions](./user/browser-import.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Teams and company Connect](./user/teams.md)
- [Remote access](./user/remote-access.md)
- [Notifications and Live Activities](./user/notifications-and-live-activities.md)
- [Running in the background](./user/background-service.md)
- [Updating Lecturn](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [GitHub Copilot](./user/providers-copilot.md) · [Antigravity](./user/providers-antigravity.md)

---

## Working on Lecturn

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Thread notes](./internals/thread-notes.md)
- [Thread forking](./internals/thread-forking.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Stave integration](internals/stave-integration.md) — fork-only: how a project maps to a Stave space, the manifest reader, derived `project.stave`, admission rules.
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [Lecturn Connect](./internals/lecturn-connect.md)
- [Teams architecture](./internals/teams.md)
- [Architecture decision records](./adr/README.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Lecturn Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Teams operations](./operations/teams.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)

- [Decisions operations](./operations/decisions.md)

- [Thread Decisions architecture](internals/thread-decisions.md)
