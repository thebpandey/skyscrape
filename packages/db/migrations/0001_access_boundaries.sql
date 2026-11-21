REVOKE ALL ON TABLE public."user", public.account, public.session, public.verification,
  public.bootstrap_token, public.api_keys, public.provider_accounts, public.audit_events,
  public.contacts, public.people, public.organizations, public.permit_participants,
  public.field_assertions, public.evidence_links
FROM skyscrape_runtime;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.sources, public.source_versions,
  public.observations, public.permits, public.eligible_observations, public.permit_evidence,
  public.eligible_permits
FROM skyscrape_runtime;
GRANT SELECT ON TABLE public.sources, public.source_versions, public.observations,
  public.permits, public.eligible_observations, public.permit_evidence, public.eligible_permits
TO skyscrape_runtime;

GRANT SELECT, INSERT ON TABLE public.campaign_versions, public.run_observations, public.settings_history TO skyscrape_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.settings, public.quota_reservations,
  public.campaigns, public.runs, public.schedules, public.occurrences, public.run_tasks,
  public.outbox, public.retrieval_attempts, public.entity_links, public.merge_history,
  public.parcels, public.parcel_lineage, public.ownerships, public.transfers,
  public.transfer_parcels, public.projects, public.planning_cases, public.listings,
  public.listing_observations, public.research_steps, public.claims, public.metric_snapshots,
  public.incidents, public.repair_briefs, public.exports, public.notifications, public.webhook_deliveries
TO skyscrape_runtime;
REVOKE UPDATE ON TABLE public.artifacts FROM skyscrape_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE public.artifacts TO skyscrape_runtime;
GRANT UPDATE (retain_until, purged_at) ON TABLE public.artifacts TO skyscrape_runtime;

GRANT SELECT ON TABLE public."user", public.account, public.session TO skyscrape_auth;
GRANT INSERT, DELETE ON TABLE public.session TO skyscrape_auth;
GRANT UPDATE ("expiresAt", "updatedAt") ON TABLE public.session TO skyscrape_auth;
GRANT INSERT (actor_id, action) ON TABLE public.audit_events TO skyscrape_auth;
GRANT SELECT (prefix, digest) ON TABLE public.api_keys TO skyscrape_auth;
GRANT SELECT (id, role) ON TABLE public."user" TO skyscrape_admin;

CREATE SCHEMA skyscrape_access;
REVOKE ALL ON SCHEMA skyscrape_access FROM PUBLIC;
GRANT USAGE ON SCHEMA skyscrape_access TO skyscrape_runtime, skyscrape_auth, skyscrape_admin;

