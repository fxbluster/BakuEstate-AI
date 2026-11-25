-- =============================================================================
-- BakuEstate-AI v2 Phase 3: Official Social OAuth Vault RPCs, Comment Dedup,
-- Smart Buyer-Listing Matching & Pipeline Social Publishing Schema
-- Migration: 202611260004_v2_p2_social_and_matching.sql
--
-- Depends on:
--   - 202611260001_v2_baseline_and_rbac.sql
--   - 202611260002_v2_p0_atomic_rpcs.sql
--   - 202611260003_v2_p1_cloud_studio_and_pagination.sql
--
-- Security model:
--   - Vault RPCs (store_social_secret, read_social_secret) are service_role ONLY.
--   - social_accounts remains service_role ONLY (no client/anon/authenticated access).
--   - Client-callable RPCs derive tenant strictly from auth.uid() via
--     current_agency_id() when auth.role() <> 'service_role'.
--   - ZERO PUBLIC / anon privileges anywhere.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions & Social Accounts / Publications / Pipeline Jobs Extensions
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'supabase_vault') THEN
        CREATE EXTENSION IF NOT EXISTS supabase_vault;
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.social_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('INSTAGRAM', 'TIKTOK')),
    account_handle TEXT NOT NULL,
    external_account_id TEXT NULL,
    vault_secret_id UUID NULL,
    refresh_vault_secret_id UUID NULL,
    token_expires_at TIMESTAMPTZ NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_social_accounts_agency_platform_handle UNIQUE (agency_id, platform, account_handle)
);

ALTER TABLE public.social_accounts
    ADD COLUMN IF NOT EXISTS refresh_vault_secret_id UUID NULL,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE public.social_accounts
    DROP CONSTRAINT IF EXISTS social_accounts_status_check;

ALTER TABLE public.social_accounts
    ADD CONSTRAINT social_accounts_status_check
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'RECONNECT_REQUIRED', 'INACTIVE'));

CREATE INDEX IF NOT EXISTS idx_social_accounts_expiring
    ON public.social_accounts (platform, token_expires_at ASC)
    WHERE status = 'ACTIVE' AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_social_accounts_external
    ON public.social_accounts (platform, external_account_id)
    WHERE external_account_id IS NOT NULL;

REVOKE ALL ON TABLE public.social_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.social_accounts TO service_role;
ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

-- Fast lookup of external Meta/TikTok post IDs on webhooks & telemetry sync
CREATE INDEX IF NOT EXISTS idx_publications_channel_ext_post
    ON public.publications (channel, external_post_id)
    WHERE external_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_publications_external_post_id
    ON public.publications (external_post_id)
    WHERE external_post_id IS NOT NULL;

-- Ensure pipeline_jobs.job_type includes 'PUBLISH_SOCIAL'
ALTER TABLE public.pipeline_jobs
    DROP CONSTRAINT IF EXISTS pipeline_jobs_job_type_check;

ALTER TABLE public.pipeline_jobs
    ADD CONSTRAINT pipeline_jobs_job_type_check
    CHECK (job_type IN (
        'SCRAPE_NEW',
        'RENDER_INITIAL',
        'RENDER_PRICE_DROP',
        'RERENDER',
        'LIVENESS_CHECK',
        'SYNC_SOCIAL_METRICS',
        'PREFLIGHT_CHECK',
        'TELEGRAM_DISPATCH',
        'PUBLISH_SOCIAL'
    ));

