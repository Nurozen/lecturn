# Architecture decision records

> For maintainers and contributors. Using Lecturn? See [docs/user](../user/).

An ADR records one decision that shapes the codebase, the options that were on the table, and why the chosen one won. ADRs are public and committed. They are for decisions a future contributor would otherwise have to reverse-engineer or relitigate.

Most rationale still belongs beside the architecture it explains, in `docs/internals/`. Write an ADR when the decision breaks an existing convention, closes off an alternative someone will propose again, or spans more than one internal document.

## Rules

- One decision per file, named `NNNN-short-title.md`, numbered in merge order.
- Keep it under a page. Link to the internal doc for how the thing works today.
- An ADR is not a plan. It carries no task lists and no acceptance criteria. Those stay in the tracking issue, and session working docs stay in the gitignored `artifacts/` folder.
- Do not edit an accepted ADR to change its decision. Add a new ADR and mark the old one `Superseded by NNNN`.

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

What forced a decision. Constraints and the convention in play, with file references.

## Decision

What we do, in present tense.

## Alternatives

Each option considered and the reason it lost.

## Consequences

What this makes easier, what it makes harder, and what it commits us to.
```

## Index

- [0001. Thread notes use a typed side table](./0001-thread-notes-typed-side-table.md)
