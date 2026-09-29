# Provider updates with Factory

Factory delegates a provider integration update to a coding agent, from official release notes through implementation, checks, review, and a pull request.

Open **Factory** from the sidebar or search for **Factory** in the command palette on web or desktop.

## Start a run

Choose a Git project and the upstream provider to research: Claude Code, Codex, or OpenCode. Separately choose the installed agent and model that will do the work. They do not need to be the same provider.

Choose the base branch and add any direction, such as “Preserve compatibility with the existing CLI version.” Launching starts a real agent in a new worktree. The agent is instructed to research official sources, choose one relevant update, plan and implement it, run checks, obtain independent review, and publish a PR. It may find that no change is needed or ask for a decision. Factory never requests automatic merge or deployment.

The launch screen shows the access mode. Autonomous execution can edit the worktree and use the agent's configured tools to commit, push, and open a PR. Provider permissions and repository instructions still apply. The host needs its normal provider and source-control authentication.

Factory launches use standalone Git projects outside Stave spaces. A repository nested inside a space is also managed by Stave, even if added as a separate project. Add a standalone checkout outside the space for Factory; an unsupported location is rejected before the run starts.

## Follow and steer

The workflow rail describes the requested process. A highlighted phase is reported by the agent; it is not an independent verification result. Recent conversation evidence and the full conversation show what the agent actually did. A finished turn does not necessarily mean an update or PR was produced.

Send direction while a run is working, open its full conversation to answer approvals or questions, or interrupt the turn. A sent direction confirms submission, not that the agent has already applied it. A discovered PR links to the actual change; check its review and CI results before merging.

Run history uses the factory branch and the host's saved conversations. Reopen Factory to return to a run, or share its Factory page URL with another paired client. Keep the assigned factory branch name to retain its place in Factory history. The ordinary conversation remains available if the branch is renamed. Native mobile can open and steer the resulting conversation; the Factory launch screen is available on web and desktop.

## If a launch is interrupted

When a connection drops before the host confirms launch, Factory retains the run reference for inspection. It does not send the launch again, because the host may already have prepared the worktree or started the agent. Inspect the existing conversation and reconnect to the same environment before deciding to start another run.

If the launch cannot be resolved, **Keep reference & start over** retains its reference locally and returns to the launch form. It does not stop the original run. Check the original conversation before starting separate work.
