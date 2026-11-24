-- =============================================================================
-- Migration: 202611250001_worker_telemetry_and_realtime.sql
-- Purpose:
--   1. Preserve & shallow-merge worker_heartbeats.metadata_json on lightweight
--      claim/lease-renewal ticks instead of overwriting rich telemetry with `{}`.
--   2. Expose current active job context (started_at, params, listing bina_id/title)
--      at the end of public.worker_status view for live CRM tracking.
--   3. Enable Supabase Realtime publication for worker_heartbeats & pipeline_jobs.
-- =============================================================================

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
        metadata_json = CASE
            WHEN EXCLUDED.metadata_json IS NULL OR EXCLUDED.metadata_json = '{}'::jsonb
                THEN COALESCE(public.worker_heartbeats.metadata_json, '{}'::jsonb)
            ELSE COALESCE(public.worker_heartbeats.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json
        END,
        updated_at = EXCLUDED.updated_at;

    RETURN v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.record_worker_heartbeat(TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_worker_heartbeat(TEXT, UUID, JSONB) TO service_role;

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
    EXTRACT(EPOCH FROM (NOW() - wh.last_seen_at))::INT AS seconds_since_heartbeat,
    pj.started_at AS current_job_started_at,
    pj.params_json AS current_job_params,
    l.bina_id AS current_listing_bina_id,
    l.title AS current_listing_title
FROM public.worker_heartbeats wh
LEFT JOIN public.pipeline_jobs pj ON pj.id = wh.current_job_id
LEFT JOIN public.listings l ON l.id = pj.listing_id
ORDER BY wh.last_seen_at DESC;

REVOKE ALL ON TABLE public.worker_status FROM PUBLIC;
GRANT SELECT ON TABLE public.worker_status TO anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'worker_heartbeats'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.worker_heartbeats;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'pipeline_jobs'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.pipeline_jobs;
        END IF;
    END IF;
END;
$$;
