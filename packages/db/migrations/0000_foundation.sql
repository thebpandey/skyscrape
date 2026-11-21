CREATE TABLE "user" (
 id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','analyst','viewer')),
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session (
 id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 token text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON session ("userId");
CREATE TABLE account (
 id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "accountId" text NOT NULL, "providerId" text NOT NULL, password text, password_revision integer NOT NULL DEFAULT 1,
 "accessToken" text,
 "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
 "refreshTokenExpiresAt" timestamptz, scope text, UNIQUE ("providerId","accountId"),
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE verification (
 id uuid PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON verification(identifier);
CREATE TABLE bootstrap_token (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), digest bytea NOT NULL CHECK(octet_length(digest)=32), expires_at timestamptz NOT NULL);
CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES "user", action text NOT NULL, subject_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES "user",
 prefix text UNIQUE NOT NULL, digest bytea UNIQUE NOT NULL CHECK(octet_length(digest)=32), scopes text[] NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, last_used timestamptz, daily_quota integer NOT NULL CHECK(daily_quota > 0),
 usage_date date, usage_count integer NOT NULL DEFAULT 0
);
CREATE TABLE settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, version integer NOT NULL, value jsonb NOT NULL);
CREATE TABLE settings_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), setting_id uuid NOT NULL REFERENCES settings, version integer NOT NULL, snapshot jsonb NOT NULL, actor_id uuid REFERENCES "user", created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(setting_id,version));
CREATE TABLE provider_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, encrypted_key bytea NOT NULL, key_version integer NOT NULL, free_quota integer NOT NULL CHECK(free_quota >= 0), resets_at timestamptz);
CREATE TABLE quota_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_account_id uuid NOT NULL REFERENCES provider_accounts, reserved integer NOT NULL CHECK(reserved >= 0), used integer NOT NULL DEFAULT 0 CHECK(used >= 0 AND used <= reserved));
CREATE TABLE campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES "user", version integer NOT NULL CHECK(version>0),
 title text NOT NULL, objective text NOT NULL, state text NOT NULL, geo_filter jsonb NOT NULL,
 criteria jsonb NOT NULL, requested_fields text[] NOT NULL, source_policy jsonb NOT NULL, budget_config jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_versions (
 campaign_id uuid NOT NULL REFERENCES campaigns, version integer NOT NULL, config_snapshot jsonb NOT NULL,
 schema_version integer NOT NULL, created_by uuid NOT NULL REFERENCES "user", created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(campaign_id,version)
);
CREATE TABLE runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL, version integer NOT NULL,
 trigger text NOT NULL, state text NOT NULL, parent_id uuid REFERENCES runs, config_snapshot jsonb NOT NULL,
 counters jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 FOREIGN KEY(campaign_id,version) REFERENCES campaign_versions
);
CREATE INDEX ON runs(campaign_id,state,created_at);
CREATE TABLE schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES campaigns, mode text NOT NULL,
 zone text NOT NULL, recurrence jsonb, next_due_at timestamptz, overlap text NOT NULL, misfire text NOT NULL, state text NOT NULL
);
CREATE TABLE occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid NOT NULL REFERENCES schedules, scheduled_for timestamptz NOT NULL,
 disposition text NOT NULL, run_id uuid REFERENCES runs, UNIQUE(schedule_id,scheduled_for)
);
CREATE TABLE run_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES runs, logical_key text NOT NULL, state text NOT NULL,
 attempt integer NOT NULL DEFAULT 0, checkpoint jsonb, lease_until timestamptz, error_code text, UNIQUE(run_id,logical_key)
);
CREATE TABLE outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, attempts integer NOT NULL DEFAULT 0);
CREATE INDEX ON outbox(created_at) WHERE dispatched_at IS NULL;
CREATE TABLE sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
CREATE TABLE source_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources, version integer NOT NULL CHECK(version>0),
 manifest jsonb NOT NULL, eligibility text NOT NULL, method text NOT NULL, coverage text, policy_evidence text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,version), UNIQUE(id,source_id)
);
CREATE TABLE artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 store_key text UNIQUE NOT NULL, mime text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 retain_until timestamptz, purged_at timestamptz,
 access_class text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE retrieval_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES run_tasks, source_version_id uuid NOT NULL REFERENCES source_versions,
 method text NOT NULL, final_url text, status integer, bytes bigint, duration_ms bigint, error_code text, artifact_id uuid REFERENCES artifacts
);
CREATE TABLE observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources, source_version_id uuid NOT NULL,
 source_record_id text NOT NULL, revision_hash text NOT NULL CHECK(revision_hash ~ '^[0-9a-f]{64}$'), source_url text,
 event_date date, source_modified_at timestamptz, fetched_at timestamptz NOT NULL, artifact_id uuid NOT NULL REFERENCES artifacts,
 extractor_version text NOT NULL, UNIQUE(source_id,source_record_id,revision_hash),
 FOREIGN KEY(source_version_id,source_id) REFERENCES source_versions(id,source_id)
);
CREATE TABLE run_observations (run_id uuid NOT NULL REFERENCES runs, observation_id uuid NOT NULL REFERENCES observations, PRIMARY KEY(run_id,observation_id));
CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), raw_name text NOT NULL, normalized_name text NOT NULL, kind text, observation_id uuid REFERENCES observations);
CREATE INDEX ON organizations(normalized_name);
CREATE TABLE people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, organization_id uuid REFERENCES organizations, role text, suppressed boolean NOT NULL DEFAULT false);
CREATE TABLE contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations, person_id uuid REFERENCES people,
 channel text NOT NULL CHECK(channel IN ('email','phone','website')), value text NOT NULL,
 public_business boolean NOT NULL DEFAULT false, verified boolean NOT NULL DEFAULT false, suppressed boolean NOT NULL DEFAULT false,
 checked_on date, observation_id uuid NOT NULL REFERENCES observations,
 CHECK(organization_id IS NOT NULL OR person_id IS NOT NULL),
 CHECK(NOT verified OR (public_business AND checked_on IS NOT NULL AND organization_id IS NOT NULL))
);
CREATE TABLE entity_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), from_id uuid NOT NULL REFERENCES organizations, to_id uuid NOT NULL REFERENCES organizations, role text NOT NULL, observation_id uuid NOT NULL REFERENCES observations, acceptance text NOT NULL, valid_from date, valid_to date);
CREATE TABLE merge_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), link_id uuid NOT NULL REFERENCES entity_links, actor_id uuid NOT NULL REFERENCES "user", merged_at timestamptz NOT NULL DEFAULT now(), reversed_at timestamptz);
CREATE TABLE parcels (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), county_fips text NOT NULL, raw_apn text NOT NULL, apn text NOT NULL, geom geometry(Geometry,4326), acreage numeric, valid_from date, valid_to date);
CREATE INDEX ON parcels(county_fips,apn);
CREATE INDEX ON parcels USING gist(geom);
CREATE TABLE parcel_lineage (parent_id uuid NOT NULL REFERENCES parcels, child_id uuid NOT NULL REFERENCES parcels, effective_on date, observation_id uuid NOT NULL REFERENCES observations, PRIMARY KEY(parent_id,child_id));
CREATE TABLE ownerships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parcel_id uuid NOT NULL REFERENCES parcels, owner_name text NOT NULL, role text NOT NULL, effective_on date, observation_id uuid NOT NULL REFERENCES observations);
CREATE TABLE transfers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), instrument text NOT NULL, jurisdiction text NOT NULL, consideration numeric, transaction_type text, recorded_on date, executed_on date, observation_id uuid NOT NULL REFERENCES observations, UNIQUE(jurisdiction,instrument));
CREATE TABLE transfer_parcels (transfer_id uuid NOT NULL REFERENCES transfers, parcel_id uuid NOT NULL REFERENCES parcels, PRIMARY KEY(transfer_id,parcel_id));
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, parent_id uuid REFERENCES projects);
CREATE TABLE permits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), jurisdiction text NOT NULL, permit_number text NOT NULL, project_id uuid REFERENCES projects,
 raw_status text, status text, raw_type text, permit_type text, issued_on date, applied_on date, UNIQUE(jurisdiction,permit_number)
);
CREATE TABLE permit_participants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), permit_id uuid NOT NULL REFERENCES permits, role text NOT NULL, organization_id uuid REFERENCES organizations, person_id uuid REFERENCES people, observation_id uuid NOT NULL REFERENCES observations, CHECK(organization_id IS NOT NULL OR person_id IS NOT NULL));
CREATE TABLE planning_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), jurisdiction text NOT NULL, case_number text NOT NULL, geom geometry(Geometry,4326), proposed_units integer, approved_units integer, decision text, conditions text, UNIQUE(jurisdiction,case_number));
CREATE TABLE listings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sources, listing_number text NOT NULL, episode integer NOT NULL, parcel_id uuid REFERENCES parcels, UNIQUE(source_id,listing_number,episode));
CREATE TABLE listing_observations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid NOT NULL REFERENCES listings, observed_at timestamptz NOT NULL, status text NOT NULL, price numeric, currency text, price_kind text, observation_id uuid NOT NULL REFERENCES observations);
CREATE INDEX ON listing_observations(listing_id,status,observed_at);
CREATE TYPE acceptance_state AS ENUM ('verified','corroborated','inferred','conflicted','unknown','stale');
CREATE TABLE field_assertions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_type text NOT NULL, subject_id uuid NOT NULL, field text NOT NULL, value text,
 acceptance acceptance_state NOT NULL, conflict_group uuid, extractor_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON field_assertions(subject_type,subject_id,field);
