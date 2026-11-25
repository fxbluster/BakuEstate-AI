-- =============================================================================
-- BakuEstate-AI v2: P0 Atomic RPCs, Partial Unique Indexes, Dispatch Leases,
-- Serialized AI Budget Reservation, Worker RPCs & pg_cron Schedules
-- Migration: 202611260002_v2_p0_atomic_rpcs.sql
--
-- Depends on: 202611260001_v2_baseline_and_rbac.sql
-- Security model:
--   - All client-callable RPCs derive tenant from auth.uid() via current_agency_id()
--     (never trusting a client-supplied p_agency_id) unless auth.role() = 'service_role'.
--   - Worker & AI budget reservation/reconciliation RPCs are service_role only.
--   - ZERO anon / PUBLIC EXECUTE privileges.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Partial Unique Indexes on pipeline_jobs & Lease Columns on publications
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_active_listing
    ON public.pipeline_jobs (listing_id, job_type)
    WHERE status IN ('QUEUED', 'RUNNING') AND listing_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_active_utility
    ON public.pipeline_jobs (agency_id, job_type)
    WHERE status IN ('QUEUED', 'RUNNING') AND job_type IN ('SCRAPE_NEW', 'LIVENESS_CHECK');

ALTER TABLE public.pipeline_jobs
    DROP CONSTRAINT IF EXISTS pipeline_jobs_idempotency_key_key;
DROP INDEX IF EXISTS public.pipeline_jobs_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_idempotency_active
    ON public.pipeline_jobs (idempotency_key)
    WHERE status <> 'CANCELLED';

ALTER TABLE public.publications
    ADD COLUMN IF NOT EXISTS dispatch_lock_token UUID NULL,
    ADD COLUMN IF NOT EXISTS dispatch_locked_until TIMESTAMPTZ NULL;

