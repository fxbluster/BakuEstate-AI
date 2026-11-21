-- =============================================================================
-- BakuEstate-AI: Worker Queue RPCs, Heartbeat Tracking & pg_cron Schedules
-- Migration: 202611180002_worker_rpc_and_cron.sql
--
-- Depends on: 202611180001_crm_core_schema.sql
-- Provides:
--   1. public.worker_heartbeats table + public.worker_status view (RLS enforced)
--   2. public.record_worker_heartbeat(p_worker_id, p_current_job_id, p_metadata)
--   3. public.claim_next_pipeline_job(p_worker_id, p_lease_minutes)
--   4. public.heartbeat_pipeline_job(p_job_id, p_worker_id, p_lease_minutes)
--   5. public.count_today_auto_renders_baku()
--   6. pg_cron schedules:
--        - baku_estate_followup_dispatcher: every 5 minutes (*/5 * * * *)
--        - baku_estate_storage_pruner:      daily 03:00 Asia/Baku (UTC+4) = 23:00 UTC (0 23 * * *)
--
-- Cron Configuration (set once in Supabase SQL Editor — NEVER commit secrets):
--   ALTER DATABASE postgres SET app.supabase_project_url = 'https://<project-ref>.supabase.co';
--   ALTER DATABASE postgres SET app.cron_secret = '<strong-random-cron-secret>';
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Worker Heartbeat Tracking Table & Online/Offline Status View
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_job_id UUID NULL REFERENCES public.pipeline_jobs(id) ON DELETE SET NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE public.worker_heartbeats FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.worker_heartbeats TO authenticated, service_role;
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_only_all_worker_heartbeats ON public.worker_heartbeats;
CREATE POLICY operator_only_all_worker_heartbeats
    ON public.worker_heartbeats
    FOR ALL
    TO authenticated
    USING (public.is_crm_operator())
    WITH CHECK (public.is_crm_operator());

CREATE OR REPLACE VIEW public.worker_status
WITH (security_invoker = true)
AS
SELECT
    wh.worker_id,
    wh.last_seen_at,
    wh.current_job_id,
    pj.job_type AS current_job_type,
    pj.status AS current_job_status,
    wh.metadata_json,
    (wh.last_seen_at >= NOW() - INTERVAL '3 minutes') AS is_online,
    EXTRACT(EPOCH FROM (NOW() - wh.last_seen_at))::INT AS seconds_since_heartbeat
FROM public.worker_heartbeats wh
LEFT JOIN public.pipeline_jobs pj ON pj.id = wh.current_job_id
ORDER BY wh.last_seen_at DESC;

