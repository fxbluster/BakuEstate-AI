-- =============================================================================
-- BakuEstate-AI: Round 1 Goldfish Audit — Cloud & SQL Hardening
-- Migration: 202611180003_goldfish_hardening.sql
--
-- Depends on:
--   - 202611180001_crm_core_schema.sql
--   - 202611180002_worker_rpc_and_cron.sql
--
-- 100% additive & idempotent (zero destructive statements):
--   1. public.preserve_non_empty_owner_phone() + BEFORE UPDATE trigger on
--      public.listings so blank/null updates never wipe a stored owner phone.
--   2. public.count_today_auto_renders_baku() updated to include RUNNING AUTO
--      pipeline_jobs that have not yet created a render_versions row since
--      started_at (eliminates concurrency quota race).
--   3. public.complete_pipeline_job(p_job_id, p_worker_id, p_status,
--      p_error_message) fenced RPC (service_role only) requiring matching
--      locked_by & status = 'RUNNING', plus transient QUEUED requeue support.
--   4. public.get_prunable_render_versions(p_prune_days, p_active_keep_limit,
--      p_batch_limit) SQL-filtered pruner RPC (service_role only) eliminating
--      200-row JS starvation and enforcing the active COMPLETED LRU cap.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Preserve Non-Empty Owner Phone on public.listings Updates
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preserve_non_empty_owner_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NULLIF(BTRIM(NEW.owner_phone_normalized), '') IS NULL
       AND NULLIF(BTRIM(OLD.owner_phone_normalized), '') IS NOT NULL THEN
        NEW.owner_phone_normalized := OLD.owner_phone_normalized;
    END IF;

    IF NULLIF(BTRIM(NEW.owner_phone_raw), '') IS NULL
       AND NULLIF(BTRIM(OLD.owner_phone_raw), '') IS NOT NULL THEN
        NEW.owner_phone_raw := OLD.owner_phone_raw;
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_listings_preserve_owner_phone'
          AND tgrelid = 'public.listings'::regclass
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_listings_preserve_owner_phone
            BEFORE UPDATE ON public.listings
            FOR EACH ROW
            EXECUTE FUNCTION public.preserve_non_empty_owner_phone();
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. RPC: count_today_auto_renders_baku (Updated to include in-flight RUNNING)
--    Returns total AUTO renders for the current Asia/Baku (UTC+4) calendar day:
--      a) non-FAILED AUTO render_versions created today
--      b) QUEUED AUTO_SCHEDULER render pipeline_jobs created today
--      c) RUNNING AUTO_SCHEDULER render pipeline_jobs created today that do
--         not yet have a non-FAILED AUTO render_versions row created since
--         job.started_at
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
    ),
    running_auto_without_version AS (
        SELECT COUNT(*)::INT AS cnt
        FROM public.pipeline_jobs pj
        CROSS JOIN baku_day bd
        WHERE pj.trigger_source = 'AUTO_SCHEDULER'
          AND pj.job_type IN ('RENDER_INITIAL', 'RENDER_PRICE_DROP')
          AND pj.status = 'RUNNING'
          AND pj.created_at >= bd.day_start
          AND NOT EXISTS (
              SELECT 1
              FROM public.render_versions rv
              WHERE rv.listing_id = pj.listing_id
                AND rv.trigger_reason IN ('AUTO_INITIAL', 'AUTO_PRICE_DROP')
                AND rv.status <> 'FAILED'
                AND rv.created_at >= COALESCE(pj.started_at, pj.created_at)
          )
    )
    SELECT (SELECT cnt FROM rendered)
         + (SELECT cnt FROM queued_auto)
         + (SELECT cnt FROM running_auto_without_version);
$$;

REVOKE ALL ON FUNCTION public.count_today_auto_renders_baku() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_today_auto_renders_baku() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. RPC: complete_pipeline_job (Fenced Completion & Transient Requeue)
--    Updates pipeline_jobs ONLY when id = p_job_id AND locked_by = p_worker_id
--    AND status = 'RUNNING'. Supports terminal statuses ('SUCCEEDED', 'FAILED',
--    'EXPIRED') as well as 'QUEUED' for transient retry requeueing (clearing
--    locked_by & lease_expires_at without setting finished_at).
-- -----------------------------------------------------------------------------

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

    IF v_status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'QUEUED') THEN
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

REVOKE ALL ON FUNCTION public.complete_pipeline_job(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_pipeline_job(UUID, TEXT, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. RPC: get_prunable_render_versions (SQL-Filtered Pruner + Active LRU Cap)
--    Returns unpruned render_versions eligible for Supabase Storage deletion:
--      (a) Older than p_prune_days AND (status = 'SUPERSEDED' OR parent
--          listing is ARCHIVED / OWNER_SOLD / REMOVED_ON_BINA / CONFIRMED_SOLD)
--      (b) Remaining active COMPLETED renders ranked by created_at DESC beyond
--          p_active_keep_limit (LRU cap protecting the 1 GB Storage bucket)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_prunable_render_versions(
    p_prune_days INT DEFAULT 14,
    p_active_keep_limit INT DEFAULT 35,
    p_batch_limit INT DEFAULT 100
)
RETURNS TABLE (
    id UUID,
    listing_id UUID,
    version_num INT,
    storage_object_path TEXT,
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
            rv.listing_id,
            rv.version_num,
            rv.storage_object_path,
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
            rv.listing_id,
            rv.version_num,
            rv.storage_object_path,
            rv.created_at,
            ROW_NUMBER() OVER (ORDER BY rv.created_at DESC, rv.id DESC) AS recency_rank
        FROM public.render_versions rv
        WHERE rv.storage_pruned_at IS NULL
          AND NULLIF(BTRIM(rv.storage_object_path), '') IS NOT NULL
          AND rv.status = 'COMPLETED'
          AND NOT EXISTS (
              SELECT 1
              FROM expired_candidates ec
              WHERE ec.id = rv.id
          )
    ),
    lru_candidates AS (
        SELECT
            ar.id,
            ar.listing_id,
            ar.version_num,
            ar.storage_object_path,
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
        c.listing_id,
        c.version_num,
        c.storage_object_path,
        c.prune_reason
    FROM combined c
    ORDER BY c.priority_order ASC, c.created_at ASC
    LIMIT (SELECT batch_limit FROM params);
$$;

REVOKE ALL ON FUNCTION public.get_prunable_render_versions(INT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_prunable_render_versions(INT, INT, INT) TO service_role;
