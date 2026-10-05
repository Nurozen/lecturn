# Extensions release and migration

This runbook describes release gates, not evidence that a deployment has happened.

1. Merge the core release workflow's draft-then-publish support before enabling immutable releases in the core repository; otherwise scheduled or manual desktop releases can fail while attaching assets. Generate the public contract catalog from the exact reviewed source, verify deterministic output, and publish its immutable manifest and artifacts. Pin its URL and manifest SHA-256 in the private evaluator's verification configuration. Keep schemas generated from the core; do not hand-maintain a parallel OpenAPI repository.
2. Verify the private evaluator and native helper with synthetic fixtures. Qualify real supported Slack cache versions and both macOS architectures independently. The local arm64 synthetic test is not x64 or live-cache qualification.
3. Run private helper release packaging in the protected release environment. Retain dSYMs privately. Publish only the signed stripped binaries, per-architecture manifests, LICENSE and dependency notices. Never publish private source, Cargo target directories, symbols, fixtures or evaluator source in the public app artifact.
4. Pin `EXTENSIONS_HELPER_COMMIT`, `EXTENSIONS_HELPER_ARCHIVE_SHA256` and `EXTENSIONS_HELPER_TEAM_ID` in the core release configuration, plus the read-only `EXTENSIONS_ARTIFACT_READ_TOKEN`. The release must contain `helper.zip` under `extensions-helper-<commit>-<archive-sha256>` in the private extensions repository. Official `Nurozen/lecturn` macOS releases always require the helper; missing pins or credentials fail the build. Fork/community builds do not need these credentials. The extractor verifies archive digest, source commit, signer team, protocol and binary digest and rejects unexpected files.
5. Deploy and qualify the private evaluator before the core compatibility relay deployment. That deployment retires direct Decisions evaluation, so existing Decisions service requires a working private evaluator with Decisions admission enabled and the relay service binding configured. Keep Contextual admission off. Verify deployed Worker settings and the binding, not just GitHub variables: changing a variable does not change a running Worker. The private deployment workflow defaults to `admission=disabled`; deploy the reviewed `admission=decisions` mode before the core compatibility relay deployment, and verify the deployed settings. The `admission=all` mode additionally requires its evaluation qualification gate. A default disabled deployment is not ready to preserve Decisions service. If Decisions qualification or activation is blocked, hold the core compatibility deployment unless an explicit Decisions outage has been accepted. Existing Decisions attempts retain their original backend; settled legacy results can replay, but unfinished legacy attempts cannot dispatch through the private evaluator.
6. Deploy the relay compatibility migration with Contextual off and verify Decisions continuity, consent, idempotency, unknown-result recovery, cleanup watermarks and shared-pool accounting. Record two distinct compatible deployed commits using the audited procedure below, retire incompatible reservation writers, and record a compatible rollback floor before calling the explicit promotion function. See the migration's `relay_extensions_promote` contract. Never roll back below that floor after promotion. Keep Contextual admission off until promotion and the evaluation qualification checks pass.
7. Qualify paid evaluation policies against a labeled relevance, contradiction and equivalence corpus. Report false-positive merges and unsupported-source cases. Semantic auto-consolidation remains disabled without this gate.
8. Sign and notarize the complete desktop app through the existing release process, verify helper launch on each supported architecture, and stage a limited cohort. Verify web, desktop, mobile and remote-host scopes before widening admission.

Canonical configuration names use `EXTENSIONS_*`. Compatibility aliases for the former `DECISIONS_*` variables are normalized by the relay; contradictory aliases fail configuration rather than silently changing an allowance. Preserve old values during the compatibility deployment. Do not reset existing account usage or give each feature a separate monthly pool.

Contextual status reports unavailable until the database promotion marker is present at phase 1. The relay refuses new Contextual funding challenges, approvals, redemptions and evaluation admission before creating funding or usage records when that marker is missing or still at phase 0, even if its admission flag is enabled. Decisions remains available during both compatibility phases. This readiness check does not promote the schema or replace the deployment, qualification and worker-retirement gates.