-- -----------------------------------------------------------------------------
-- 2. Worker Heartbeat, Claim, Heartbeat Lease & Completion RPCs (service_role)
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
        metadata_json = CASE
            WHEN EXCLUDED.metadata_json IS NULL OR EXCLUDED.metadata_json = '{}'::jsonb
                THEN COALESCE(public.worker_heartbeats.metadata_json, '{}'::jsonb)
            ELSE COALESCE(public.worker_heartbeats.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json
        END,
        updated_at = EXCLUDED.updated_at;

    RETURN v_now;
END;
$$;

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

    -- 0. Finalize any QUEUED jobs whose cancel_requested_at was set before claim
    UPDATE public.pipeline_jobs
    SET status = 'CANCELLED',
        finished_at = NOW(),
        locked_by = NULL,
        lease_expires_at = NULL
    WHERE status = 'QUEUED'
      AND cancel_requested_at IS NOT NULL;

    -- 1. Expire stale AUTO jobs past their TTL
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

    -- 3. Atomically claim next uncancelled QUEUED job via FOR UPDATE SKIP LOCKED
    WITH next_job AS (
        SELECT id
        FROM public.pipeline_jobs
        WHERE status = 'QUEUED'
          AND cancel_requested_at IS NULL
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

    PERFORM public.record_worker_heartbeat(BTRIM(p_worker_id), v_claimed.id, '{}'::jsonb);

    IF v_claimed.id IS NOT NULL THEN
        RETURN NEXT v_claimed;
    END IF;
    RETURN;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.complete_pipeline_job(
    p_job_id UUID,
    p_worker_id TEXT,
    p_status TEXT,
    p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_worker_id TEXT := NULLIF(BTRIM(p_worker_id), '');
    v_status TEXT := UPPER(BTRIM(COALESCE(p_status, '')));
    v_updated INT := 0;
BEGIN
    IF p_job_id IS NULL OR v_worker_id IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'QUEUED', 'CANCELLED') THEN
        RAISE EXCEPTION 'Invalid p_status for complete_pipeline_job: %', p_status;
    END IF;

    IF v_status = 'QUEUED' THEN
        UPDATE public.pipeline_jobs
        SET status = 'QUEUED',
            locked_by = NULL,
            lease_expires_at = NULL,
            error_message = CASE
                WHEN p_error_message IS NOT NULL THEN LEFT(p_error_message, 2000)
                ELSE error_message
            END
        WHERE id = p_job_id
          AND locked_by = v_worker_id
          AND status = 'RUNNING';
    ELSE
        UPDATE public.pipeline_jobs
        SET status = v_status,
            finished_at = NOW(),
            locked_by = NULL,
            lease_expires_at = NULL,
            error_message = CASE
                WHEN p_error_message IS NOT NULL THEN LEFT(p_error_message, 2000)
                WHEN v_status = 'SUCCEEDED' THEN NULL
                ELSE error_message
            END
        WHERE id = p_job_id
          AND locked_by = v_worker_id
          AND status = 'RUNNING';
    END IF;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
        UPDATE public.worker_heartbeats
        SET current_job_id = NULL,
            last_seen_at = NOW(),
            updated_at = NOW()
        WHERE worker_id = v_worker_id
          AND current_job_id = p_job_id;
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.count_today_auto_renders_baku(
    p_agency_id UUID DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_agency_id UUID;
    v_day_start TIMESTAMPTZ;
    v_rendered INT := 0;
    v_queued INT := 0;
    v_running INT := 0;
BEGIN
    IF auth.role() = 'service_role' THEN
        v_agency_id := p_agency_id;
    ELSE
        v_agency_id := public.current_agency_id();
        IF v_agency_id IS NULL THEN
            RETURN 0;
        END IF;
    END IF;

    v_day_start := date_trunc('day', NOW() AT TIME ZONE 'Asia/Baku') AT TIME ZONE 'Asia/Baku';

    SELECT COUNT(*)::INT INTO v_rendered
    FROM public.render_versions rv
    WHERE (v_agency_id IS NULL OR rv.agency_id = v_agency_id)
      AND rv.trigger_reason IN ('AUTO_INITIAL', 'AUTO_PRICE_DROP')
      AND rv.status <> 'FAILED'
      AND rv.created_at >= v_day_start;

    SELECT COUNT(*)::INT INTO v_queued
    FROM public.pipeline_jobs pj
    WHERE (v_agency_id IS NULL OR pj.agency_id = v_agency_id)
      AND pj.trigger_source = 'AUTO_SCHEDULER'
      AND pj.job_type IN ('RENDER_INITIAL', 'RENDER_PRICE_DROP')
      AND pj.status = 'QUEUED'
      AND pj.created_at >= v_day_start;

    SELECT COUNT(*)::INT INTO v_running
    FROM public.pipeline_jobs pj
    WHERE (v_agency_id IS NULL OR pj.agency_id = v_agency_id)
      AND pj.trigger_source = 'AUTO_SCHEDULER'
      AND pj.job_type IN ('RENDER_INITIAL', 'RENDER_PRICE_DROP')
      AND pj.status = 'RUNNING'
      AND pj.created_at >= v_day_start
      AND NOT EXISTS (
          SELECT 1
          FROM public.render_versions rv
          WHERE rv.listing_id = pj.listing_id
            AND rv.trigger_reason IN ('AUTO_INITIAL', 'AUTO_PRICE_DROP')
            AND rv.status <> 'FAILED'
            AND rv.created_at >= COALESCE(pj.started_at, pj.created_at)
      );

    RETURN v_rendered + v_queued + v_running;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_prunable_render_versions(
    p_prune_days INT DEFAULT 14,
    p_active_keep_limit INT DEFAULT 35,
    p_batch_limit INT DEFAULT 100
)
RETURNS TABLE (
    id UUID,
    agency_id UUID,
    listing_id UUID,
    version_num INT,
    storage_object_path TEXT,
    storage_provider TEXT,
    prune_reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH params AS (
        SELECT
            NOW() - make_interval(days => GREATEST(1, COALESCE(p_prune_days, 14))) AS cutoff_ts,
            GREATEST(0, COALESCE(p_active_keep_limit, 35)) AS keep_limit,
            GREATEST(1, COALESCE(p_batch_limit, 100)) AS batch_limit
    ),
    expired_candidates AS (
        SELECT
            rv.id,
            rv.agency_id,
            rv.listing_id,
            rv.version_num,
            rv.storage_object_path,
            rv.storage_provider,
            CASE
                WHEN rv.status = 'SUPERSEDED' THEN 'SUPERSEDED_EXPIRED'
                ELSE 'LISTING_INACTIVE_EXPIRED'
            END AS prune_reason,
            rv.created_at,
            1 AS priority_order
        FROM public.render_versions rv
        LEFT JOIN public.listings l ON l.id = rv.listing_id
        CROSS JOIN params p
        WHERE rv.storage_pruned_at IS NULL
          AND NULLIF(BTRIM(rv.storage_object_path), '') IS NOT NULL
          AND rv.created_at < p.cutoff_ts
          AND (
              rv.status = 'SUPERSEDED'
              OR l.editorial_status = 'ARCHIVED'
              OR l.owner_outreach_status = 'OWNER_SOLD'
              OR l.source_availability IN ('REMOVED_ON_BINA', 'CONFIRMED_SOLD')
          )
    ),
    active_ranked AS (
        SELECT
            rv.id,
            rv.agency_id,
            rv.listing_id,
            rv.version_num,
            rv.storage_object_path,
            rv.storage_provider,
            rv.created_at,
            ROW_NUMBER() OVER (PARTITION BY rv.agency_id ORDER BY rv.created_at DESC, rv.id DESC) AS recency_rank
        FROM public.render_versions rv
        WHERE rv.storage_pruned_at IS NULL
          AND NULLIF(BTRIM(rv.storage_object_path), '') IS NOT NULL
          AND rv.status = 'COMPLETED'
          AND rv.storage_provider = 'supabase'
          AND NOT EXISTS (
              SELECT 1 FROM expired_candidates ec WHERE ec.id = rv.id
          )
    ),
    lru_candidates AS (
        SELECT
            ar.id,
            ar.agency_id,
            ar.listing_id,
            ar.version_num,
            ar.storage_object_path,
            ar.storage_provider,
            'ACTIVE_LRU_CAP'::TEXT AS prune_reason,
            ar.created_at,
            2 AS priority_order
        FROM active_ranked ar
        CROSS JOIN params p
        WHERE ar.recency_rank > p.keep_limit
    ),
    combined AS (
        SELECT * FROM expired_candidates
        UNION ALL
        SELECT * FROM lru_candidates
    )
    SELECT
        c.id,
        c.agency_id,
        c.listing_id,
        c.version_num,
        c.storage_object_path,
        c.storage_provider,
        c.prune_reason
    FROM combined c
    ORDER BY c.priority_order ASC, c.created_at ASC
    LIMIT (SELECT batch_limit FROM params);
$$;

-- -----------------------------------------------------------------------------
-- 3. Atomic Pipeline Job Enqueue, Retry/Cancel & Utility Queue RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_listing_render_atomic(
    p_listing_id UUID,
    p_job_type TEXT DEFAULT 'RENDER_INITIAL',
    p_target_account TEXT DEFAULT NULL,
    p_voice_preset TEXT DEFAULT NULL,
    p_params_json JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_caller_agency_id UUID;
    v_listing RECORD;
    v_job_type TEXT := UPPER(BTRIM(COALESCE(p_job_type, 'RENDER_INITIAL')));
    v_params JSONB;
    v_idem_key TEXT;
    v_new_job_id UUID;
    v_existing_job_id UUID;
    v_actor TEXT;
    v_trigger_source TEXT;
BEGIN
    IF p_listing_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'MISSING_LISTING_ID');
    END IF;

    IF v_job_type NOT IN ('RENDER_INITIAL', 'RERENDER') THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'INVALID_JOB_TYPE');
    END IF;

    IF NOT v_is_service THEN
        v_caller_agency_id := public.current_agency_id();
        IF v_caller_agency_id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN_INACTIVE_OR_NO_AGENCY');
        END IF;
    END IF;

    SELECT id, agency_id, bina_id, pipeline_status, editorial_status
      INTO v_listing
      FROM public.listings
     WHERE id = p_listing_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 404, 'error', 'LISTING_NOT_FOUND');
    END IF;

    IF NOT v_is_service AND v_listing.agency_id <> v_caller_agency_id THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'CROSS_AGENCY_FORBIDDEN');
    END IF;

    v_params := COALESCE(p_params_json, '{}'::jsonb);
    IF NULLIF(BTRIM(p_target_account), '') IS NOT NULL THEN
        v_params := v_params || jsonb_build_object('target_account', BTRIM(p_target_account));
    END IF;
    IF NULLIF(BTRIM(p_voice_preset), '') IS NOT NULL THEN
        v_params := v_params || jsonb_build_object('voice_preset', BTRIM(p_voice_preset));
    END IF;

    v_idem_key := format('render:%s:%s:%s', p_listing_id, v_job_type, gen_random_uuid());
    v_trigger_source := CASE WHEN v_is_service THEN 'AUTO_SCHEDULER' ELSE 'WEB_UI' END;
    v_actor := CASE WHEN v_is_service THEN 'local_worker' ELSE 'web_user' END;

    INSERT INTO public.pipeline_jobs (
        agency_id,
        assigned_agent_id,
        created_by,
        idempotency_key,
        job_type,
        listing_id,
        trigger_source,
        params_json,
        status
    )
    VALUES (
        v_listing.agency_id,
        v_uid,
        v_uid,
        v_idem_key,
        v_job_type,
        p_listing_id,
        v_trigger_source,
        v_params,
        'QUEUED'
    )
    ON CONFLICT (listing_id, job_type)
        WHERE status IN ('QUEUED', 'RUNNING') AND listing_id IS NOT NULL
        DO NOTHING
    RETURNING id INTO v_new_job_id;

    IF v_new_job_id IS NULL THEN
        SELECT id INTO v_existing_job_id
        FROM public.pipeline_jobs
        WHERE listing_id = p_listing_id
          AND job_type = v_job_type
          AND status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at DESC
        LIMIT 1;

        RETURN jsonb_build_object(
            'ok', true,
            'already_queued', true,
            'job_id', v_existing_job_id
        );
    END IF;

    UPDATE public.listings
    SET pipeline_status = 'QUEUED',
        editorial_status = CASE
            WHEN v_job_type = 'RERENDER' THEN 'NEEDS_RERENDER'
            ELSE editorial_status
        END
    WHERE id = p_listing_id;

    INSERT INTO public.listing_events (
        agency_id,
        listing_id,
        actor_user_id,
        event_type,
        old_value_json,
        new_value_json,
        triggered_job_id,
        actor
    )
    VALUES (
        v_listing.agency_id,
        p_listing_id,
        v_uid,
        'STATUS_CHANGED',
        jsonb_build_object(
            'pipeline_status', v_listing.pipeline_status,
            'editorial_status', v_listing.editorial_status
        ),
        jsonb_build_object(
            'pipeline_status', 'QUEUED',
            'editorial_status', CASE WHEN v_job_type = 'RERENDER' THEN 'NEEDS_RERENDER' ELSE v_listing.editorial_status END,
            'job_type', v_job_type
        ),
        v_new_job_id,
        v_actor
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_queued', false,
        'job_id', v_new_job_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_utility_job_atomic(
    p_job_type TEXT,
    p_params_json JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_job_type TEXT := UPPER(BTRIM(COALESCE(p_job_type, '')));
    v_new_id UUID;
    v_existing_id UUID;
BEGIN
    IF v_agency_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN_INACTIVE_OR_NO_AGENCY');
    END IF;

    IF v_job_type NOT IN ('SCRAPE_NEW', 'LIVENESS_CHECK') THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'INVALID_UTILITY_JOB_TYPE');
    END IF;

    INSERT INTO public.pipeline_jobs (
        agency_id,
        assigned_agent_id,
        created_by,
        idempotency_key,
        job_type,
        listing_id,
        trigger_source,
        params_json,
        status
    )
    VALUES (
        v_agency_id,
        v_uid,
        v_uid,
        format('utility:%s:%s:%s', v_agency_id, v_job_type, gen_random_uuid()),
        v_job_type,
        NULL,
        'WEB_UI',
        COALESCE(p_params_json, '{}'::jsonb),
        'QUEUED'
    )
    ON CONFLICT (agency_id, job_type)
        WHERE status IN ('QUEUED', 'RUNNING') AND job_type IN ('SCRAPE_NEW', 'LIVENESS_CHECK')
        DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NULL THEN
        SELECT id INTO v_existing_id
        FROM public.pipeline_jobs
        WHERE agency_id = v_agency_id
          AND job_type = v_job_type
          AND status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at DESC
        LIMIT 1;

        RETURN jsonb_build_object('ok', true, 'already_queued', true, 'job_id', v_existing_id);
    END IF;

    RETURN jsonb_build_object('ok', true, 'already_queued', false, 'job_id', v_new_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_or_cancel_pipeline_job(
    p_job_id UUID,
    p_action TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_agency_id UUID;
    v_action TEXT := UPPER(BTRIM(COALESCE(p_action, '')));
    v_job public.pipeline_jobs%ROWTYPE;
    v_conflict_id UUID;
BEGIN
    IF p_job_id IS NULL OR v_action NOT IN ('RETRY', 'CANCEL') THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'INVALID_ARGUMENTS');
    END IF;

    IF NOT v_is_service THEN
        v_agency_id := public.current_agency_id();
        IF v_agency_id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN_INACTIVE_OR_NO_AGENCY');
        END IF;
    END IF;

    SELECT * INTO v_job
    FROM public.pipeline_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 404, 'error', 'JOB_NOT_FOUND');
    END IF;

    IF NOT v_is_service AND v_job.agency_id <> v_agency_id THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'CROSS_AGENCY_FORBIDDEN');
    END IF;

    IF v_action = 'RETRY' THEN
        IF v_job.status = 'RUNNING' THEN
            RETURN jsonb_build_object('ok', false, 'status_code', 409, 'error', 'JOB_STILL_RUNNING');
        END IF;

        IF v_job.status NOT IN ('FAILED', 'EXPIRED') THEN
            RETURN jsonb_build_object(
                'ok', false,
                'status_code', 409,
                'error', 'INVALID_JOB_STATUS_FOR_RETRY',
                'current_status', v_job.status
            );
        END IF;

        IF v_job.listing_id IS NOT NULL THEN
            SELECT id INTO v_conflict_id
            FROM public.pipeline_jobs
            WHERE listing_id = v_job.listing_id
              AND job_type = v_job.job_type
              AND status IN ('QUEUED', 'RUNNING')
              AND id <> v_job.id
            LIMIT 1;
            IF v_conflict_id IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'status_code', 409,
                    'error', 'ACTIVE_JOB_ALREADY_EXISTS',
                    'active_job_id', v_conflict_id
                );
            END IF;
        END IF;

        UPDATE public.pipeline_jobs
        SET status = 'QUEUED',
            attempts = 0,
            locked_by = NULL,
            lease_expires_at = NULL,
            cancel_requested_at = NULL,
            started_at = NULL,
            finished_at = NULL,
            expires_at = NULL,
            error_message = NULL
        WHERE id = v_job.id;

        RETURN jsonb_build_object('ok', true, 'job_id', v_job.id, 'status', 'QUEUED');
    END IF;

    -- CANCEL
    IF v_job.status = 'QUEUED' THEN
        UPDATE public.pipeline_jobs
        SET status = 'CANCELLED',
            cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
            finished_at = NOW(),
            locked_by = NULL,
            lease_expires_at = NULL
        WHERE id = v_job.id;

        RETURN jsonb_build_object(
            'ok', true,
            'job_id', v_job.id,
            'status', 'CANCELLED',
            'cancel_requested', true
        );
    ELSIF v_job.status = 'RUNNING' THEN
        UPDATE public.pipeline_jobs
        SET cancel_requested_at = COALESCE(cancel_requested_at, NOW())
        WHERE id = v_job.id;

        RETURN jsonb_build_object(
            'ok', true,
            'job_id', v_job.id,
            'status', 'RUNNING',
            'cancel_requested', true
        );
    ELSE
        RETURN jsonb_build_object(
            'ok', false,
            'status_code', 409,
            'error', 'JOB_ALREADY_TERMINAL',
            'current_status', v_job.status
        );
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Two-Phase Telegram Dispatch Lease RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_telegram_dispatch_slot(
    p_publication_id UUID,
    p_cooldown_seconds INT DEFAULT 300
)
RETURNS TABLE (
    acquired BOOLEAN,
    lock_token UUID,
    locked_until TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_agency_id UUID;
    v_pub_agency_id UUID;
    v_token UUID := gen_random_uuid();
    v_until TIMESTAMPTZ := NOW() + INTERVAL '60 seconds';
    v_cooldown INT := GREATEST(0, COALESCE(p_cooldown_seconds, 300));
    v_updated INT := 0;
BEGIN
    IF p_publication_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT p.agency_id INTO v_pub_agency_id
    FROM public.publications p
    WHERE p.id = p_publication_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF NOT v_is_service THEN
        v_agency_id := public.current_agency_id();
        IF v_agency_id IS NULL OR v_agency_id <> v_pub_agency_id THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;
    END IF;

    UPDATE public.publications
    SET dispatch_lock_token = v_token,
        dispatch_locked_until = v_until
    WHERE id = p_publication_id
      AND (dispatch_locked_until IS NULL OR dispatch_locked_until < NOW())
      AND (
          telegram_dispatched_at IS NULL
          OR telegram_dispatched_at < NOW() - make_interval(secs => v_cooldown)
      );

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
        RETURN QUERY SELECT TRUE, v_token, v_until;
    ELSE
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TIMESTAMPTZ;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_telegram_dispatch(
    p_publication_id UUID,
    p_lock_token UUID,
    p_message_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_agency_id UUID;
    v_updated INT := 0;
BEGIN
    IF p_publication_id IS NULL OR p_lock_token IS NULL THEN
        RETURN FALSE;
    END IF;

    IF NOT v_is_service THEN
        v_agency_id := public.current_agency_id();
        IF v_agency_id IS NULL THEN
            RETURN FALSE;
        END IF;
    END IF;

    UPDATE public.publications
    SET telegram_dispatched_at = NOW(),
        telegram_message_id = p_message_id,
        dispatch_lock_token = NULL,
        dispatch_locked_until = NULL
    WHERE id = p_publication_id
      AND dispatch_lock_token = p_lock_token
      AND (v_is_service OR agency_id = v_agency_id);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_telegram_dispatch_slot(
    p_publication_id UUID,
    p_lock_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_agency_id UUID;
    v_updated INT := 0;
BEGIN
    IF p_publication_id IS NULL OR p_lock_token IS NULL THEN
        RETURN FALSE;
    END IF;

    IF NOT v_is_service THEN
        v_agency_id := public.current_agency_id();
        IF v_agency_id IS NULL THEN
            RETURN FALSE;
        END IF;
    END IF;

    UPDATE public.publications
    SET dispatch_lock_token = NULL,
        dispatch_locked_until = NULL
    WHERE id = p_publication_id
      AND dispatch_lock_token = p_lock_token
      AND (v_is_service OR agency_id = v_agency_id);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Atomic Multi-Table CRM RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_buyer_lead_atomic(
    p_client_name TEXT,
    p_phone_normalized TEXT DEFAULT NULL,
    p_social_handle TEXT DEFAULT NULL,
    p_source_channel TEXT DEFAULT 'TELEGRAM',
    p_stage TEXT DEFAULT 'NEW_INQUIRY',
    p_budget_max_azn NUMERIC DEFAULT NULL,
    p_preferred_districts TEXT[] DEFAULT '{}'::TEXT[],
    p_min_rooms INT DEFAULT NULL,
    p_requires_kupca BOOLEAN DEFAULT FALSE,
    p_expected_commission_azn NUMERIC DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_next_followup_at TIMESTAMPTZ DEFAULT NULL,
    p_listing_id UUID DEFAULT NULL,
    p_relation TEXT DEFAULT 'INQUIRED',
    p_task_title TEXT DEFAULT NULL,
    p_task_priority TEXT DEFAULT 'NORMAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_lead public.buyer_leads%ROWTYPE;
    v_task public.follow_up_tasks%ROWTYPE;
    v_task_title TEXT;
    v_listing_bina_id TEXT;
BEGIN
    IF v_uid IS NULL OR v_agency_id IS NULL OR NOT public.is_agency_broker_or_admin(v_agency_id) THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN_ROLE_OR_INACTIVE');
    END IF;

    IF NULLIF(BTRIM(p_client_name), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'CLIENT_NAME_REQUIRED');
    END IF;

    INSERT INTO public.buyer_leads (
        agency_id,
        assigned_agent_id,
        created_by,
        client_name,
        phone_normalized,
        social_handle,
        source_channel,
        stage,
        budget_max_azn,
        preferred_districts,
        min_rooms,
        requires_kupca,
        expected_commission_azn,
        notes,
        next_followup_at
    )
    VALUES (
        v_agency_id,
        v_uid,
        v_uid,
        BTRIM(p_client_name),
        NULLIF(BTRIM(p_phone_normalized), ''),
        NULLIF(BTRIM(p_social_handle), ''),
        COALESCE(NULLIF(BTRIM(p_source_channel), ''), 'TELEGRAM'),
        COALESCE(NULLIF(BTRIM(p_stage), ''), 'NEW_INQUIRY'),
        p_budget_max_azn,
        COALESCE(p_preferred_districts, '{}'::TEXT[]),
        p_min_rooms,
        COALESCE(p_requires_kupca, FALSE),
        p_expected_commission_azn,
        NULLIF(BTRIM(p_notes), ''),
        p_next_followup_at
    )
    RETURNING * INTO v_lead;

    IF p_listing_id IS NOT NULL THEN
        SELECT bina_id INTO v_listing_bina_id
        FROM public.listings
        WHERE id = p_listing_id AND agency_id = v_agency_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Listing % not found in agency %', p_listing_id, v_agency_id;
        END IF;

        INSERT INTO public.lead_listings (
            lead_id,
            listing_id,
            agency_id,
            relation,
            notes
        )
        VALUES (
            v_lead.id,
            p_listing_id,
            v_agency_id,
            COALESCE(NULLIF(BTRIM(p_relation), ''), 'INQUIRED'),
            NULLIF(BTRIM(p_notes), '')
        )
        ON CONFLICT (lead_id, listing_id) DO UPDATE SET
            relation = EXCLUDED.relation,
            notes = COALESCE(EXCLUDED.notes, public.lead_listings.notes);
    END IF;

    IF p_next_followup_at IS NOT NULL THEN
        v_task_title := COALESCE(
            NULLIF(BTRIM(p_task_title), ''),
            CASE
                WHEN v_listing_bina_id IS NOT NULL THEN format('%s — #%s', BTRIM(p_client_name), v_listing_bina_id)
                ELSE format('%s (Follow-up)', BTRIM(p_client_name))
            END
        );

        INSERT INTO public.follow_up_tasks (
            agency_id,
            assigned_agent_id,
            created_by,
            entity_type,
            lead_id,
            listing_id,
            title,
            due_at,
            priority,
            status
        )
        VALUES (
            v_agency_id,
            v_uid,
            v_uid,
            'BUYER_LEAD',
            v_lead.id,
            p_listing_id,
            v_task_title,
            p_next_followup_at,
            COALESCE(NULLIF(BTRIM(p_task_priority), ''), 'NORMAL'),
            'OPEN'
        )
        RETURNING * INTO v_task;
    END IF;

    INSERT INTO public.lead_timeline_events (
        agency_id,
        lead_id,
        listing_id,
        actor_user_id,
        actor,
        event_type,
        summary,
        metadata
    )
    VALUES (
        v_agency_id,
        v_lead.id,
        p_listing_id,
        v_uid,
        'OPERATOR',
        'INQUIRY',
        format('Yeni müştəri əlavə edildi: %s', BTRIM(p_client_name)),
        jsonb_build_object('source_channel', v_lead.source_channel, 'stage', v_lead.stage)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'lead', to_jsonb(v_lead),
        'task_id', v_task.id
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_follow_up_task_atomic(
    p_task_id UUID,
    p_status TEXT,
    p_due_at TIMESTAMPTZ DEFAULT NULL,
    p_outcome_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_status TEXT := UPPER(BTRIM(COALESCE(p_status, '')));
    v_task public.follow_up_tasks%ROWTYPE;
BEGIN
    IF v_uid IS NULL OR v_agency_id IS NULL OR NOT public.is_agency_broker_or_admin(v_agency_id) THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN');
    END IF;

    IF p_task_id IS NULL OR v_status NOT IN ('OPEN', 'SNOOZED', 'DONE', 'CANCELLED') THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'INVALID_ARGUMENTS');
    END IF;

    SELECT * INTO v_task
    FROM public.follow_up_tasks
    WHERE id = p_task_id AND agency_id = v_agency_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 404, 'error', 'TASK_NOT_FOUND');
    END IF;

    IF NOT public.is_agency_admin(v_agency_id) AND v_task.assigned_agent_id IS DISTINCT FROM v_uid THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'NOT_ASSIGNED_TO_BROKER');
    END IF;

    UPDATE public.follow_up_tasks
    SET status = v_status,
        due_at = COALESCE(p_due_at, due_at),
        snooze_count = CASE WHEN v_status = 'SNOOZED' THEN snooze_count + 1 ELSE snooze_count END,
        reminder_sent_at = CASE WHEN v_status = 'SNOOZED' THEN NULL ELSE reminder_sent_at END,
        completed_at = CASE WHEN v_status = 'DONE' THEN NOW() ELSE completed_at END,
        outcome_note = COALESCE(NULLIF(BTRIM(p_outcome_note), ''), outcome_note)
    WHERE id = p_task_id
    RETURNING * INTO v_task;

    IF v_task.lead_id IS NOT NULL AND v_status = 'SNOOZED' AND p_due_at IS NOT NULL THEN
        UPDATE public.buyer_leads
        SET next_followup_at = p_due_at
        WHERE id = v_task.lead_id AND agency_id = v_agency_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'task', to_jsonb(v_task));
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_publication_atomic(
    p_listing_id UUID,
    p_channel TEXT,
    p_post_url TEXT DEFAULT NULL,
    p_render_version_id UUID DEFAULT NULL,
    p_published_at TIMESTAMPTZ DEFAULT NOW(),
    p_notes TEXT DEFAULT NULL,
    p_target_account_handle TEXT DEFAULT '@bakuestate.official',
    p_channel_niche TEXT DEFAULT 'GENERAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_listing RECORD;
    v_pub public.publications%ROWTYPE;
    v_handle TEXT := COALESCE(NULLIF(BTRIM(p_target_account_handle), ''), '@bakuestate.official');
    v_niche TEXT := UPPER(COALESCE(NULLIF(BTRIM(p_channel_niche), ''), 'GENERAL'));
BEGIN
    IF v_uid IS NULL OR v_agency_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN');
    END IF;

    SELECT id, agency_id, editorial_status INTO v_listing
    FROM public.listings
    WHERE id = p_listing_id AND agency_id = v_agency_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 404, 'error', 'LISTING_NOT_FOUND');
    END IF;

    INSERT INTO public.publications (
        agency_id,
        assigned_agent_id,
        created_by,
        listing_id,
        render_version_id,
        channel,
        post_url,
        status,
        published_at,
        notes,
        target_account_handle,
        channel_niche
    )
    VALUES (
        v_agency_id,
        v_uid,
        v_uid,
        p_listing_id,
        p_render_version_id,
        UPPER(BTRIM(p_channel)),
        NULLIF(BTRIM(p_post_url), ''),
        'PUBLISHED',
        COALESCE(p_published_at, NOW()),
        NULLIF(BTRIM(p_notes), ''),
        v_handle,
        v_niche
    )
    ON CONFLICT (listing_id, target_account_handle) DO UPDATE SET
        render_version_id = COALESCE(EXCLUDED.render_version_id, public.publications.render_version_id),
        channel = EXCLUDED.channel,
        post_url = COALESCE(EXCLUDED.post_url, public.publications.post_url),
        status = 'PUBLISHED',
        published_at = EXCLUDED.published_at,
        notes = COALESCE(EXCLUDED.notes, public.publications.notes),
        channel_niche = EXCLUDED.channel_niche
    RETURNING * INTO v_pub;

    IF v_listing.editorial_status NOT IN ('PUBLISHED', 'ARCHIVED') THEN
        UPDATE public.listings
        SET editorial_status = 'PUBLISHED'
        WHERE id = p_listing_id;

        INSERT INTO public.listing_events (
            agency_id,
            listing_id,
            actor_user_id,
            event_type,
            old_value_json,
            new_value_json,
            actor
        )
        VALUES (
            v_agency_id,
            p_listing_id,
            v_uid,
            'STATUS_CHANGED',
            jsonb_build_object('editorial_status', v_listing.editorial_status),
            jsonb_build_object('editorial_status', 'PUBLISHED', 'post_url', v_pub.post_url, 'channel', v_pub.channel),
            'web_user'
        );
    END IF;

    RETURN jsonb_build_object('ok', true, 'publication', to_jsonb(v_pub));
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_duplicate_listing_atomic(
    p_listing_id UUID,
    p_decision TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_raw_decision TEXT := UPPER(BTRIM(COALESCE(p_decision, '')));
    v_decision TEXT;
    v_listing RECORD;
    v_job_id UUID;
BEGIN
    IF v_uid IS NULL OR v_agency_id IS NULL OR NOT public.is_agency_broker_or_admin(v_agency_id) THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 403, 'error', 'FORBIDDEN');
    END IF;

    IF v_raw_decision IN ('CONFIRM', 'CONFIRMED_DUPLICATE') THEN
        v_decision := 'CONFIRMED_DUPLICATE';
    ELSIF v_raw_decision IN ('SEPARATE', 'FALSE_POSITIVE') THEN
        v_decision := 'FALSE_POSITIVE';
    ELSE
        RETURN jsonb_build_object('ok', false, 'status_code', 400, 'error', 'INVALID_DECISION');
    END IF;

    SELECT id, agency_id, bina_id, duplicate_resolution, editorial_status, pipeline_status
      INTO v_listing
      FROM public.listings
     WHERE id = p_listing_id AND agency_id = v_agency_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'status_code', 404, 'error', 'LISTING_NOT_FOUND');
    END IF;

    IF v_decision = 'CONFIRMED_DUPLICATE' THEN
        UPDATE public.listings
        SET duplicate_resolution = 'CONFIRMED_DUPLICATE',
            editorial_status = 'ARCHIVED',
            pipeline_status = 'SKIPPED_DUPLICATE'
        WHERE id = p_listing_id;

        INSERT INTO public.listing_events (
            agency_id, listing_id, actor_user_id, event_type,
            old_value_json, new_value_json, actor
        )
        VALUES (
            v_agency_id, p_listing_id, v_uid, 'STATUS_CHANGED',
            jsonb_build_object('duplicate_resolution', v_listing.duplicate_resolution),
            jsonb_build_object('duplicate_resolution', 'CONFIRMED_DUPLICATE', 'editorial_status', 'ARCHIVED'),
            'web_user'
        );

        UPDATE public.follow_up_tasks
        SET status = 'DONE',
            completed_at = NOW(),
            outcome_note = 'Təkrar elan təsdiqləndi və arxivləndi'
        WHERE listing_id = p_listing_id
          AND agency_id = v_agency_id
          AND entity_type = 'DUPLICATE_REVIEW'
          AND status IN ('OPEN', 'SNOOZED');
    ELSE
        UPDATE public.listings
        SET duplicate_resolution = 'FALSE_POSITIVE',
            duplicate_of_listing_id = NULL,
            pipeline_status = 'QUEUED'
        WHERE id = p_listing_id;

        INSERT INTO public.pipeline_jobs (
            agency_id,
            assigned_agent_id,
            created_by,
            idempotency_key,
            job_type,
            listing_id,
            trigger_source,
            params_json,
            status
        )
        VALUES (
            v_agency_id,
            v_uid,
            v_uid,
            format('dup_separate:%s:%s', p_listing_id, gen_random_uuid()),
            'RENDER_INITIAL',
            p_listing_id,
            'WEB_UI',
            jsonb_build_object('reason', 'duplicate_false_positive'),
            'QUEUED'
        )
        ON CONFLICT (listing_id, job_type)
            WHERE status IN ('QUEUED', 'RUNNING') AND listing_id IS NOT NULL
            DO NOTHING
        RETURNING id INTO v_job_id;

        INSERT INTO public.listing_events (
            agency_id, listing_id, actor_user_id, event_type,
            old_value_json, new_value_json, triggered_job_id, actor
        )
        VALUES (
            v_agency_id, p_listing_id, v_uid, 'STATUS_CHANGED',
            jsonb_build_object('duplicate_resolution', v_listing.duplicate_resolution),
            jsonb_build_object('duplicate_resolution', 'FALSE_POSITIVE', 'pipeline_status', 'QUEUED'),
            v_job_id,
            'web_user'
        );

        UPDATE public.follow_up_tasks
        SET status = 'DONE',
            completed_at = NOW(),
            outcome_note = 'Təkrar deyil — ayrı render növbəsinə salındı'
        WHERE listing_id = p_listing_id
          AND agency_id = v_agency_id
          AND entity_type = 'DUPLICATE_REVIEW'
          AND status IN ('OPEN', 'SNOOZED');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'listing_id', p_listing_id,
        'decision', v_decision,
        'job_id', v_job_id
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Serialized AI Budget Reservation & Reconciliation (Fail-Closed)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_budget(
    p_operator_id UUID,
    p_agency_id UUID,
    p_estimated_usd NUMERIC DEFAULT 0.015
)
RETURNS TABLE (
    allowed BOOLEAN,
    run_id UUID,
    reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month_baku TEXT := to_char(NOW() AT TIME ZONE 'Asia/Baku', 'YYYY-MM');
    v_budget_usd NUMERIC(10, 2);
    v_rpm_limit INT;
    v_recent_count INT;
    v_usage public.agency_ai_usage_monthly%ROWTYPE;
    v_est NUMERIC(12, 6) := GREATEST(0, COALESCE(p_estimated_usd, 0.015));
    v_run_id UUID;
BEGIN
    IF p_operator_id IS NULL OR p_agency_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'MISSING_IDENTITY'::TEXT;
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.agency_members am
        WHERE am.user_id = p_operator_id
          AND am.agency_id = p_agency_id
          AND am.is_active = TRUE
    ) THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'INACTIVE_MEMBER'::TEXT;
        RETURN;
    END IF;

    SELECT s.monthly_ai_budget_usd, s.ai_rate_limit_rpm
      INTO v_budget_usd, v_rpm_limit
      FROM public.agency_settings s
     WHERE s.agency_id = p_agency_id;

    v_budget_usd := COALESCE(v_budget_usd, 50.00);
    v_rpm_limit := COALESCE(v_rpm_limit, 20);

    INSERT INTO public.agency_ai_usage_monthly (agency_id, month_baku, reserved_usd, spent_usd)
    VALUES (p_agency_id, v_month_baku, 0, 0)
    ON CONFLICT (agency_id, month_baku) DO NOTHING;

    SELECT * INTO v_usage
    FROM public.agency_ai_usage_monthly
    WHERE agency_id = p_agency_id AND month_baku = v_month_baku
    FOR UPDATE;

    SELECT COUNT(*)::INT INTO v_recent_count
    FROM public.ai_copilot_runs r
    WHERE r.agency_id = p_agency_id
      AND r.created_at >= NOW() - INTERVAL '1 minute';

    IF v_recent_count >= v_rpm_limit THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'RATE_LIMIT_EXCEEDED'::TEXT;
        RETURN;
    END IF;

    IF (v_usage.spent_usd + v_usage.reserved_usd + v_est) > v_budget_usd THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'MONTHLY_BUDGET_EXCEEDED'::TEXT;
        RETURN;
    END IF;

    UPDATE public.agency_ai_usage_monthly
    SET reserved_usd = reserved_usd + v_est,
        updated_at = NOW()
    WHERE agency_id = p_agency_id AND month_baku = v_month_baku;

    INSERT INTO public.ai_copilot_runs (
        agency_id,
        operator_id,
        action,
        model,
        status,
        reserved_usd,
        cost_usd
    )
    VALUES (
        p_agency_id,
        p_operator_id,
        'copilot_reserved',
        'gemini-3.8-flash-high',
        'PENDING',
        v_est,
        0
    )
    RETURNING id INTO v_run_id;

    RETURN QUERY SELECT TRUE, v_run_id, 'OK'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_ai_budget_run(
    p_run_id UUID,
    p_prompt_tokens INT,
    p_output_tokens INT,
    p_audio_seconds NUMERIC,
    p_actual_usd NUMERIC,
    p_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.ai_copilot_runs%ROWTYPE;
    v_month_baku TEXT;
    v_status TEXT := UPPER(BTRIM(COALESCE(p_status, 'FAILED')));
    v_actual NUMERIC(12, 6) := GREATEST(0, COALESCE(p_actual_usd, 0));
BEGIN
    IF p_run_id IS NULL OR v_status NOT IN ('COMPLETED', 'FAILED') THEN
        RETURN FALSE;
    END IF;

    SELECT * INTO v_run
    FROM public.ai_copilot_runs
    WHERE id = p_run_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_month_baku := to_char(v_run.created_at AT TIME ZONE 'Asia/Baku', 'YYYY-MM');

    UPDATE public.agency_ai_usage_monthly
    SET reserved_usd = GREATEST(0, reserved_usd - COALESCE(v_run.reserved_usd, 0)),
        spent_usd = spent_usd + CASE WHEN v_status = 'COMPLETED' THEN v_actual ELSE 0 END,
        updated_at = NOW()
    WHERE agency_id = v_run.agency_id AND month_baku = v_month_baku;

    UPDATE public.ai_copilot_runs
    SET status = v_status,
        prompt_tokens = GREATEST(0, COALESCE(p_prompt_tokens, 0)),
        completion_tokens = GREATEST(0, COALESCE(p_output_tokens, 0)),
        audio_seconds = GREATEST(0, COALESCE(p_audio_seconds, 0)),
        reserved_usd = 0,
        cost_usd = CASE WHEN v_status = 'COMPLETED' THEN v_actual ELSE 0 END
    WHERE id = p_run_id;

    RETURN TRUE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. pg_cron Schedules for Edge Functions
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

DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
       AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        CREATE EXTENSION IF NOT EXISTS pg_net;

        FOR v_job_id IN
            SELECT jobid FROM cron.job
            WHERE jobname IN ('baku_estate_followup_dispatcher', 'baku_estate_storage_pruner')
        LOOP
            PERFORM cron.unschedule(v_job_id);
        END LOOP;

        PERFORM cron.schedule(
            'baku_estate_followup_dispatcher',
            '*/5 * * * *',
            $cron$SELECT public.invoke_edge_function_cron('followup-dispatcher');$cron$
        );

        PERFORM cron.schedule(
            'baku_estate_storage_pruner',
            '0 23 * * *',
            $cron$SELECT public.invoke_edge_function_cron('storage-pruner');$cron$
        );
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Explicit Function Privilege Assignments (Zero PUBLIC / anon)
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.record_worker_heartbeat(TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_worker_heartbeat(TEXT, UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.claim_next_pipeline_job(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_pipeline_job(TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.heartbeat_pipeline_job(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_pipeline_job(UUID, TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.complete_pipeline_job(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_pipeline_job(UUID, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.get_prunable_render_versions(INT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_prunable_render_versions(INT, INT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.invoke_edge_function_cron(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function_cron(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.check_and_reserve_ai_budget(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_reserve_ai_budget(UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_ai_budget_run(UUID, INT, INT, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_ai_budget_run(UUID, INT, INT, NUMERIC, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.count_today_auto_renders_baku(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_today_auto_renders_baku(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.enqueue_listing_render_atomic(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_listing_render_atomic(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.enqueue_utility_job_atomic(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_utility_job_atomic(TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.retry_or_cancel_pipeline_job(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_or_cancel_pipeline_job(UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_telegram_dispatch_slot(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_telegram_dispatch_slot(UUID, INT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.confirm_telegram_dispatch(UUID, UUID, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_telegram_dispatch(UUID, UUID, BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.release_telegram_dispatch_slot(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_telegram_dispatch_slot(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_buyer_lead_atomic(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT[], INT, BOOLEAN, NUMERIC, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_buyer_lead_atomic(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT[], INT, BOOLEAN, NUMERIC, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_follow_up_task_atomic(UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_follow_up_task_atomic(UUID, TEXT, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.confirm_publication_atomic(UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_publication_atomic(UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_duplicate_listing_atomic(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_duplicate_listing_atomic(UUID, TEXT) TO authenticated, service_role;
