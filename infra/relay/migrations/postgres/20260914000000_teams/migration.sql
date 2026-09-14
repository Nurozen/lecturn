CREATE TABLE relay_team_accounts (
 organization_id text PRIMARY KEY, owner_user_id text NOT NULL,
 customer_id text UNIQUE, subscription_id text UNIQUE,
 purchased_seats integer NOT NULL DEFAULT 0 CHECK (purchased_seats >= 0),
 access_until bigint, access_window_start bigint, interval text CHECK(interval IN ('month','year')),
 current_period_end bigint, pending_seats integer CHECK(pending_seats >= 0),
 policy jsonb NOT NULL DEFAULT '{"allowedProviders":null,"publishAgentActivity":true}',
 generation integer NOT NULL DEFAULT 0,
 billing_state jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'free', suspended boolean NOT NULL DEFAULT false, reconcile_after bigint NOT NULL DEFAULT 0,
 billing_lease_owner text, billing_lease_expires_at bigint NOT NULL DEFAULT 0,
 created_at bigint NOT NULL, updated_at bigint NOT NULL
);
CREATE TABLE relay_team_seats (
 organization_id text NOT NULL REFERENCES relay_team_accounts(organization_id),
 user_id text NOT NULL, assigned_at bigint NOT NULL,
 PRIMARY KEY(organization_id,user_id)
);
CREATE TABLE relay_team_environment_funding (
 user_id text NOT NULL, environment_id text NOT NULL,
 organization_id text NOT NULL REFERENCES relay_team_accounts(organization_id),
 created_at bigint NOT NULL,
 PRIMARY KEY(user_id,environment_id)
);
CREATE INDEX relay_team_funding_org ON relay_team_environment_funding(organization_id,user_id);
CREATE TABLE relay_team_audit (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES relay_team_accounts(organization_id),
 actor_user_id text NOT NULL, action text NOT NULL, subject_id text,
 created_at bigint NOT NULL
);
CREATE INDEX relay_team_audit_org ON relay_team_audit(organization_id,created_at);

ALTER TABLE relay_managed_reservations ADD COLUMN funding_organization_id text;

CREATE TABLE relay_team_deleted_users (
 user_id text PRIMARY KEY,
 deleted_at bigint NOT NULL
);