REVOKE ALL ON TABLE public.worker_status FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.worker_status TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. RPC: record_worker_heartbeat
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_worker_heartbeat(
    p_worker_id TEXT,
    p_current_job_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
BEGIN
    IF p_worker_id IS NULL OR BTRIM(p_worker_id) = '' THEN
        RAISE EXCEPTION 'p_worker_id must not be empty';
    END IF;

    INSERT INTO public.worker_heartbeats (
        worker_id,
        last_seen_at,
        current_job_id,
        metadata_json,
        updated_at
    )
    VALUES (
        BTRIM(p_worker_id),
        v_now,
        p_current_job_id,
        COALESCE(p_metadata, '{}'::jsonb),
        v_now
    )
    ON CONFLICT (worker_id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        current_job_id = EXCLUDED.current_job_id,
        metadata_json = COALESCE(EXCLUDED.metadata_json, public.worker_heartbeats.metadata_json),
        updated_at = EXCLUDED.updated_at;

    RETURN v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.record_worker_heartbeat(TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_worker_heartbeat(TEXT, UUID, JSONB) TO service_role;

-- -----------------------------------------------------------------------------
-- 3. RPC: claim_next_pipeline_job
--    - Expires overdue AUTO_SCHEDULER jobs whose expires_at < NOW()
--    - Fails RUNNING jobs whose lease expired and attempts >= max_attempts
--    - Requeues RUNNING jobs whose lease expired and attempts < max_attempts
--    - Atomically claims 1 QUEUED job via FOR UPDATE SKIP LOCKED
--      (prioritizing manual WEB_UI / TELEGRAM_WEBHOOK jobs over AUTO_SCHEDULER)
--    - Records worker heartbeat automatically
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_next_pipeline_job(
    p_worker_id TEXT,
    p_lease_minutes INT DEFAULT 5
)
RETURNS SETOF public.pipeline_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lease_mins INT := GREATEST(1, COALESCE(p_lease_minutes, 5));
    v_claimed public.pipeline_jobs%ROWTYPE;
BEGIN
    IF p_worker_id IS NULL OR BTRIM(p_worker_id) = '' THEN
        RAISE EXCEPTION 'p_worker_id must not be empty';
    END IF;

    -- 1. Expire stale AUTO jobs past their TTL (prevents quota burst after PC downtime)
    UPDATE public.pipeline_jobs
    SET status = 'EXPIRED',
        finished_at = NOW(),
        locked_by = NULL,
        lease_expires_at = NULL,
        error_message = COALESCE(error_message, 'AUTO job TTL expired before worker claim')
    WHERE status = 'QUEUED'
      AND trigger_source = 'AUTO_SCHEDULER'
      AND expires_at IS NOT NULL
      AND expires_at < NOW();

    -- 2a. Fail timed-out RUNNING jobs that exhausted max_attempts
    UPDATE public.pipeline_jobs
    SET status = 'FAILED',
        finished_at = NOW(),
        locked_by = NULL,
        lease_expires_at = NULL,
        error_message = COALESCE(error_message, 'Worker lease expired after max attempts')
    WHERE status = 'RUNNING'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
      AND attempts >= max_attempts;

    -- 2b. Requeue timed-out RUNNING jobs that still have retry attempts left
    UPDATE public.pipeline_jobs
    SET status = 'QUEUED',
        locked_by = NULL,
        lease_expires_at = NULL
    WHERE status = 'RUNNING'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
      AND attempts < max_attempts;

    -- 3. Atomically claim the next available QUEUED job
    WITH next_job AS (
        SELECT id
        FROM public.pipeline_jobs
        WHERE status = 'QUEUED'
          AND (
              trigger_source <> 'AUTO_SCHEDULER'
              OR expires_at IS NULL
              OR expires_at >= NOW()
          )
        ORDER BY
            CASE WHEN trigger_source IN ('WEB_UI', 'TELEGRAM_WEBHOOK') THEN 0 ELSE 1 END ASC,
            created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.pipeline_jobs j
    SET status = 'RUNNING',
        attempts = j.attempts + 1,
        locked_by = BTRIM(p_worker_id),
        started_at = COALESCE(j.started_at, NOW()),
        lease_expires_at = NOW() + make_interval(mins => v_lease_mins)
    FROM next_job
    WHERE j.id = next_job.id
    RETURNING j.* INTO v_claimed;

    -- 4. Update worker heartbeat (with claimed job id or NULL if idle)
    PERFORM public.record_worker_heartbeat(BTRIM(p_worker_id), v_claimed.id, '{}'::jsonb);

    IF v_claimed.id IS NOT NULL THEN
        RETURN NEXT v_claimed;
    END IF;
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_pipeline_job(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_pipeline_job(TEXT, INT) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. RPC: heartbeat_pipeline_job
--    Extends lease_expires_at for an actively running job owned by p_worker_id.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.heartbeat_pipeline_job(
    p_job_id UUID,
    p_worker_id TEXT,
    p_lease_minutes INT DEFAULT 5
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lease_mins INT := GREATEST(1, COALESCE(p_lease_minutes, 5));
    v_updated INT := 0;
BEGIN
    IF p_job_id IS NULL OR p_worker_id IS NULL OR BTRIM(p_worker_id) = '' THEN
        RETURN FALSE;
    END IF;

    UPDATE public.pipeline_jobs
    SET lease_expires_at = NOW() + make_interval(mins => v_lease_mins)
    WHERE id = p_job_id
      AND status = 'RUNNING'
      AND locked_by = BTRIM(p_worker_id);

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
        PERFORM public.record_worker_heartbeat(BTRIM(p_worker_id), p_job_id, '{}'::jsonb);
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.heartbeat_pipeline_job(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_pipeline_job(UUID, TEXT, INT) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. RPC: count_today_auto_renders_baku
--    Returns total AUTO renders (created non-failed render_versions + queued
--    AUTO render jobs) for the current Asia/Baku (UTC+4) calendar day.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.count_today_auto_renders_baku()
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH baku_day AS (
        SELECT (date_trunc('day', NOW() AT TIME ZONE 'Asia/Baku') AT TIME ZONE 'Asia/Baku') AS day_start
    ),
    rendered AS (
        SELECT COUNT(*)::INT AS cnt
        FROM public.render_versions rv
        CROSS JOIN baku_day bd
        WHERE rv.trigger_reason IN ('AUTO_INITIAL', 'AUTO_PRICE_DROP')
          AND rv.status <> 'FAILED'
          AND rv.created_at >= bd.day_start
    ),
    queued_auto AS (
        SELECT COUNT(*)::INT AS cnt
        FROM public.pipeline_jobs pj
        CROSS JOIN baku_day bd
        WHERE pj.trigger_source = 'AUTO_SCHEDULER'
          AND pj.job_type IN ('RENDER_INITIAL', 'RENDER_PRICE_DROP')
          AND pj.status = 'QUEUED'
          AND pj.created_at >= bd.day_start
    )
    SELECT (SELECT cnt FROM rendered) + (SELECT cnt FROM queued_auto);
$$;

REVOKE ALL ON FUNCTION public.count_today_auto_renders_baku() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_today_auto_renders_baku() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. pg_cron Schedules for Edge Functions (Follow-Up Dispatcher & Storage Pruner)
--    Uses pg_cron + pg_net reading project URL & cron secret from Postgres
--    settings (no hardcoded URLs or keys). Guarded so non-Supabase Postgres
--    instances don't fail if pg_cron/pg_net are unavailable.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.invoke_edge_function_cron(p_function_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_base_url TEXT;
    v_cron_secret TEXT;
    v_request_id BIGINT;
BEGIN
    v_base_url := NULLIF(BTRIM(current_setting('app.supabase_project_url', true)), '');
    IF v_base_url IS NULL THEN
        SELECT NULLIF(BTRIM(value), '') INTO v_base_url FROM public.baku_estate_config WHERE key = 'supabase_project_url';
    END IF;

    v_cron_secret := NULLIF(BTRIM(current_setting('app.cron_secret', true)), '');
    IF v_cron_secret IS NULL THEN
        SELECT NULLIF(BTRIM(value), '') INTO v_cron_secret FROM public.baku_estate_config WHERE key = 'cron_secret';
    END IF;

    IF v_base_url IS NULL THEN
        RAISE WARNING 'invoke_edge_function_cron(%) skipped: app.supabase_project_url not set', p_function_name;
        RETURN NULL;
    END IF;

    SELECT net.http_post(
        url := rtrim(v_base_url, '/') || '/functions/v1/' || p_function_name,
        headers := jsonb_strip_nulls(jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', v_cron_secret
        )),
        body := jsonb_build_object(
            'source', 'pg_cron',
            'triggered_at', NOW()
        )
    ) INTO v_request_id;

    RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_edge_function_cron(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function_cron(TEXT) TO service_role;

DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
       AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN

        CREATE EXTENSION IF NOT EXISTS pg_cron;
        CREATE EXTENSION IF NOT EXISTS pg_net;

        -- Remove prior schedules if re-running migration idempotently
        FOR v_job_id IN
            SELECT jobid FROM cron.job
            WHERE jobname IN ('baku_estate_followup_dispatcher', 'baku_estate_storage_pruner')
        LOOP
            PERFORM cron.unschedule(v_job_id);
        END LOOP;

        -- Every 5 minutes: Follow-Up Dispatcher (respects 21:30-09:00 Asia/Baku quiet hours)
        PERFORM cron.schedule(
            'baku_estate_followup_dispatcher',
            '*/5 * * * *',
            $cron$SELECT public.invoke_edge_function_cron('followup-dispatcher');$cron$
        );

        -- Daily 03:00 Asia/Baku (UTC+4, no DST) = 23:00 UTC: Storage Pruner (>14-day MP4 cleanup)
        PERFORM cron.schedule(
            'baku_estate_storage_pruner',
            '0 23 * * *',
            $cron$SELECT public.invoke_edge_function_cron('storage-pruner');$cron$
        );
    END IF;
END;
$$;
