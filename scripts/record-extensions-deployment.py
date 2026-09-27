#!/usr/bin/env python3
"""Verify production deployment evidence and prepare/apply an audited compatibility record."""
import argparse
import json
import pathlib
import re
import subprocess

REPOSITORY = "Nurozen/lecturn"
WORKFLOW = ".github/workflows/deploy-relay.yml"
MIGRATION = "infra/relay/migrations/postgres/20260926000000_extensions_compatibility/migration.sql"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def validate_evidence(workflow, jobs, sha, run_id):
    if (workflow.get("id") != int(run_id) or workflow.get("head_sha") != sha
            or workflow.get("head_repository", {}).get("full_name") != REPOSITORY
            or workflow.get("path") != WORKFLOW or workflow.get("head_branch") != "main"
            or workflow.get("event") != "push" or workflow.get("conclusion") != "success"
            or workflow.get("status") != "completed"):
        raise ValueError("Expected a successful main-branch production relay deployment at the exact SHA")
    deployed = [job for job in jobs["jobs"] if job.get("name") == "Deploy production relay"]
    if len(deployed) != 1 or deployed[0].get("conclusion") != "success":
        raise ValueError("Production relay job did not succeed")
    steps = [step for step in deployed[0].get("steps", []) if step.get("name") == "Deploy production relay stage"]
    if len(steps) != 1 or steps[0].get("conclusion") != "success":
        raise ValueError("Production deployment step did not succeed")


def quote(value):
    return "'" + value.replace("'", "''") + "'"


def record_sql(run_id, sha, floor, operator, attempt):
    # The separate operator schema is deliberately outside the application migration schema.
    # Serialize writers on the migration singleton; derive the count from unique deployment evidence.
    url = f"https://github.com/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}"
    return f"""BEGIN;
SELECT id FROM relay_extensions_schema WHERE id=1 FOR UPDATE;
DO $$ BEGIN
 IF (SELECT phase FROM relay_extensions_schema WHERE id=1) IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'Compatibility records require an unpromoted schema';
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS lecturn_operations;
CREATE TABLE IF NOT EXISTS lecturn_operations.extensions_compatibility_deployments (
 workflow_run_id bigint PRIMARY KEY,
 source_commit text NOT NULL UNIQUE CHECK (source_commit ~ '^[0-9a-f]{{40}}$'),
 compatibility_floor text NOT NULL CHECK (compatibility_floor ~ '^[0-9a-f]{{40}}$'),
 workflow_attempt integer NOT NULL,
 evidence_url text NOT NULL,
 verified_by text NOT NULL,
 database_operator text NOT NULL DEFAULT current_user,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lecturn_operations.extensions_compatibility_deployments
 (workflow_run_id,source_commit,compatibility_floor,workflow_attempt,evidence_url,verified_by)
 VALUES ({run_id},{quote(sha)},{quote(floor)},{attempt},{quote(url)},{quote(operator)})
 ON CONFLICT (workflow_run_id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM lecturn_operations.extensions_compatibility_deployments
  WHERE workflow_run_id={run_id} AND source_commit={quote(sha)} AND compatibility_floor={quote(floor)}) THEN
  RAISE EXCEPTION 'Deployment identity was already recorded with different evidence';
 END IF;
END $$;
UPDATE relay_extensions_schema SET compatibility_deployments=
 (SELECT count(*) FROM lecturn_operations.extensions_compatibility_deployments) WHERE id=1;
SELECT workflow_run_id,source_commit,compatibility_floor,evidence_url,verified_by,recorded_at
 FROM lecturn_operations.extensions_compatibility_deployments ORDER BY recorded_at;
SELECT phase,compatibility_deployments,rollback_floor FROM relay_extensions_schema WHERE id=1;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--sha", required=True, help="Exact deployed source SHA")
    parser.add_argument("--compatibility-floor", required=True, help="Reviewed compatible rollback SHA, ancestor of deployed SHA")
    parser.add_argument("--apply", action="store_true", help="Apply through psql using existing PG* environment; default only prints SQL")
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9][0-9]*", args.run_id) or not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in [args.sha, args.compatibility_floor]):
        parser.error("An exact workflow run ID and full lowercase SHA values are required")
    # Use local fetched git objects; never infer that the latest local checkout was deployed.
    run(["git", "merge-base", "--is-ancestor", args.compatibility_floor, args.sha], cwd=ROOT)
    migration = run(["git", "show", f"{args.compatibility_floor}:{MIGRATION}"], cwd=ROOT)
    if "CREATE FUNCTION relay_extensions_reservation_fence()" not in migration or "compatibility_deployments" not in migration:
        raise ValueError("Reviewed rollback floor must include the compatibility migration")
    api = f"repos/{REPOSITORY}/actions/runs/{args.run_id}"
    workflow = json.loads(run(["gh", "api", api]))
    attempt = workflow.get("run_attempt")
    if type(attempt) is not int or attempt < 1:
        raise ValueError("Missing exact workflow attempt")
    jobs = json.loads(run(["gh", "api", f"{api}/attempts/{attempt}/jobs?per_page=100"]))
    validate_evidence(workflow, jobs, args.sha, args.run_id)
    operator = run(["gh", "api", "user", "--jq", ".login"])
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", operator):
        raise ValueError("Expected authenticated operator identity")
    sql = record_sql(args.run_id, args.sha, args.compatibility_floor, operator, attempt)
    if args.apply:
        # Credentials stay in the standard libpq environment; never command arguments or output.
        subprocess.run(["psql", "-X", "--set", "ON_ERROR_STOP=1"], input=sql, text=True, check=True)
    else:
        print(sql, end="")


if __name__ == "__main__":
    main()