CREATE TABLE evidence_links (assertion_id uuid NOT NULL REFERENCES field_assertions, observation_id uuid NOT NULL REFERENCES observations, relation text NOT NULL CHECK(relation IN ('supports','contradicts')), PRIMARY KEY(assertion_id,observation_id));
CREATE INDEX ON evidence_links(observation_id);
CREATE INDEX ON permit_participants(permit_id);
CREATE INDEX ON contacts(organization_id);
CREATE TABLE research_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES runs, step integer NOT NULL, tool text NOT NULL, summary text NOT NULL, usage jsonb NOT NULL, UNIQUE(run_id,step));
CREATE TABLE claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), step_id uuid NOT NULL REFERENCES research_steps, assertion_id uuid NOT NULL REFERENCES field_assertions);
CREATE TABLE metric_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), metric text NOT NULL, version integer NOT NULL, geography text NOT NULL, segment text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, vintage date, sample_count integer NOT NULL, value numeric);
CREATE TABLE incidents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text NOT NULL, impact text NOT NULL, state text NOT NULL, source_version_id uuid REFERENCES source_versions, artifact_id uuid REFERENCES artifacts);
CREATE INDEX ON incidents(fingerprint);
CREATE TABLE repair_briefs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid NOT NULL REFERENCES incidents, brief text NOT NULL, release text);
CREATE TABLE exports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid NOT NULL REFERENCES "user", scope text[] NOT NULL, run_id uuid NOT NULL REFERENCES runs, filters jsonb NOT NULL, artifact_id uuid REFERENCES artifacts, expires_at timestamptz NOT NULL);
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_id uuid NOT NULL REFERENCES "user", event_id uuid NOT NULL REFERENCES outbox, seen_at timestamptz, UNIQUE(recipient_id,event_id));
CREATE TABLE webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES outbox, destination_id uuid NOT NULL, attempts integer NOT NULL DEFAULT 0, UNIQUE(event_id,destination_id));
REVOKE INSERT, UPDATE, DELETE ON "user", account FROM skyscrape_runtime;
REVOKE ALL ON verification, bootstrap_token FROM skyscrape_runtime;
REVOKE UPDATE ON artifacts FROM skyscrape_runtime;
GRANT UPDATE (retain_until, purged_at) ON artifacts TO skyscrape_runtime;
REVOKE UPDATE, DELETE ON campaign_versions, source_versions, observations, run_observations, audit_events, settings_history FROM skyscrape_runtime;

