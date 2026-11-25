-- =============================================================================
-- BakuEstate-AI v2 Phase 2: Cloud Media Storage Provider, Pagination & pg_trgm
-- Indexes, District Price Medians View, SQL KPI/Analytics RPCs & Cockpit Cron
-- Migration: 202611260003_v2_p1_cloud_studio_and_pagination.sql
--
-- Depends on:
--   - 202611260001_v2_baseline_and_rbac.sql
--   - 202611260002_v2_p0_atomic_rpcs.sql
--
-- Security model:
--   - All client-callable RPCs derive agency_id & role strictly from auth.uid()
--     via public.current_agency_id() and public.current_agency_role().
--   - public.district_price_medians uses security_invoker = true (enforces RLS).
--   - ZERO PUBLIC / anon privileges on any view or function.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- 2. render_versions.storage_provider (Phase 2 Dual-Path R2 Default)
-- -----------------------------------------------------------------------------

ALTER TABLE public.render_versions
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'r2';

ALTER TABLE public.render_versions
    ALTER COLUMN storage_provider SET DEFAULT 'r2';

ALTER TABLE public.render_versions
    DROP CONSTRAINT IF EXISTS render_versions_storage_provider_check;

ALTER TABLE public.render_versions
    ADD CONSTRAINT render_versions_storage_provider_check
    CHECK (storage_provider IN ('supabase', 'r2'));

