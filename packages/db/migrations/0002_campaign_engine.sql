CREATE SCHEMA campaign_queue;
REVOKE ALL ON SCHEMA campaign_queue FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA campaign_queue TO skyscrape_worker;

ALTER TABLE schedules ADD COLUMN grace_minutes integer NOT NULL DEFAULT 1440 CHECK (grace_minutes BETWEEN 0 AND 1440);
CREATE UNIQUE INDEX campaign_schedule_one ON schedules(campaign_id) WHERE state IN ('active','paused');
CREATE INDEX campaign_schedule_due ON schedules(next_due_at) WHERE state = 'active';
CREATE UNIQUE INDEX campaign_overlap_one ON occurrences(schedule_id) WHERE disposition = 'waiting_overlap';
ALTER TABLE run_tasks ADD COLUMN attempt_id uuid;
ALTER TABLE run_tasks ADD COLUMN retryable boolean NOT NULL DEFAULT false;
ALTER TABLE run_tasks ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX campaign_task_lease ON run_tasks(lease_until) WHERE state = 'running';
CREATE INDEX campaign_delivery_task ON outbox ((payload->>'taskId'),created_at DESC,id DESC)
  WHERE event_type='campaign.task.ready';
ALTER TABLE permits ADD COLUMN last_observed_at timestamptz;

ALTER TABLE campaigns ADD COLUMN create_key text;
CREATE UNIQUE INDEX campaign_create_key ON campaigns(owner_id, create_key) WHERE create_key IS NOT NULL;