CREATE FUNCTION skyscrape_access.consume_key(key_prefix text, proof bytea)
RETURNS TABLE(owner_id uuid, role text, scopes text[], limited boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    UPDATE public.api_keys key
    SET last_used = now(), usage_date = current_date,
        usage_count = CASE WHEN key.usage_date = current_date THEN key.usage_count + 1 ELSE 1 END
    FROM public."user" owner
    WHERE key.prefix = key_prefix AND key.digest = proof AND key.owner_id = owner.id
      AND key.revoked_at IS NULL AND key.expires_at > now()
      AND (key.usage_date IS DISTINCT FROM current_date OR key.usage_count < key.daily_quota)
    RETURNING owner.id, owner.role, key.scopes, false;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::text, NULL::text[], true
      FROM public.api_keys key
      WHERE key.prefix = key_prefix AND key.digest = proof
        AND key.revoked_at IS NULL AND key.expires_at > now();
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION skyscrape_access.consume_key(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skyscrape_access.consume_key(text, bytea) TO skyscrape_auth;

CREATE FUNCTION skyscrape_access.require_admin(session_id uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor_id uuid;
BEGIN
  SELECT actor.id INTO actor_id
  FROM public.session login
  JOIN public."user" actor ON actor.id = login."userId"
  WHERE login.id = session_id AND login."expiresAt" > now() AND actor.role = 'admin'
  FOR SHARE OF actor;
  -- Reset locks the user before deleting their sessions.
  PERFORM 1 FROM public.session login
  WHERE login.id = session_id AND login."userId" = actor_id AND login."expiresAt" > now()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE insufficient_privilege USING MESSAGE = 'Current admin session required';
  END IF;
  RETURN actor_id;
END;
$$;
REVOKE ALL ON FUNCTION skyscrape_access.require_admin(uuid) FROM PUBLIC;

CREATE FUNCTION skyscrape_access.issue_key(session_id uuid, owner_id uuid, prefix text, digest bytea,
  scopes text[], expires_at timestamptz, daily_quota integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor_id uuid := skyscrape_access.require_admin(session_id);
  key_id uuid;
BEGIN
  IF expires_at <= now() THEN RAISE invalid_parameter_value USING MESSAGE = 'Expiry must be in the future'; END IF;
  INSERT INTO public.api_keys(owner_id, prefix, digest, scopes, expires_at, daily_quota)
  VALUES(owner_id, prefix, digest, scopes, expires_at, daily_quota) RETURNING id INTO key_id;
  INSERT INTO public.audit_events(actor_id, action, subject_id) VALUES(actor_id, 'api_key.created', key_id);
  RETURN key_id;
END;
$$;

CREATE FUNCTION skyscrape_access.revoke_key(session_id uuid, key_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor_id uuid := skyscrape_access.require_admin(session_id);
BEGIN
  UPDATE public.api_keys SET revoked_at = now() WHERE id = key_id AND revoked_at IS NULL;
  IF FOUND THEN
    INSERT INTO public.audit_events(actor_id, action, subject_id) VALUES(actor_id, 'api_key.revoked', key_id);
  END IF;
END;
$$;

CREATE FUNCTION skyscrape_access.set_provider_key(session_id uuid, provider_name text, encrypted bytea, version integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor_id uuid := skyscrape_access.require_admin(session_id);
  provider_id uuid;
BEGIN
  INSERT INTO public.provider_accounts(name, encrypted_key, key_version, free_quota)
  VALUES(provider_name, encrypted, version, 0)
  ON CONFLICT(name) DO UPDATE SET encrypted_key = excluded.encrypted_key, key_version = excluded.key_version
  RETURNING id INTO provider_id;
  INSERT INTO public.audit_events(actor_id, action, subject_id) VALUES(actor_id, 'provider_key.saved', provider_id);
  RETURN provider_id;
END;
$$;

REVOKE ALL ON FUNCTION skyscrape_access.issue_key(uuid, uuid, text, bytea, text[], timestamptz, integer),
  skyscrape_access.revoke_key(uuid, uuid), skyscrape_access.set_provider_key(uuid, text, bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skyscrape_access.issue_key(uuid, uuid, text, bytea, text[], timestamptz, integer),
  skyscrape_access.revoke_key(uuid, uuid), skyscrape_access.set_provider_key(uuid, text, bytea, integer) TO skyscrape_admin;

CREATE FUNCTION skyscrape_access.read_permit_contacts(permit_ids uuid[], actor_id uuid, session_id uuid, key_proof bytea)
RETURNS TABLE(permit_id uuid, channel text, value text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT permit.id, contact.channel, contact.value
  FROM public.eligible_permits permit
  JOIN public.permit_participants participant ON participant.permit_id = permit.id
  JOIN public.eligible_observations participant_source ON participant_source.id = participant.observation_id
  JOIN public.contacts contact ON contact.organization_id = participant.organization_id
    AND (contact.person_id IS NULL OR contact.person_id = participant.person_id)
  JOIN public.eligible_observations contact_source ON contact_source.id = contact.observation_id
  LEFT JOIN public.people person ON person.id = contact.person_id
  WHERE permit.id = ANY(permit_ids)
    AND contact.verified AND contact.public_business AND NOT contact.suppressed
    AND NOT coalesce(person.suppressed, false)
    AND contact.checked_on <= (now() AT TIME ZONE 'UTC')::date
    AND EXISTS (
      SELECT 1 FROM public."user" actor
      WHERE actor.id = actor_id AND actor.role = 'analyst' AND (
        EXISTS (SELECT 1 FROM public.session login
                WHERE login.id = session_id AND login."userId" = actor.id AND login."expiresAt" > now())
        OR EXISTS (SELECT 1 FROM public.api_keys key
                   WHERE key.digest = key_proof AND key.owner_id = actor.id
                     AND key.revoked_at IS NULL AND key.expires_at > now() AND 'contacts:read' = ANY(key.scopes))
      )
    )
  ORDER BY permit.id, contact.channel, contact.value;
$$;
REVOKE ALL ON FUNCTION skyscrape_access.read_permit_contacts(uuid[], uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skyscrape_access.read_permit_contacts(uuid[], uuid, uuid, bytea) TO skyscrape_runtime;