Funding cancellation, revocation, host unlinking and account deletion remain available when new paid admission is disabled. Monitor unresolved reservations, cleanup watermarks, grant generations, rejected old reservation epochs, helper capability failures and packet omission counts without logging source excerpts. Unresolved financial evidence can intentionally prevent cleanup watermark advancement; investigate rather than deleting it.

A local PR Review uses a fresh synthetic home, local simulated evaluation and an ad-hoc signed app. It proves local wiring only. It does not prove production billing, signed-helper distribution, notarization, real Slack format coverage or paid model quality.

## Immutable helper publication

Restrict the private `extensions-release` and `extensions-evaluator-production` environments to the default branch. Required reviewers are currently waived for these private environments by maintainer instruction; the public `extension-contract-publication` environment still requires its reviewer gate. Enable GitHub immutable releases in the private repository and provide its environment secret `EXTENSIONS_RELEASE_PUBLICATION_TOKEN` with repository contents write and administration read permissions. The workflow checks repository privacy and release immutability before publishing. It creates the release as a draft, attaches only `helper.zip`, then publishes and verifies immutability. The tag includes the exact source commit and archive digest; publication never overwrites a release. Keep private dSYMs separately; their Actions retention is for diagnostics and is not the release delivery channel.

Copy the resulting commit and archive digest from the protected workflow summary into the core variables above and set the verified signer team. The core workflow resolves exactly that immutable private release and asset; it also checks the release source commit before extracting. There is no expiring Actions artifact ID in the app release path. This procedure requires running the protected workflows; local tests do not constitute publication or signing qualification.

## Record compatibility deployments before promotion

Keep Contextual admission off. Review a rollback-floor commit that includes the compatibility migration and compatible application readers/writers. Fetch the reviewed source commits locally. After each successful **production relay deployment of a distinct commit**, run:

```sh
python3 scripts/record-extensions-deployment.py \
  --run-id <production-workflow-run-id> \
  --sha <exact-deployed-40-character-sha> \
  --compatibility-floor <reviewed-compatible-40-character-sha> > /tmp/extensions-deployment.sql
```

The script checks the successful `main` push run in `Nurozen/lecturn`, its exact source SHA, the completed production deployment job and deployment step, and floor ancestry plus compatibility-migration presence. It records the authenticated GitHub operator and exact workflow attempt URL. It cannot establish runtime health or prove that incompatible workers have retired; those remain separate operator checks. Review the SQL before applying it with the standard `PGHOST`, `PGDATABASE`, `PGUSER` and credential environment pointing at the intended relay database:

```sh
python3 scripts/record-extensions-deployment.py \
  --run-id <same-run-id> --sha <same-deployed-sha> \
  --compatibility-floor <same-reviewed-floor> --apply
```

`--apply` re-verifies the GitHub evidence and executes a transaction through `psql -X` with `ON_ERROR_STOP`. It creates an operator audit ledger in the separate `lecturn_operations` schema, locks the migration singleton, records the database operator, and derives `compatibility_deployments` from the ledger. Repeating the same run is idempotent; conflicting run identities fail, and reruns or multiple runs for the same source commit cannot inflate the counter. Do not manually update the counter. Records are accepted only before promotion.

Inspect both ledger entries, verify that each has the reviewed compatibility floor, confirm settlement/reconciliation health and retire all incompatible reservation writers. Then execute the existing explicit promotion operation with that exact floor:

```sql
SELECT * FROM lecturn_operations.extensions_compatibility_deployments ORDER BY recorded_at;
SELECT phase, compatibility_deployments, rollback_floor FROM relay_extensions_schema WHERE id=1;
-- Only after the separate worker-retirement verification:
SELECT relay_extensions_promote(true, '<reviewed-compatible-40-character-sha>');
```

Recording deployment evidence does not invoke promotion, enable admissions, change billing allowances or retire workers. Never roll back below the recorded compatible floor after promotion.