-- Update get_prunable_render_versions to preserve Supabase Free LRU cap on
-- legacy 'supabase' renders while enforcing 90-day retention on 'r2' renders
-- and pruning expired/superseded renders across both providers.
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
            NOW() - INTERVAL '90 days' AS r2_retention_cutoff_ts,
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
    r2_retention_candidates AS (
        SELECT
            rv.id,
            rv.agency_id,
            rv.listing_id,
            rv.version_num,
            rv.storage_object_path,
            rv.storage_provider,
            'R2_90D_RETENTION'::TEXT AS prune_reason,
            rv.created_at,
            2 AS priority_order
        FROM public.render_versions rv
        CROSS JOIN params p
        WHERE rv.storage_pruned_at IS NULL
          AND NULLIF(BTRIM(rv.storage_object_path), '') IS NOT NULL
          AND rv.storage_provider = 'r2'
          AND rv.created_at < p.r2_retention_cutoff_ts
          AND NOT EXISTS (
              SELECT 1 FROM expired_candidates ec WHERE ec.id = rv.id
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
            3 AS priority_order
        FROM active_ranked ar
        CROSS JOIN params p
        WHERE ar.recency_rank > p.keep_limit
    ),
    combined AS (
        SELECT * FROM expired_candidates
        UNION ALL
        SELECT * FROM r2_retention_candidates
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
-- 3. Composite & pg_trgm GIN Pagination Indexes (< 300 ms Server Pagination)
-- -----------------------------------------------------------------------------

-- listings composite indexes
CREATE INDEX IF NOT EXISTS idx_listings_agency_created
    ON public.listings (agency_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listings_agency_editorial_created
    ON public.listings (agency_id, editorial_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listings_agency_niche_created
    ON public.listings (agency_id, canonical_niche, created_at DESC);

-- listings pg_trgm search indexes
CREATE INDEX IF NOT EXISTS idx_listings_title_trgm
    ON public.listings USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_listings_address_trgm
    ON public.listings USING GIN (address gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_listings_location_trgm
    ON public.listings USING GIN (location gin_trgm_ops);

-- buyer_leads composite & pg_trgm search indexes
CREATE INDEX IF NOT EXISTS idx_buyer_leads_agency_stage
    ON public.buyer_leads (agency_id, stage, next_followup_at);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_agency_updated
    ON public.buyer_leads (agency_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_client_name_trgm
    ON public.buyer_leads USING GIN (client_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_phone_trgm
    ON public.buyer_leads USING GIN (phone_normalized gin_trgm_ops);

-- render_versions, publications, pipeline_jobs pagination/pruning helpers
CREATE INDEX IF NOT EXISTS idx_render_versions_storage_provider_prune
    ON public.render_versions (storage_provider, created_at ASC)
    WHERE storage_pruned_at IS NULL AND storage_object_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_publications_agency_published_desc
    ON public.publications (agency_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_agency_status_created
    ON public.pipeline_jobs (agency_id, status, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Dynamic District Price Medians View (60-Day Rolling Median AZN/m2)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.district_price_medians
WITH (security_invoker = true)
AS
SELECT
    l.agency_id,
    LOWER(BTRIM(COALESCE(NULLIF(BTRIM(l.district_normalized), ''), NULLIF(BTRIM(l.location), ''), 'unknown'))) AS district_normalized,
    COUNT(*)::INT AS sample_count,
    ROUND(
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (l.price_azn_normalized / NULLIF(l.area, 0))))::NUMERIC,
        2
    ) AS median_azn_per_m2,
    ROUND(
        (PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY (l.price_azn_normalized / NULLIF(l.area, 0))))::NUMERIC,
        2
    ) AS p25_azn_per_m2,
    ROUND(
        (PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY (l.price_azn_normalized / NULLIF(l.area, 0))))::NUMERIC,
        2
    ) AS p75_azn_per_m2,
    ROUND(AVG(l.price_azn_normalized)::NUMERIC, 2) AS avg_price_azn,
    MAX(COALESCE(l.last_seen_at, l.created_at)) AS latest_seen_at
FROM public.listings l
WHERE l.source_availability = 'ACTIVE'
  AND l.duplicate_resolution <> 'CONFIRMED_DUPLICATE'
  AND l.price_azn_normalized > 0
  AND l.area IS NOT NULL
  AND l.area > 0
  AND COALESCE(l.last_seen_at, l.created_at) >= NOW() - INTERVAL '60 days'
  AND COALESCE(NULLIF(BTRIM(l.district_normalized), ''), NULLIF(BTRIM(l.location), '')) IS NOT NULL
GROUP BY
    l.agency_id,
    LOWER(BTRIM(COALESCE(NULLIF(BTRIM(l.district_normalized), ''), NULLIF(BTRIM(l.location), ''), 'unknown')));

-- -----------------------------------------------------------------------------
-- 5. SQL RPC: public.get_agency_crm_kpis() RETURNS JSONB
--    Auth-derived tenant & role scoping with commission_split_pct weighting.
--    ADMIN: agency-wide totals + per-broker breakdown.
--    BROKER: own assigned_agent_id = auth.uid() totals only.
--    SMM: rejected (403 FORBIDDEN_SMM_NO_CRM_ACCESS).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_agency_crm_kpis()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_role TEXT := public.current_agency_role();
    v_is_admin BOOLEAN;
    v_self_split NUMERIC(5, 2) := 50.00;
    v_total_leads INT := 0;
    v_active_leads INT := 0;
    v_won_leads INT := 0;
    v_lost_leads INT := 0;
    v_overdue_followups INT := 0;
    v_open_tasks INT := 0;
    v_expected_total NUMERIC(14, 2) := 0;
    v_expected_broker NUMERIC(14, 2) := 0;
    v_expected_agency NUMERIC(14, 2) := 0;
    v_actual_total NUMERIC(14, 2) := 0;
    v_actual_broker NUMERIC(14, 2) := 0;
    v_actual_agency NUMERIC(14, 2) := 0;
    v_stage_counts JSONB;
    v_by_broker JSONB;
BEGIN
    IF v_uid IS NULL OR v_agency_id IS NULL OR v_role IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status_code', 403,
            'error', 'FORBIDDEN_INACTIVE_OR_NO_AGENCY'
        );
    END IF;

    IF v_role = 'SMM' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status_code', 403,
            'error', 'FORBIDDEN_SMM_NO_CRM_ACCESS'
        );
    END IF;

    v_is_admin := (v_role = 'ADMIN');

    SELECT COALESCE(am.commission_split_pct, 50.00)
      INTO v_self_split
      FROM public.agency_members am
     WHERE am.user_id = v_uid
       AND am.agency_id = v_agency_id
       AND am.is_active = TRUE
     LIMIT 1;

    v_self_split := COALESCE(v_self_split, 50.00);

    WITH scoped_leads AS (
        SELECT
            bl.id,
            bl.stage,
            bl.assigned_agent_id,
            COALESCE(bl.expected_commission_azn, 0)::NUMERIC AS expected_comm,
            COALESCE(bl.actual_commission_azn, 0)::NUMERIC AS actual_comm,
            bl.next_followup_at,
            COALESCE(am.commission_split_pct, 50.00)::NUMERIC AS split_pct,
            COALESCE(am.display_name, 'Təyin edilməyib') AS broker_name
        FROM public.buyer_leads bl
        LEFT JOIN public.agency_members am
          ON am.user_id = bl.assigned_agent_id
         AND am.agency_id = bl.agency_id
        WHERE bl.agency_id = v_agency_id
          AND (v_is_admin OR bl.assigned_agent_id = v_uid)
    )
    SELECT
        COUNT(*)::INT,
        COUNT(*) FILTER (WHERE stage NOT IN ('WON_CLOSED', 'LOST', 'COLD'))::INT,
        COUNT(*) FILTER (WHERE stage = 'WON_CLOSED')::INT,
        COUNT(*) FILTER (WHERE stage IN ('LOST', 'COLD'))::INT,
        COUNT(*) FILTER (
            WHERE stage NOT IN ('WON_CLOSED', 'LOST', 'COLD')
              AND next_followup_at IS NOT NULL
              AND next_followup_at < NOW()
        )::INT,
        ROUND(COALESCE(SUM(expected_comm) FILTER (WHERE stage NOT IN ('LOST', 'COLD')), 0), 2),
        ROUND(COALESCE(SUM(expected_comm * (split_pct / 100.0)) FILTER (WHERE stage NOT IN ('LOST', 'COLD')), 0), 2),
        ROUND(COALESCE(SUM(expected_comm * ((100.0 - split_pct) / 100.0)) FILTER (WHERE stage NOT IN ('LOST', 'COLD')), 0), 2),
        ROUND(COALESCE(SUM(actual_comm) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2),
        ROUND(COALESCE(SUM(actual_comm * (split_pct / 100.0)) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2),
        ROUND(COALESCE(SUM(actual_comm * ((100.0 - split_pct) / 100.0)) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2),
        jsonb_build_object(
            'NEW_INQUIRY', COUNT(*) FILTER (WHERE stage = 'NEW_INQUIRY'),
            'QUALIFIED', COUNT(*) FILTER (WHERE stage = 'QUALIFIED'),
            'VIEWING_SCHEDULED', COUNT(*) FILTER (WHERE stage = 'VIEWING_SCHEDULED'),
            'VIEWED', COUNT(*) FILTER (WHERE stage = 'VIEWED'),
            'NEGOTIATING', COUNT(*) FILTER (WHERE stage = 'NEGOTIATING'),
            'DEPOSIT', COUNT(*) FILTER (WHERE stage = 'DEPOSIT'),
            'WON_CLOSED', COUNT(*) FILTER (WHERE stage = 'WON_CLOSED'),
            'LOST', COUNT(*) FILTER (WHERE stage = 'LOST'),
            'COLD', COUNT(*) FILTER (WHERE stage = 'COLD')
        )
    INTO
        v_total_leads,
        v_active_leads,
        v_won_leads,
        v_lost_leads,
        v_overdue_followups,
        v_expected_total,
        v_expected_broker,
        v_expected_agency,
        v_actual_total,
        v_actual_broker,
        v_actual_agency,
        v_stage_counts
    FROM scoped_leads;

    SELECT COUNT(*)::INT
      INTO v_open_tasks
      FROM public.follow_up_tasks ft
     WHERE ft.agency_id = v_agency_id
       AND ft.status IN ('OPEN', 'SNOOZED')
       AND (v_is_admin OR ft.assigned_agent_id = v_uid);

    WITH scoped_leads AS (
        SELECT
            bl.assigned_agent_id,
            COALESCE(am.display_name, 'Təyin edilməyib') AS display_name,
            COALESCE(am.commission_split_pct, 50.00)::NUMERIC AS split_pct,
            bl.stage,
            COALESCE(bl.expected_commission_azn, 0)::NUMERIC AS expected_comm,
            COALESCE(bl.actual_commission_azn, 0)::NUMERIC AS actual_comm
        FROM public.buyer_leads bl
        LEFT JOIN public.agency_members am
          ON am.user_id = bl.assigned_agent_id
         AND am.agency_id = bl.agency_id
        WHERE bl.agency_id = v_agency_id
          AND (v_is_admin OR bl.assigned_agent_id = v_uid)
    ),
    grouped AS (
        SELECT
            assigned_agent_id AS user_id,
            display_name,
            split_pct AS commission_split_pct,
            COUNT(*)::INT AS lead_count,
            COUNT(*) FILTER (WHERE stage = 'WON_CLOSED')::INT AS won_count,
            ROUND(COALESCE(SUM(expected_comm) FILTER (WHERE stage NOT IN ('LOST', 'COLD')), 0), 2) AS expected_total_azn,
            ROUND(COALESCE(SUM(expected_comm * (split_pct / 100.0)) FILTER (WHERE stage NOT IN ('LOST', 'COLD')), 0), 2) AS expected_broker_azn,
            ROUND(COALESCE(SUM(expected_comm * ((100.0 - split_pct) / 100.0)) FILTER (WHERE stage NOT IN ('LOST', 'COLD')), 0), 2) AS expected_agency_azn,
            ROUND(COALESCE(SUM(actual_comm) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2) AS actual_total_azn,
            ROUND(COALESCE(SUM(actual_comm * (split_pct / 100.0)) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2) AS actual_broker_azn,
            ROUND(COALESCE(SUM(actual_comm * ((100.0 - split_pct) / 100.0)) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2) AS actual_agency_azn
        FROM scoped_leads
        GROUP BY assigned_agent_id, display_name, split_pct
        ORDER BY actual_total_azn DESC, expected_total_azn DESC, lead_count DESC
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
      INTO v_by_broker
      FROM grouped g;

    RETURN jsonb_build_object(
        'ok', true,
        'agency_id', v_agency_id,
        'role_scope', v_role,
        'broker_split_pct', v_self_split,
        'total_leads', v_total_leads,
        'active_leads', v_active_leads,
        'won_leads', v_won_leads,
        'lost_leads', v_lost_leads,
        'overdue_followups', v_overdue_followups,
        'open_tasks', v_open_tasks,
        'stage_counts', v_stage_counts,
        'expected_commission_total_azn', v_expected_total,
        'expected_broker_commission_azn', v_expected_broker,
        'expected_agency_commission_azn', v_expected_agency,
        'actual_commission_total_azn', v_actual_total,
        'actual_broker_commission_azn', v_actual_broker,
        'actual_agency_commission_azn', v_actual_agency,
        'by_broker', v_by_broker,
        'generated_at', NOW()
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. SQL RPC: public.get_analytics_summary(p_days INT DEFAULT 30) RETURNS JSONB
--    Replaces unbounded 7-table client scans on /analytics with indexed SQL
--    aggregates across publications, comments, renders, snapshots, and RBAC-
--    scoped leads/timeline events.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_analytics_summary(
    p_days INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_agency_id UUID := public.current_agency_id();
    v_role TEXT := public.current_agency_role();
    v_days INT := LEAST(365, GREATEST(1, COALESCE(p_days, 30)));
    v_since TIMESTAMPTZ := NOW() - make_interval(days => v_days);
    v_leads_restricted BOOLEAN := FALSE;
    v_totals JSONB;
    v_funnel JSONB;
    v_by_niche JSONB;
    v_by_hook_type JSONB;
    v_by_duration_bucket JSONB;
BEGIN
    IF v_uid IS NULL OR v_agency_id IS NULL OR v_role IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status_code', 403,
            'error', 'FORBIDDEN_INACTIVE_OR_NO_AGENCY'
        );
    END IF;

    -- SMM role has zero access to buyer_leads / commission financials
    v_leads_restricted := (v_role = 'SMM');

    WITH scoped_pubs AS (
        SELECT
            p.id,
            COALESCE(p.channel_niche, 'GENERAL') AS niche,
            COALESCE(p.views_count, 0)::BIGINT AS views_count,
            COALESCE(p.likes_count, 0)::BIGINT AS likes_count,
            COALESCE(p.comments_count, 0)::BIGINT AS comments_count,
            COALESCE(p.shares_count, 0)::BIGINT AS shares_count,
            p.render_version_id,
            rv.hook_type,
            rv.duration_bucket
        FROM public.publications p
        LEFT JOIN public.render_versions rv
          ON rv.id = p.render_version_id
         AND rv.agency_id = p.agency_id
        WHERE p.agency_id = v_agency_id
          AND COALESCE(p.published_at, p.created_at) >= v_since
    ),
    scoped_comments AS (
        SELECT
            sc.id,
            sc.publication_id,
            COALESCE(p.channel_niche, 'GENERAL') AS niche,
            (sc.is_intent_lead OR sc.buyer_lead_id IS NOT NULL) AS is_intent
        FROM public.social_comments sc
        JOIN public.publications p
          ON p.id = sc.publication_id
         AND p.agency_id = v_agency_id
        WHERE sc.agency_id = v_agency_id
          AND sc.created_at >= v_since
    ),
    pub_intent_counts AS (
        SELECT
            publication_id,
            COUNT(*) FILTER (WHERE is_intent)::INT AS intent_leads
        FROM scoped_comments
        GROUP BY publication_id
    ),
    scoped_snapshots AS (
        SELECT COUNT(*)::INT AS snapshots_count
        FROM public.publication_telemetry_snapshots pts
        WHERE pts.agency_id = v_agency_id
          AND pts.captured_at >= v_since
    ),
    scoped_leads AS (
        SELECT
            bl.id,
            COALESCE(
                NULLIF(BTRIM(bl.attributed_channel_niche), ''),
                p.channel_niche,
                'GENERAL'
            ) AS niche,
            bl.stage,
            COALESCE(bl.actual_commission_azn, 0)::NUMERIC AS actual_commission_azn
        FROM public.buyer_leads bl
        LEFT JOIN public.publications p
          ON p.id = bl.attributed_publication_id
         AND p.agency_id = bl.agency_id
        WHERE NOT v_leads_restricted
          AND bl.agency_id = v_agency_id
          AND bl.created_at >= v_since
          AND (v_role = 'ADMIN' OR bl.assigned_agent_id = v_uid)
    ),
    scoped_showing_events AS (
        SELECT
            COALESCE(sl.niche, 'GENERAL') AS niche,
            COUNT(*)::INT AS showing_events_count
        FROM public.lead_timeline_events lte
        LEFT JOIN scoped_leads sl ON sl.id = lte.lead_id
        WHERE NOT v_leads_restricted
          AND lte.agency_id = v_agency_id
          AND lte.event_type = 'SHOWING_SCHEDULED'
          AND lte.created_at >= v_since
          AND (v_role = 'ADMIN' OR sl.id IS NOT NULL)
        GROUP BY COALESCE(sl.niche, 'GENERAL')
    ),
    pub_totals AS (
        SELECT
            COUNT(*)::INT AS publications_count,
            COALESCE(SUM(views_count), 0)::BIGINT AS views_count,
            COALESCE(SUM(likes_count), 0)::BIGINT AS likes_count,
            COALESCE(SUM(comments_count), 0)::BIGINT AS comments_count,
            COALESCE(SUM(shares_count), 0)::BIGINT AS shares_count,
            COALESCE(SUM(likes_count + comments_count + shares_count), 0)::BIGINT AS interactions_count
        FROM scoped_pubs
    ),
    comment_totals AS (
        SELECT
            COUNT(*)::INT AS scraped_comments_count,
            COUNT(*) FILTER (WHERE is_intent)::INT AS intent_comments_count
        FROM scoped_comments
    ),
    lead_totals AS (
        SELECT
            COUNT(*)::INT AS leads_count,
            COUNT(*) FILTER (
                WHERE stage IN ('VIEWING_SCHEDULED', 'VIEWED', 'NEGOTIATING', 'DEPOSIT', 'WON_CLOSED')
            )::INT AS showings_from_leads,
            COUNT(*) FILTER (WHERE stage = 'WON_CLOSED')::INT AS won_count,
            ROUND(COALESCE(SUM(actual_commission_azn) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2) AS actual_commission_azn
        FROM scoped_leads
    ),
    showing_event_total AS (
        SELECT COALESCE(SUM(showing_events_count), 0)::INT AS total_showing_events
        FROM scoped_showing_events
    ),
    agg_totals AS (
        SELECT
            pt.publications_count,
            pt.views_count,
            pt.likes_count,
            pt.comments_count,
            pt.shares_count,
            pt.interactions_count,
            CASE
                WHEN pt.views_count > 0
                    THEN ROUND((pt.interactions_count::NUMERIC / pt.views_count::NUMERIC) * 100.0, 2)
                ELSE 0
            END AS engagement_rate_pct,
            ct.scraped_comments_count,
            ct.intent_comments_count,
            ss.snapshots_count,
            lt.leads_count,
            GREATEST(lt.showings_from_leads, setot.total_showing_events)::INT AS showings_count,
            lt.won_count,
            lt.actual_commission_azn
        FROM pub_totals pt
        CROSS JOIN comment_totals ct
        CROSS JOIN scoped_snapshots ss
        CROSS JOIN lead_totals lt
        CROSS JOIN showing_event_total setot
    ),
    niches(niche, baseline_median) AS (
        VALUES
            ('LUXURY', 800),
            ('AFFORDABLE', 4500),
            ('GENERAL', 2200),
            ('TIKTOK', 12000)
    ),
    niche_pubs AS (
        SELECT
            niche,
            COUNT(*)::INT AS publications_count,
            COALESCE(SUM(views_count), 0)::BIGINT AS views_count,
            COALESCE(SUM(likes_count), 0)::BIGINT AS likes_count,
            COALESCE(SUM(comments_count), 0)::BIGINT AS comments_count,
            COALESCE(SUM(shares_count), 0)::BIGINT AS shares_count,
            COALESCE(SUM(likes_count + comments_count + shares_count), 0)::BIGINT AS interactions_count,
            COUNT(*) FILTER (WHERE views_count > 0)::INT AS positive_view_pubs,
            ROUND(
                (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY views_count) FILTER (WHERE views_count > 0))::NUMERIC,
                0
            ) AS computed_median_views
        FROM scoped_pubs
        GROUP BY niche
    ),
    niche_comments AS (
        SELECT
            niche,
            COUNT(*) FILTER (WHERE is_intent)::INT AS intent_comments_count
        FROM scoped_comments
        GROUP BY niche
    ),
    niche_leads AS (
        SELECT
            niche,
            COUNT(*)::INT AS leads_count,
            COUNT(*) FILTER (
                WHERE stage IN ('VIEWING_SCHEDULED', 'VIEWED', 'NEGOTIATING', 'DEPOSIT', 'WON_CLOSED')
            )::INT AS showings_from_leads,
            COUNT(*) FILTER (WHERE stage = 'WON_CLOSED')::INT AS won_count,
            ROUND(COALESCE(SUM(actual_commission_azn) FILTER (WHERE stage = 'WON_CLOSED'), 0), 2) AS actual_commission_azn
        FROM scoped_leads
        GROUP BY niche
    ),
    niche_json AS (
        SELECT jsonb_object_agg(
            n.niche,
            jsonb_build_object(
                'publications_count', COALESCE(np.publications_count, 0),
                'views_count', COALESCE(np.views_count, 0),
                'likes_count', COALESCE(np.likes_count, 0),
                'comments_count', COALESCE(np.comments_count, 0),
                'shares_count', COALESCE(np.shares_count, 0),
                'interactions_count', COALESCE(np.interactions_count, 0),
                'engagement_rate_pct', CASE
                    WHEN COALESCE(np.views_count, 0) > 0
                        THEN ROUND((COALESCE(np.interactions_count, 0)::NUMERIC / np.views_count::NUMERIC) * 100.0, 2)
                    ELSE 0
                END,
                'median_views', CASE
                    WHEN COALESCE(np.positive_view_pubs, 0) >= 5 AND np.computed_median_views IS NOT NULL
                        THEN np.computed_median_views::INT
                    ELSE n.baseline_median
                END,
                'intent_comments_count', COALESCE(nc.intent_comments_count, 0),
                'leads_count', COALESCE(nl.leads_count, 0),
                'showings_count', GREATEST(COALESCE(nl.showings_from_leads, 0), COALESCE(nse.showing_events_count, 0)),
                'won_count', COALESCE(nl.won_count, 0),
                'actual_commission_azn', COALESCE(nl.actual_commission_azn, 0)
            )
        ) AS val
        FROM niches n
        LEFT JOIN niche_pubs np ON np.niche = n.niche
        LEFT JOIN niche_comments nc ON nc.niche = n.niche
        LEFT JOIN niche_leads nl ON nl.niche = n.niche
        LEFT JOIN scoped_showing_events nse ON nse.niche = n.niche
    ),
    hooks(hook_type) AS (
        VALUES ('PRICE_FIRST'), ('LOCATION_FIRST'), ('LUXURY_LIFESTYLE')
    ),
    hook_stats AS (
        SELECT
            sp.hook_type,
            COUNT(*)::INT AS cnt,
            COALESCE(SUM(sp.views_count), 0)::BIGINT AS total_views,
            ROUND(COALESCE(AVG(sp.views_count), 0), 0)::BIGINT AS avg_views,
            COALESCE(SUM(COALESCE(pic.intent_leads, 0)), 0)::INT AS intent_leads,
            ROUND(COALESCE(AVG(COALESCE(pic.intent_leads, 0)), 0), 2) AS avg_leads
        FROM scoped_pubs sp
        LEFT JOIN pub_intent_counts pic ON pic.publication_id = sp.id
        WHERE sp.hook_type IS NOT NULL
        GROUP BY sp.hook_type
    ),
    hook_json AS (
        SELECT jsonb_object_agg(
            h.hook_type,
            jsonb_build_object(
                'count', COALESCE(hs.cnt, 0),
                'total_views', COALESCE(hs.total_views, 0),
                'avg_views', COALESCE(hs.avg_views, 0),
                'intent_leads', COALESCE(hs.intent_leads, 0),
                'avg_leads', COALESCE(hs.avg_leads, 0)
            )
        ) AS val
        FROM hooks h
        LEFT JOIN hook_stats hs ON hs.hook_type = h.hook_type
    ),
    buckets(duration_bucket) AS (
        VALUES ('SHORT_25_30'), ('LONG_40_50')
    ),
    bucket_stats AS (
        SELECT
            sp.duration_bucket,
            COUNT(*)::INT AS cnt,
            COALESCE(SUM(sp.views_count), 0)::BIGINT AS total_views,
            ROUND(COALESCE(AVG(sp.views_count), 0), 0)::BIGINT AS avg_views,
            COALESCE(SUM(COALESCE(pic.intent_leads, 0)), 0)::INT AS intent_leads,
            ROUND(COALESCE(AVG(COALESCE(pic.intent_leads, 0)), 0), 2) AS avg_leads
        FROM scoped_pubs sp
        LEFT JOIN pub_intent_counts pic ON pic.publication_id = sp.id
        WHERE sp.duration_bucket IS NOT NULL
        GROUP BY sp.duration_bucket
    ),
    bucket_json AS (
        SELECT jsonb_object_agg(
            b.duration_bucket,
            jsonb_build_object(
                'count', COALESCE(bs.cnt, 0),
                'total_views', COALESCE(bs.total_views, 0),
                'avg_views', COALESCE(bs.avg_views, 0),
                'intent_leads', COALESCE(bs.intent_leads, 0),
                'avg_leads', COALESCE(bs.avg_leads, 0)
            )
        ) AS val
        FROM buckets b
        LEFT JOIN bucket_stats bs ON bs.duration_bucket = b.duration_bucket
    )
    SELECT
        jsonb_build_object(
            'publications_count', a.publications_count,
            'views_count', a.views_count,
            'likes_count', a.likes_count,
            'comments_count', a.comments_count,
            'shares_count', a.shares_count,
            'interactions_count', a.interactions_count,
            'engagement_rate_pct', a.engagement_rate_pct,
            'scraped_comments_count', a.scraped_comments_count,
            'intent_comments_count', a.intent_comments_count,
            'snapshots_count', a.snapshots_count,
            'leads_count', a.leads_count,
            'showings_count', a.showings_count,
            'won_count', a.won_count,
            'actual_commission_azn', a.actual_commission_azn
        ),
        jsonb_build_object(
            'views', a.views_count,
            'interactions', a.interactions_count,
            'intent_comments', a.intent_comments_count,
            'leads_count', a.leads_count,
            'showings_count', a.showings_count,
            'won_count', a.won_count,
            'actual_commission_azn', a.actual_commission_azn,
            'view_to_engagement_pct', CASE
                WHEN a.views_count > 0 THEN ROUND((a.interactions_count::NUMERIC / a.views_count::NUMERIC) * 100.0, 1)
                ELSE 0
            END,
            'engagement_to_lead_pct', CASE
                WHEN a.interactions_count > 0 THEN ROUND((a.leads_count::NUMERIC / a.interactions_count::NUMERIC) * 100.0, 1)
                ELSE 0
            END,
            'lead_to_showing_pct', CASE
                WHEN a.leads_count > 0 THEN ROUND((a.showings_count::NUMERIC / a.leads_count::NUMERIC) * 100.0, 1)
                ELSE 0
            END,
            'showing_to_won_pct', CASE
                WHEN a.showings_count > 0 THEN ROUND((a.won_count::NUMERIC / a.showings_count::NUMERIC) * 100.0, 1)
                ELSE 0
            END
        ),
        nj.val,
        hj.val,
        bj.val
    INTO
        v_totals,
        v_funnel,
        v_by_niche,
        v_by_hook_type,
        v_by_duration_bucket
    FROM agg_totals a
    CROSS JOIN niche_json nj
    CROSS JOIN hook_json hj
    CROSS JOIN bucket_json bj;

    RETURN jsonb_build_object(
        'ok', true,
        'agency_id', v_agency_id,
        'role_scope', v_role,
        'leads_restricted', v_leads_restricted,
        'window_days', v_days,
        'since_ts', v_since,
        'totals', v_totals,
        'funnel', v_funnel,
        'by_niche', v_by_niche,
        'by_hook_type', v_by_hook_type,
        'by_duration_bucket', v_by_duration_bucket,
        'generated_at', NOW()
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. pg_cron Schedule for cockpit-generator (08:00 Asia/Baku = 04:00 UTC)
-- -----------------------------------------------------------------------------

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
            WHERE jobname = 'baku_estate_cockpit_generator'
        LOOP
            PERFORM cron.unschedule(v_job_id);
        END LOOP;

        PERFORM cron.schedule(
            'baku_estate_cockpit_generator',
            '0 4 * * *',
            $cron$SELECT public.invoke_edge_function_cron('cockpit-generator');$cron$
        );
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Explicit Privileges (Zero PUBLIC / anon)
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE public.district_price_medians FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.district_price_medians TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_prunable_render_versions(INT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_prunable_render_versions(INT, INT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.get_agency_crm_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agency_crm_kpis() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_analytics_summary(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_analytics_summary(INT) TO authenticated, service_role;
