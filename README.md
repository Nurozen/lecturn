# Lecturn

Lecturn is Cloud Gatherer Labs' fork of [T3 Code](https://github.com/pingdotgg/t3code), a control surface for coding agents running on your computer. It brings desktop, web, and mobile clients together through Lecturn Connect, with a midnight navy, parchment, and brass visual theme inspired by [Stave](https://github.com/Nurozen/stave/tree/weirwood).

Use the coding-agent subscriptions and credentials you already have: Claude Code, Codex, Cursor, Grok Build, or OpenCode. Install and authenticate at least one provider on the computer that hosts your work.

## Installation and access

- **Desktop:** use a Lecturn installer from [this fork's releases](https://github.com/Nurozen/lecturn/releases). Follow [Install Lecturn alongside T3 Code](./docs/user/lecturn-installation.md) for application identity, data isolation, and first connection instructions.
- **Web:** [lecturn.cloudgatherer.net](https://lecturn.cloudgatherer.net). Sign in and connect to a computer hosting Lecturn.
- **iPhone and iPad:** Available to invited internal testers through TestFlight. There is no public Lecturn App Store release yet.
- **Android:** source is included in [`apps/mobile`](./apps/mobile); distribution is currently source-only.

The desktop app must remain running to host remote access. Lecturn uses its own app identity and `~/.lecturn/userdata`, so it can coexist with T3 Code. It does not automatically migrate your existing T3 Code data.

A standalone Lecturn npm runtime has not been published. Use the desktop host or build from source; upstream `npx t3`, Homebrew, winget, and AUR packages install T3 Code rather than this fork.

## Development

Install [Vite+](https://viteplus.dev/guide/), then install dependencies and start the local development environment:

```bash
vp i
vp run dev
```

Read [AGENTS.md](./AGENTS.md) and [CONTRIBUTING.md](./CONTRIBUTING.md) before making changes. Architecture and contributor documentation start at [docs/internals/overview.md](./docs/internals/overview.md).

## Documentation

- [Lecturn installation and data isolation](./docs/user/lecturn-installation.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access](./docs/user/remote-access.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple provider accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)

Some inherited documentation describes upstream T3 Code distribution and services. Use the Lecturn installation guide above for this fork's application and deployment details. Report Lecturn issues in [this repository](https://github.com/Nurozen/lecturn/issues).

## Attribution and license

Lecturn is based on T3 Code by T3 Tools and its contributors. Their work and copyright notices are preserved. The project is available under the [MIT license](./LICENSE).