-- Disclosure requires qualification at collection time and under the current source policy.
CREATE VIEW eligible_observations AS
SELECT observation.*
FROM observations observation
JOIN source_versions collected ON collected.id = observation.source_version_id
WHERE collected.eligibility = 'qualified'
  AND (SELECT current_policy.eligibility FROM source_versions current_policy
       WHERE current_policy.source_id = observation.source_id
       ORDER BY current_policy.version DESC LIMIT 1) = 'qualified';

CREATE VIEW permit_evidence AS
SELECT permit.id AS permit_id, assertion.field, assertion.value, assertion.acceptance,
       link.relation, link.observation_id
FROM permits permit
JOIN field_assertions assertion ON assertion.subject_id = permit.id AND assertion.subject_type = 'permit'
JOIN evidence_links link ON link.assertion_id = assertion.id
JOIN eligible_observations observation ON observation.id = link.observation_id
WHERE assertion.field IN ('jurisdiction', 'permitNumber', 'rawStatus', 'status', 'rawType',
                          'permitType', 'issuedOn', 'appliedOn');

CREATE VIEW eligible_permits AS
SELECT permit.*
FROM permits permit
WHERE EXISTS (
  SELECT 1 FROM permit_evidence evidence
  WHERE evidence.permit_id = permit.id AND evidence.relation = 'supports'
    AND evidence.acceptance IN ('verified', 'corroborated')
    AND (evidence.field, evidence.value) IN (
      ('jurisdiction', permit.jurisdiction), ('permitNumber', permit.permit_number)
    )
  GROUP BY evidence.permit_id
  HAVING count(DISTINCT evidence.field) = 2
);

REVOKE INSERT, UPDATE, DELETE ON eligible_observations, permit_evidence, eligible_permits FROM skyscrape_runtime;