-- Ensure social_comments has deterministic dedup unique constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_social_comments_platform_id'
          AND conrelid = 'public.social_comments'::regclass
    ) THEN
        ALTER TABLE public.social_comments
            ADD CONSTRAINT uq_social_comments_platform_id UNIQUE (publication_id, platform_comment_id);
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Smart Buyer <-> Listing Matches Table & Dispatch Index
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lead_listing_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    match_score INT NOT NULL CHECK (match_score BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'NOTIFIED', 'DISMISSED')),
    notified_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_lead_listing_matches_pair UNIQUE (lead_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_listing_matches_agency_status
    ON public.lead_listing_matches (agency_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_listing_matches_new_dispatch
    ON public.lead_listing_matches (agency_id, created_at ASC)
    WHERE status = 'NEW';

-- -----------------------------------------------------------------------------
-- 3. Service-Role-Only Supabase Vault Wrapper RPCs
--    Never expose vault schema directly over PostgREST.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.store_social_secret(
    p_name TEXT,
    p_secret TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
    v_name TEXT := NULLIF(BTRIM(p_name), '');
    v_existing_id UUID;
    v_secret_id UUID;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'FORBIDDEN_SERVICE_ROLE_ONLY';
    END IF;

    IF p_secret IS NULL OR BTRIM(p_secret) = '' THEN
        RAISE EXCEPTION 'SECRET_VALUE_REQUIRED';
    END IF;

    IF v_name IS NOT NULL THEN
        SELECT s.id
          INTO v_existing_id
          FROM vault.secrets s
         WHERE s.name = v_name
         LIMIT 1;
    END IF;

    IF v_existing_id IS NOT NULL THEN
        PERFORM vault.update_secret(
            v_existing_id,
            p_secret,
            v_name,
            'BakuEstate-AI social OAuth token'
        );
        RETURN v_existing_id;
    END IF;

    v_secret_id := vault.create_secret(
        p_secret,
        v_name,
        'BakuEstate-AI social OAuth token'
    );
    RETURN v_secret_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_social_secret(
    p_secret_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
    v_secret TEXT;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'FORBIDDEN_SERVICE_ROLE_ONLY';
    END IF;

    IF p_secret_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT ds.decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets ds
     WHERE ds.id = p_secret_id
     LIMIT 1;

    RETURN v_secret;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Atomic Idempotent Social Comment Dedup RPC
--    Returns (comment_id UUID, is_new BOOLEAN) so callers only trigger lead/alert
--    side-effects once per (publication_id, platform_comment_id).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_social_comment_returning_is_new(
    p_agency_id UUID,
    p_publication_id UUID,
    p_platform_comment_id TEXT,
    p_author_handle TEXT,
    p_comment_text TEXT,
    p_like_count INT DEFAULT 0,
    p_is_intent_lead BOOLEAN DEFAULT FALSE,
    p_intent_category TEXT DEFAULT NULL,
    p_intent_confidence REAL DEFAULT NULL,
    p_suggested_reply TEXT DEFAULT NULL,
    p_buyer_lead_id UUID DEFAULT NULL
)
RETURNS TABLE (
    comment_id UUID,
    is_new BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_caller_agency_id UUID;
    v_pub_agency_id UUID;
    v_agency_id UUID;
    v_platform_comment_id TEXT := NULLIF(BTRIM(p_platform_comment_id), '');
    v_inserted_id UUID;
    v_existing_id UUID;
BEGIN
    IF p_publication_id IS NULL OR v_platform_comment_id IS NULL THEN
        RAISE EXCEPTION 'PUBLICATION_AND_COMMENT_ID_REQUIRED';
    END IF;

    SELECT p.agency_id
      INTO v_pub_agency_id
      FROM public.publications p
     WHERE p.id = p_publication_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUBLICATION_NOT_FOUND';
    END IF;

    IF NOT v_is_service THEN
        v_caller_agency_id := public.current_agency_id();
        IF v_caller_agency_id IS NULL
           OR v_caller_agency_id <> v_pub_agency_id
           OR NOT public.is_agency_smm_or_admin(v_pub_agency_id) THEN
            RAISE EXCEPTION 'FORBIDDEN_CROSS_AGENCY_OR_ROLE';
        END IF;
        v_agency_id := v_caller_agency_id;
    ELSE
        IF p_agency_id IS NOT NULL AND p_agency_id <> v_pub_agency_id THEN
            RAISE EXCEPTION 'AGENCY_MISMATCH_FOR_PUBLICATION';
        END IF;
        v_agency_id := v_pub_agency_id;
    END IF;

    INSERT INTO public.social_comments (
        agency_id,
        publication_id,
        platform_comment_id,
        author_handle,
        comment_text,
        like_count,
        is_intent_lead,
        intent_category,
        intent_confidence,
        suggested_reply,
        buyer_lead_id
    )
    VALUES (
        v_agency_id,
        p_publication_id,
        v_platform_comment_id,
        COALESCE(NULLIF(BTRIM(p_author_handle), ''), 'unknown'),
        COALESCE(p_comment_text, ''),
        GREATEST(0, COALESCE(p_like_count, 0)),
        COALESCE(p_is_intent_lead, FALSE),
        NULLIF(BTRIM(p_intent_category), ''),
        p_intent_confidence,
        NULLIF(BTRIM(p_suggested_reply), ''),
        p_buyer_lead_id
    )
    ON CONFLICT (publication_id, platform_comment_id) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
        RETURN QUERY SELECT v_inserted_id, TRUE;
        RETURN;
    END IF;

    SELECT sc.id
      INTO v_existing_id
      FROM public.social_comments sc
     WHERE sc.publication_id = p_publication_id
       AND sc.platform_comment_id = v_platform_comment_id
     LIMIT 1;

    RETURN QUERY SELECT v_existing_id, FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Smart Buyer <-> Listing Matching RPC (0-100 Score, >= 60 Threshold)
--    Supports both bina.az and OFF_MARKET active listings in a single set-based
--    INSERT ... ON CONFLICT DO NOTHING so 100+ matching leads never stall worker.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_listing_to_leads(
    p_listing_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_service BOOLEAN := (auth.role() = 'service_role');
    v_caller_agency_id UUID;
    v_listing RECORD;
    v_inserted_count INT := 0;
BEGIN
    IF p_listing_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT
        l.id,
        l.agency_id,
        COALESCE(l.price_azn_normalized, l.price, 0)::NUMERIC AS price_azn,
        LOWER(BTRIM(COALESCE(l.district_normalized, ''))) AS norm_district,
        LOWER(BTRIM(COALESCE(l.location, ''))) AS norm_location,
        LOWER(BTRIM(COALESCE(l.address, ''))) AS norm_address,
        l.rooms,
        COALESCE(l.has_bill_of_sale, FALSE) AS has_bill_of_sale,
        l.source_availability,
        l.editorial_status,
        l.duplicate_resolution
    INTO v_listing
    FROM public.listings l
    WHERE l.id = p_listing_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF NOT v_is_service THEN
        v_caller_agency_id := public.current_agency_id();
        IF v_caller_agency_id IS NULL
           OR v_caller_agency_id <> v_listing.agency_id
           OR NOT public.is_agency_broker_or_admin(v_listing.agency_id) THEN
            RAISE EXCEPTION 'FORBIDDEN_CROSS_AGENCY_OR_ROLE';
        END IF;
    END IF;

    IF v_listing.source_availability <> 'ACTIVE'
       OR v_listing.editorial_status IN ('REJECTED', 'ARCHIVED')
       OR v_listing.duplicate_resolution = 'CONFIRMED_DUPLICATE' THEN
        RETURN 0;
    END IF;

    WITH scored_leads AS (
        SELECT
            bl.id AS lead_id,
            bl.agency_id,
            (
                CASE
                    WHEN bl.budget_max_azn IS NOT NULL AND bl.budget_max_azn > 0 AND v_listing.price_azn > 0 THEN
                        CASE
                            WHEN v_listing.price_azn <= bl.budget_max_azn THEN 40
                            WHEN v_listing.price_azn <= (bl.budget_max_azn * 1.10) THEN 20
                            ELSE 0
                        END
                    ELSE 0
                END
                +
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM unnest(COALESCE(bl.preferred_districts, '{}'::TEXT[])) AS d(district_val)
                        WHERE NULLIF(BTRIM(d.district_val), '') IS NOT NULL
                          AND (
                              v_listing.norm_district LIKE '%' || LOWER(BTRIM(d.district_val)) || '%'
                              OR v_listing.norm_location LIKE '%' || LOWER(BTRIM(d.district_val)) || '%'
                              OR v_listing.norm_address LIKE '%' || LOWER(BTRIM(d.district_val)) || '%'
                          )
                    ) THEN 30
                    ELSE 0
                END
                +
                CASE
                    WHEN bl.min_rooms IS NOT NULL AND v_listing.rooms IS NOT NULL AND v_listing.rooms >= bl.min_rooms THEN 15
                    ELSE 0
                END
                +
                CASE
                    WHEN (NOT COALESCE(bl.requires_kupca, FALSE) OR v_listing.has_bill_of_sale) THEN 15
                    ELSE 0
                END
            )::INT AS match_score
        FROM public.buyer_leads bl
        WHERE bl.agency_id = v_listing.agency_id
          AND bl.stage NOT IN ('WON_CLOSED', 'LOST', 'COLD')
    )
    INSERT INTO public.lead_listing_matches (
        agency_id,
        lead_id,
        listing_id,
        match_score,
        status
    )
    SELECT
        s.agency_id,
        s.lead_id,
        v_listing.id,
        s.match_score,
        'NEW'
    FROM scored_leads s
    WHERE s.match_score >= 60
    ON CONFLICT (lead_id, listing_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
    RETURN v_inserted_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Explicit Function Privilege Assignments (Zero PUBLIC / anon)
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.store_social_secret(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_social_secret(TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.read_social_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_social_secret(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_social_comment_returning_is_new(UUID, UUID, TEXT, TEXT, TEXT, INT, BOOLEAN, TEXT, REAL, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_social_comment_returning_is_new(UUID, UUID, TEXT, TEXT, TEXT, INT, BOOLEAN, TEXT, REAL, TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.match_listing_to_leads(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_listing_to_leads(UUID) TO authenticated, service_role;
