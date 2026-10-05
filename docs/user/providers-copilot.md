# GitHub Copilot

Lecturn runs the GitHub Copilot CLI on the connected environment. With a remote environment, the
CLI installation and GitHub sign-in on that environment apply, not the setup on your desktop or
phone.

Copilot requires a GitHub Copilot subscription. If your seat comes from an organization or
enterprise, an admin must enable the Copilot CLI policy for that organization first.

## Install the CLI

Install the Copilot CLI on the machine running the Lecturn server with any of these:

| Method   | Command                                            |
| -------- | -------------------------------------------------- |
| Homebrew | `brew install --cask copilot-cli`                  |
| npm      | `npm install -g @github/copilot`                   |
| WinGet   | `winget install GitHub.Copilot`                    |
| Script   | `curl -fsSL https://gh.io/copilot-install \| bash` |

Lecturn looks for the `copilot` binary on the server's `PATH`. If it lives somewhere else, set
**Binary path** in the Copilot provider settings.

## Sign in

Run `copilot login` on the machine running the Lecturn server and follow the prompts. Lecturn uses
the account the CLI last signed in with.

To use a token instead, set `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` in the
environment that starts Lecturn. Lecturn passes them through, and the Copilot CLI reads them
itself. Use a fine-grained personal access token with the **Copilot Requests** permission.

## Enable Copilot

Copilot is off by default. Open **Settings** > **Providers**, select the environment, and turn on
**GitHub Copilot**. After Lecturn detects the CLI and your sign-in, Copilot appears in the model
picker.

Use **Add provider** to create another Copilot instance, for example one with a different
**Binary path**.

## Models

The model picker lists **Auto** plus the models built into your installed Copilot CLI version.
**Auto** lets Copilot pick the model automatically and is the default. The list is not filtered
for your account or plan, so a model can appear that your plan or your organization's model
policy does not allow; Copilot rejects it when the turn starts. Updating the CLI refreshes the
list. You can add a model ID the list does not show under the provider's custom models.

You can switch models in a running thread. Reasoning effort is not adjustable for Copilot.

## Permission modes

| Lecturn mode          | Copilot behavior                                          |
| --------------------- | --------------------------------------------------------- |
| **Supervised**        | Asks for approval before commands, edits, and other tools |
| **Auto**              | Same as **Supervised**. Copilot has no AI reviewer.       |
| **Auto-accept edits** | File edits proceed. Other actions ask for approval.       |
| **Full access**       | All actions proceed without approval.                     |

Copilot supports Lecturn's **Plan** mode control. In Plan mode, Copilot writes a plan before it
changes anything, and Lecturn shows that plan as the proposed plan. If Copilot answers without
writing a plan, its reply is shown instead. See [Permission modes](./permission-modes.md) for how
approvals appear.

Copilot cannot ask you questions mid-turn in Lecturn. It proceeds on its own judgment instead.

## Updates

Use the provider's update action in Lecturn to update the Copilot CLI. Lecturn updates npm
installations through npm. Homebrew, WinGet, and script installations are updated with
`copilot update`. Running sessions keep their current CLI. New sessions use the updated one.

## Limits

- Threads cannot be forked. See [Forking threads](./forking-threads.md).
- Existing Copilot CLI sessions cannot be imported. See
  [Importing sessions](./importing-sessions.md).
- Reasoning effort cannot be adjusted.
- Copilot keeps its own session history in `~/.copilot` on the environment. Lecturn generates
  thread titles and commit messages with `gpt-5-mini`, and each of those calls leaves a short
  session in Copilot's history (for example in the `copilot --resume` list). Copilot has no way to
  delete sessions.