CREATE TABLE campaign_run_requests (
  actor_id uuid NOT NULL REFERENCES "user",
  action text NOT NULL CHECK (action IN ('run', 'retry')),
  resource_id uuid NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  run_id uuid NOT NULL REFERENCES runs,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id, action, resource_id, request_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE campaign_run_requests TO skyscrape_runtime;
REVOKE UPDATE, DELETE ON TABLE runs, run_tasks, occurrences, outbox FROM skyscrape_runtime;
GRANT UPDATE (state, finished_at) ON TABLE runs TO skyscrape_runtime;
GRANT UPDATE (state, error_code, retryable, available_at) ON TABLE run_tasks TO skyscrape_runtime;
GRANT UPDATE (disposition) ON TABLE occurrences TO skyscrape_runtime;

GRANT SELECT ON TABLE campaigns, campaign_versions, schedules, occurrences, runs, run_tasks,
  outbox, sources, source_versions, artifacts, permits, observations, run_observations,
  retrieval_attempts TO skyscrape_worker;
GRANT SELECT (id) ON TABLE field_assertions TO skyscrape_worker;
GRANT INSERT ON TABLE occurrences, runs, run_tasks, outbox, artifacts, permits, observations,
  run_observations, field_assertions, evidence_links, retrieval_attempts TO skyscrape_worker;
GRANT UPDATE (state) ON campaigns TO skyscrape_worker;
GRANT UPDATE (next_due_at, state) ON TABLE schedules TO skyscrape_worker;
GRANT UPDATE (disposition, run_id) ON TABLE occurrences TO skyscrape_worker;
GRANT UPDATE (state, counters, started_at, finished_at) ON TABLE runs TO skyscrape_worker;
GRANT UPDATE (state, attempt, checkpoint, lease_until, error_code, attempt_id, retryable, available_at)
  ON TABLE run_tasks TO skyscrape_worker;
GRANT UPDATE (dispatched_at, attempts) ON TABLE outbox TO skyscrape_worker;
GRANT UPDATE (raw_status, status, raw_type, permit_type, issued_on, applied_on, last_observed_at)
  ON TABLE permits TO skyscrape_worker;

-- Retention owns the old row and storage key. A fresh retrieval gets a new generation.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_sha256_key;
CREATE UNIQUE INDEX active_artifact_digest ON artifacts(sha256) WHERE purged_at IS NULL;
CREATE FUNCTION reserve_campaign_artifact(digest text, byte_count bigint, task uuid)
RETURNS TABLE(id uuid, store_key text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  INSERT INTO public.artifacts AS a(sha256,store_key,mime,size_bytes,access_class)
  VALUES(digest,digest || '.' || task::text,'application/json',byte_count,'restricted')
  ON CONFLICT(sha256) WHERE purged_at IS NULL DO UPDATE SET sha256=excluded.sha256
    WHERE a.size_bytes=excluded.size_bytes AND a.mime=excluded.mime AND a.access_class=excluded.access_class
  RETURNING a.id,a.store_key;
$$;
REVOKE ALL ON FUNCTION reserve_campaign_artifact(text,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_campaign_artifact(text,bigint,uuid) TO skyscrape_worker;

-- Only a qualified registry version enables collection. No production campaign is seeded.
WITH city AS (
  INSERT INTO sources(name) VALUES('seattle-building-permits')
  ON CONFLICT(name) DO NOTHING RETURNING id
)
INSERT INTO source_versions(source_id, version, manifest, eligibility, method, coverage, policy_evidence)
SELECT id, 1,
  '{"connector":"seattle-building-permits","countyFips":["53033"],"allowedFields":["permitnum","issueddate","statuscurrent","permittypemapped","applieddate"],"assessmentId":"seattle-permits-2026-11-21","synthetic":false}',
  'qualified', 'structured', 'City of Seattle permit jurisdiction; no county completeness claim',
  'Seattle Department of Construction and Inspections, Building Permits; public data assessment of 2026-11-21'
FROM city;

-- An operator imports typed, reviewed facts for an existing immutable observation.
-- Only the migrator can approve a mapping or a source grant.
CREATE TABLE campaign_import_facts (
  observation_id uuid PRIMARY KEY REFERENCES observations,
  county_fips text NOT NULL CHECK(county_fips ~ '^[0-9]{5}$'),
  acceptance acceptance_state NOT NULL,
  facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
  contact_id uuid REFERENCES contacts,
  CHECK ((facts->>'kind'='contact') = (contact_id IS NOT NULL))
);
CREATE INDEX observations_record_revision ON observations(source_id,source_record_id,fetched_at DESC);
CREATE VIEW authorized_campaign_revisions AS
SELECT o.id, o.source_id, o.source_version_id, o.source_record_id, o.fetched_at, o.event_date, o.extractor_version,
  f.county_fips, f.acceptance, f.facts, v.manifest, s.name AS source_name,
  (SELECT n.fetched_at FROM observations n WHERE n.source_id=o.source_id AND n.source_record_id=o.source_record_id
     AND (f.facts->>'kind'<>'listing' OR n.event_date IS NOT DISTINCT FROM o.event_date)
     AND (n.fetched_at,n.id)>(o.fetched_at,o.id) ORDER BY n.fetched_at,n.id LIMIT 1) AS superseded_at
FROM campaign_import_facts f JOIN eligible_observations o ON o.id=f.observation_id
JOIN sources s ON s.id=o.source_id JOIN source_versions v ON v.id=o.source_version_id
JOIN LATERAL (SELECT manifest FROM source_versions WHERE source_id=o.source_id
              ORDER BY version DESC LIMIT 1) policy ON true
LEFT JOIN contacts c ON c.id=f.contact_id
LEFT JOIN people p ON p.id=c.person_id
WHERE v.manifest->'campaignImport'->>'freeOnly'='true'
 AND v.manifest->'countyFips' ? f.county_fips
 AND policy.manifest->'countyFips' ? f.county_fips
 AND policy.manifest->'campaignImport'->>'freeOnly'='true'
 AND v.manifest->'campaignImport'->>'kind'=f.facts->>'kind'
 AND policy.manifest->'campaignImport'->>'kind'=f.facts->>'kind'
 AND jsonb_typeof(policy.manifest->'campaignImport'->'allowedFields')='array'
 AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(f.facts - 'kind') AS fact(field)
   WHERE v.manifest->'campaignImport'->'allowedFields' ? fact.field
     AND NOT (policy.manifest->'campaignImport'->'allowedFields' ? fact.field))
 AND f.acceptance IN ('verified','corroborated')
 AND (f.contact_id IS NULL OR (c.observation_id=o.id AND c.verified AND c.public_business
   AND NOT c.suppressed AND NOT coalesce(p.suppressed,false) AND c.checked_on<=CURRENT_DATE
   AND c.organization_id::text=f.facts->>'organizationId' AND c.channel=f.facts->>'channel'
   AND c.checked_on::text=f.facts->>'checkedOn'));
CREATE VIEW eligible_campaign_inputs AS
SELECT c.* FROM authorized_campaign_revisions c
WHERE c.superseded_at IS NULL;
CREATE VIEW eligible_campaign_citations AS
SELECT c.* FROM authorized_campaign_revisions c
WHERE c.facts->>'kind'<>'contact' OR EXISTS (
  SELECT 1 FROM eligible_campaign_inputs latest WHERE latest.source_id=c.source_id
    AND latest.source_record_id=c.source_record_id AND latest.facts->>'kind'='contact'
    AND latest.facts->>'organizationId'=c.facts->>'organizationId'
    AND latest.facts->>'channel'=c.facts->>'channel'
    AND latest.facts->>'role'=c.facts->>'role'
    AND latest.facts->>'verifiedPublicBusiness'='true' AND latest.facts->>'suppressed'='false'
);
GRANT SELECT ON eligible_campaign_citations, eligible_campaign_inputs TO skyscrape_worker,skyscrape_runtime;

CREATE TABLE campaign_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs, ordinal integer NOT NULL, record_key text NOT NULL, classification text NOT NULL,
  event_date date, fields jsonb NOT NULL, evidence_ids uuid[] NOT NULL,
  UNIQUE(run_id,record_key)
);
CREATE UNIQUE INDEX campaign_matches_page ON campaign_matches(run_id,ordinal);
GRANT SELECT,INSERT ON campaign_matches TO skyscrape_worker,skyscrape_runtime;

-- Expose calendar days for historical publisher timestamp assertions.
CREATE OR REPLACE VIEW permit_evidence AS
SELECT permit.id AS permit_id, assertion.field,
       CASE WHEN assertion.field IN ('issuedOn','appliedOn')
         AND assertion.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?$'
         THEN left(assertion.value,10) ELSE assertion.value END AS value,
       assertion.acceptance,
       link.relation, link.observation_id
FROM permits permit
JOIN field_assertions assertion ON assertion.subject_id = permit.id AND assertion.subject_type = 'permit'
JOIN evidence_links link ON link.assertion_id = assertion.id
JOIN eligible_observations observation ON observation.id = link.observation_id
JOIN source_versions collected ON collected.id=observation.source_version_id
JOIN LATERAL (SELECT manifest FROM source_versions WHERE source_id=observation.source_id
              ORDER BY version DESC LIMIT 1) policy ON true
WHERE (collected.manifest->>'connector' IS DISTINCT FROM 'seattle-building-permits' OR (
  policy.manifest->>'connector'='seattle-building-permits'
  AND policy.manifest->'countyFips' ? CASE WHEN collected.manifest->>'synthetic'='true' THEN '00000' ELSE '53033' END
  AND policy.manifest->'allowedFields' ? 'permitnum'
  AND policy.manifest->'allowedFields' ? CASE assertion.field
    WHEN 'rawStatus' THEN 'statuscurrent' WHEN 'status' THEN 'statuscurrent'
    WHEN 'rawType' THEN 'permittypemapped' WHEN 'permitType' THEN 'permittypemapped'
    WHEN 'issuedOn' THEN 'issueddate' WHEN 'appliedOn' THEN 'applieddate'
    ELSE 'permitnum' END))
AND assertion.field IN ('jurisdiction', 'permitNumber', 'rawStatus', 'status', 'rawType',
                          'permitType', 'issuedOn', 'appliedOn');

-- The runtime can record this action only for an export belonging to the requester.
CREATE FUNCTION skyscrape_access.audit_export_download(requester uuid, export_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  INSERT INTO public.audit_events(actor_id,action,subject_id)
  SELECT requester_id,'export.downloaded',id FROM public.exports WHERE id=export_id AND requester_id=requester;
$$;
REVOKE ALL ON FUNCTION skyscrape_access.audit_export_download(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skyscrape_access.audit_export_download(uuid,uuid) TO skyscrape_runtime;
