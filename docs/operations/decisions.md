# Decisions operations

Decisions ships disabled by default. The desktop host stores notes, evidence, traversal checkpoints, and jobs in SQLite; the relay stores funding, authoritative paid-access facts, and the usage ledger in PostgreSQL. The private evaluation service receives only the bounded evaluation request. The user's connected provider writes notes locally; the relay never supplies a substitute writer.

## Deployment configuration

Configure `EXTENSIONS_EVALUATOR_WORKER` to bind the private evaluation service. There is no public vendor transport fallback. Upstream credentials, model policy and qualification probes are configured and maintained only in the private implementation. Missing service bindings prevent evaluation; they do not authorize another backend.

This intentionally replaces the former direct evaluation backend. Roll out matching public contracts and private service versions with new admission disabled, then verify the service binding before enabling a cohort. Settled retired requests may replay their retained judgments without charging again; unresolved retired attempts remain fenced and are never redirected to a different backend. Preserve their accounting records and cleanup jobs. New public results expose an opaque evaluation identity; upstream model details remain private.

The deployment applies migrations `20260923000000_personal_paid_facts`, `20260923000100_decision_funding`, `20260923000200_decision_usage`, and `20260923000300_decision_payer_label`. Apply them before admitting traffic. Keep the once-per-minute reconciliation cron active even while admission is disabled: unknown attempts and reservations still need cleanup.

Use GitHub production environment **variables** for the following settings. Empty variables use the defaults below. Invalid settings disable Decisions without disabling other relay routes.

| Variable                              | Default      | Purpose                                                                           |
| ------------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `DECISIONS_ENABLED`                   | `false`      | Admission kill switch                                                             |
| `DECISIONS_COHORT`                    | empty        | Comma-separated eligible account IDs; `*` permits all otherwise eligible accounts |
| `DECISIONS_MONTHLY_INPUT_TOKENS`      | `10000000`   | Actual input-token allowance per monthly anniversary window                       |
| `DECISIONS_ATTEMPT_HOLD_NANO_USD`     | `10000000`   | One-cent reservation per attempt                                                  |
| `DECISIONS_RUN_BUDGET_NANO_USD`       | `30000000`   | Three-cent durable run ceiling                                                    |
| `DECISIONS_MAX_ATTEMPTS_PER_RUN`      | `24`         | Bounds traversal and retry fanout                                                 |
| `DECISIONS_MAX_ATTEMPTS_PER_REQUEST`  | `2`          | Initial attempt plus one explicit retry                                           |
| `DECISIONS_ACCOUNT_CONCURRENCY`       | `2`          | Concurrent attempts per payer                                                     |
| `DECISIONS_ENVIRONMENT_CONCURRENCY`   | `1`          | Concurrent attempts per environment                                               |
| `DECISIONS_REQUESTS_PER_MINUTE`       | `60`         | Per-account admission rate                                                        |
| `DECISIONS_ACCOUNT_EXPOSURE_NANO_USD` | `100000000`  | Ten-cent outstanding operator exposure per payer                                  |
| `DECISIONS_GLOBAL_EXPOSURE_NANO_USD`  | `1000000000` | One-dollar outstanding global operator exposure                                   |
| `DECISIONS_UNKNOWN_HOLD_SECONDS`      | `120`        | User reservation deadline after an uncertain outcome                              |
| `DECISIONS_RESULT_RETENTION_SECONDS`  | `86400`      | Cached result lifetime; request identities remain tombstoned                      |
| `DECISIONS_REQUEST_TIMEOUT_MS`        | `30000`      | Upstream request deadline                                                         |
| `DECISIONS_BILLING_MAX_AGE_SECONDS`   | `86400`      | Maximum authoritative paid-fact age                                               |

Only actual reported input usage is settled against the shared allowance. An attempt hold is headroom, not a charge. Unknown upstream outcomes release the user's reservation after the deadline while retaining bounded operator exposure. Late results do not create a second user debit. No automatic overage charging exists.

## Access and rollout

A personal settled paid subscription, or a distinct explicit Decisions grant, supplies eligibility. Connect trials, team membership, grace periods, and generic Connect bypasses do not. Annual purchases receive monthly allowance windows anchored to the subscription anniversary. Funding approval binds an authenticated payer to the environment credential and generation; unlink, key rotation, payer revocation, and account deletion invalidate that binding.

Before enabling a cohort, verify migrated schema, the private service binding, fresh paid-fact reconciliation, the cleanup cron, a supported exact writer configuration, and an end-to-end synthetic evaluation including replay and revocation. Start with an explicit cohort. Small synthetic quality tests are regression evidence, not production accuracy measurements. Review unreviewed-note quality, coverage, failures, and spend before expanding access.

Disable `DECISIONS_ENABLED` to stop new admissions. Keep database reconciliation running. Saved local notes remain readable/exportable. Do not manually delete pending ledger rows to free allowance: doing so would lose unknown spend exposure and replay protection.

## Verification

Public tests exercise the fixed service boundary with synthetic responses and verify allowance accounting, replay protection, funding, source evidence and writer fencing. Upstream transport and model-quality probes live in the private implementation. Never point billing integration tests at production databases.

## Operational visibility

Evaluation metrics use only bounded outcomes: `lecturn_decisions_evaluations_total`, `lecturn_decisions_evaluation_duration`, `lecturn_decisions_attempts_total`, and `lecturn_decisions_input_tokens_total`. They contain no text, credentials, account IDs or environment IDs. The maintenance cron emits numeric `Decisions operational health` records even while new admission is disabled: outstanding nano-USD exposure, unresolved unknown attempts, overdue attempts, and the accounting anomaly stop. An anomaly, overdue attempt, or global exposure ceiling emits `Decisions operational alert`.

Route that alert through the existing relay observability sink to the service on-call owner before enabling production. Verify delivery with an isolated synthetic anomaly; local tests cannot verify the production alert destination. Investigate upstream availability and ledger reconciliation first. Preserve request identities and unknown-exposure records; never reset accounting controls merely to resume admissions. Correct the cause, reconcile actual upstream usage, and review the affected account before clearing an anomaly through an audited maintenance change.
