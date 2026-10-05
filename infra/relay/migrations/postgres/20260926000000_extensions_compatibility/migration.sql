-- Compatibility deployment: old readers remain valid while Contextual is fenced off.
ALTER TABLE relay_decision_funding ADD COLUMN feature_id text NOT NULL DEFAULT 'decisions' CHECK (feature_id IN ('decisions','contextual'));
ALTER TABLE relay_decision_funding_challenges ADD COLUMN feature_id text NOT NULL DEFAULT 'decisions' CHECK (feature_id IN ('decisions','contextual'));
ALTER TABLE relay_decision_funding_challenges ADD COLUMN canceled boolean NOT NULL DEFAULT false;
ALTER TABLE relay_decision_usage_requests ADD COLUMN feature_id text NOT NULL DEFAULT 'decisions' CHECK (feature_id IN ('decisions','contextual'));
ALTER TABLE relay_decision_usage_requests ADD COLUMN backend text NOT NULL DEFAULT 'legacy';
ALTER TABLE relay_decision_usage_requests ADD COLUMN legacy_fingerprint text;
ALTER TABLE relay_decision_usage_runs ADD COLUMN feature_id text NOT NULL DEFAULT 'decisions' CHECK (feature_id IN ('decisions','contextual'));
ALTER TABLE relay_decision_usage_attempts ADD COLUMN next_check_at bigint NOT NULL DEFAULT 0;
ALTER TABLE relay_decision_usage_attempts ADD COLUMN feature_id text NOT NULL DEFAULT 'decisions' CHECK (feature_id IN ('decisions','contextual'));
ALTER TABLE relay_decision_usage_attempts ADD COLUMN backend text NOT NULL DEFAULT 'legacy';
ALTER TABLE relay_decision_usage_attempts ADD COLUMN policy_version text NOT NULL DEFAULT 'decisions-v1';
ALTER TABLE relay_decision_usage_attempts ADD COLUMN request_fingerprint text NOT NULL DEFAULT '';
ALTER TABLE relay_decision_usage_windows ADD COLUMN limit_input_tokens bigint;
ALTER TABLE relay_decision_usage_windows ADD COLUMN pool_basis text CHECK (pool_basis IN ('subscription','grant'));
CREATE TABLE relay_extensions_schema (
 id integer PRIMARY KEY CHECK (id=1),
 phase integer NOT NULL DEFAULT 0 CHECK (phase IN (0,1)),
 minimum_reservation_epoch integer NOT NULL DEFAULT 0,
 compatibility_deployments integer NOT NULL DEFAULT 0,
 rollback_floor text
);
INSERT INTO relay_extensions_schema(id) VALUES(1);
CREATE TABLE relay_extension_admission_grants (
 id text PRIMARY KEY,
 user_id text NOT NULL CONSTRAINT "relay_extension_admission_grants_S5rRjuBV2qge_fkey" REFERENCES relay_billing_accounts(user_id),
 feature_id text NOT NULL CHECK (feature_id IN ('decisions','contextual')),
 starts_at bigint NOT NULL,
 ends_at bigint NOT NULL CONSTRAINT relay_extension_admission_grants_check CHECK(ends_at > starts_at),
 revoked_at bigint,
 operator text NOT NULL,
 reason text NOT NULL
);
CREATE TABLE relay_extensions_evaluator_cleanup (
 environment_id text PRIMARY KEY,
 minimum_admissibility_epoch bigint NOT NULL DEFAULT 0,
 next_check_at bigint NOT NULL DEFAULT 0
);
CREATE INDEX relay_extension_attempt_recovery ON relay_decision_usage_attempts(feature_id,backend,next_check_at,id) WHERE cost_nano IS NULL AND status IN ('dispatched','unknown','expired');
CREATE INDEX relay_extension_attempt_unresolved ON relay_decision_usage_attempts(environment_id,created_at) WHERE backend='private-evaluator' AND cost_nano IS NULL;
UPDATE relay_decision_usage_requests SET legacy_fingerprint=fingerprint WHERE backend='legacy';
UPDATE relay_decision_usage_attempts a SET request_fingerprint=r.fingerprint,policy_version=r.template_version FROM relay_decision_usage_requests r WHERE a.payer_id=r.payer_id AND a.request_id=r.request_id AND a.feature_id=r.feature_id;
-- This trigger also protects against a pre-compatibility process which survived deployment.
-- Settlement and reconciliation never insert attempts, so can still drain legacy work.
CREATE FUNCTION relay_extensions_reservation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_epoch integer; current_phase integer;
BEGIN
 SELECT minimum_reservation_epoch,phase INTO required_epoch,current_phase FROM relay_extensions_schema WHERE id=1 FOR SHARE;
 IF COALESCE(NULLIF(current_setting('lecturn.extensions_reservation_epoch',true),''),'0')::integer < required_epoch THEN
  RAISE EXCEPTION 'Extensions reservation epoch is obsolete' USING ERRCODE='55000';
 END IF;
 IF NEW.feature_id <> 'decisions' AND current_phase < 1 THEN
  RAISE EXCEPTION 'Extensions feature keys have not been promoted' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER relay_extensions_attempt_fence BEFORE INSERT ON relay_decision_usage_attempts FOR EACH ROW EXECUTE FUNCTION relay_extensions_reservation_fence();
CREATE TRIGGER relay_extensions_funding_fence BEFORE INSERT ON relay_decision_funding FOR EACH ROW EXECUTE FUNCTION relay_extensions_reservation_fence();
-- Promotion is a separate operator action after two compatibility deployments and worker retirement.
-- Do not invoke this automatically from the migration runner or application startup.
CREATE FUNCTION relay_extensions_promote(retired_incompatible_workers boolean, compatibility_floor text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE deployments integer;
BEGIN
 SELECT compatibility_deployments INTO deployments FROM relay_extensions_schema WHERE id=1 FOR UPDATE;
 IF (SELECT phase FROM relay_extensions_schema WHERE id=1)=1 THEN RETURN; END IF;
 IF retired_incompatible_workers IS DISTINCT FROM true OR deployments < 2 OR compatibility_floor !~ '^[0-9a-f]{40}$' THEN
  RAISE EXCEPTION 'Two compatibility deployments, retired workers and an exact rollback floor are required';
 END IF;
 UPDATE relay_extensions_schema SET minimum_reservation_epoch=1 WHERE id=1;
 ALTER TABLE relay_decision_funding_challenges DROP CONSTRAINT "relay_decision_funding_challenges_UleoiTCGNkIG_fkey";
 ALTER TABLE relay_decision_funding DROP CONSTRAINT relay_decision_funding_pkey;
 ALTER TABLE relay_decision_funding ADD PRIMARY KEY(environment_id,feature_id);
 ALTER TABLE relay_decision_funding_challenges ADD FOREIGN KEY(environment_id,feature_id) REFERENCES relay_decision_funding(environment_id,feature_id);
 ALTER TABLE relay_decision_usage_requests DROP CONSTRAINT relay_decision_usage_requests_pkey;
 ALTER TABLE relay_decision_usage_requests ADD PRIMARY KEY(payer_id,feature_id,request_id);
 ALTER TABLE relay_decision_usage_runs DROP CONSTRAINT relay_decision_usage_runs_pkey;
 ALTER TABLE relay_decision_usage_runs ADD PRIMARY KEY(payer_id,feature_id,run_id);
 UPDATE relay_extensions_schema SET phase=1,rollback_floor=compatibility_floor WHERE id=1;
END $$;
