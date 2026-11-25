-- =============================================================================
-- BakuEstate-AI v2: Isolated Baseline Schema, Multi-Agency RBAC & Zero-Anon RLS
-- Migration: 202611260001_v2_baseline_and_rbac.sql
--
-- Target: Fresh isolated BakuEstate-AI Supabase project (completely separate
-- from shared Citadel CRM project ejsaccbeatmwqodwwzwu).
--
-- Incorporates:
--   - Extensions: pgcrypto, pg_trgm, pg_cron, pg_net, supabase_vault (guarded)
--   - Full baseline BakuEstate tables (including DRAFT_READY, PASSED_WITH_DB_FALLBACK,
--     standalone v2 cockpit_cards, CANCELLED job status, agency tenancy)
--   - Multi-Agent RBAC: agencies, agency_members (ADMIN / BROKER / SMM),
--     agency_settings, listing_owner_contacts (PII isolation from SMM),
--     agent_messages (append-only seq_num), agency_ai_usage_monthly,
--     social_accounts, lead_listing_matches
--   - Complete REVOKE ALL FROM PUBLIC, anon across tables, views, sequences, functions
--   - Table x Role RLS matrix with active membership verification (is_active = TRUE)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
        CREATE EXTENSION IF NOT EXISTS pg_net;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'supabase_vault') THEN
        CREATE EXTENSION IF NOT EXISTS supabase_vault;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Internal Config & Trigger Utilities
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.baku_estate_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.baku_estate_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Multi-Agency Tenancy & Member RBAC Tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.agency_members (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'BROKER', 'SMM')),
    display_name TEXT NOT NULL CHECK (BTRIM(display_name) <> ''),
    whatsapp_phone TEXT NULL,
    telegram_chat_id TEXT NULL,
    commission_split_pct NUMERIC(5, 2) NOT NULL DEFAULT 50.00
        CHECK (commission_split_pct >= 0 AND commission_split_pct <= 100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_members_agency_role
    ON public.agency_members (agency_id, role, is_active);

CREATE TABLE IF NOT EXISTS public.agency_settings (
    agency_id UUID PRIMARY KEY REFERENCES public.agencies(id) ON DELETE CASCADE,
    public_phone TEXT NOT NULL DEFAULT '+994 50 000 00 00',
    telegram_chat_id TEXT NULL,
    niche_rules_json JSONB NOT NULL DEFAULT '{"luxury_min_azn":250000,"affordable_max_azn":120000,"viral_drop_pct":10}'::jsonb,
    social_api_mode TEXT NOT NULL DEFAULT 'TELEGRAM_FALLBACK'
        CHECK (social_api_mode IN ('OFFICIAL', 'TELEGRAM_FALLBACK')),
    watermark_preset_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    monthly_ai_budget_usd NUMERIC(10, 2) NOT NULL DEFAULT 50.00
        CHECK (monthly_ai_budget_usd >= 0),
    ai_rate_limit_rpm INT NOT NULL DEFAULT 20
        CHECK (ai_rate_limit_rpm >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_agency_settings_set_updated_at ON public.agency_settings;
CREATE TRIGGER trg_agency_settings_set_updated_at
    BEFORE UPDATE ON public.agency_settings
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. SECURITY DEFINER RBAC Helper Functions (Prevent RLS Recursion)
--    Always verify agency_members.is_active = TRUE.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_agency_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT am.agency_id
    FROM public.agency_members am
    WHERE am.user_id = auth.uid()
      AND am.is_active = TRUE
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_agency_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT am.role
    FROM public.agency_members am
    WHERE am.user_id = auth.uid()
      AND am.is_active = TRUE
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_agency_member(p_agency_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN TRUE;
    END IF;
    IF auth.role() <> 'authenticated' OR auth.uid() IS NULL OR p_agency_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM public.agency_members am
        WHERE am.user_id = auth.uid()
          AND am.agency_id = p_agency_id
          AND am.is_active = TRUE
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_agency_admin(p_agency_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN TRUE;
    END IF;
    IF auth.role() <> 'authenticated' OR auth.uid() IS NULL OR p_agency_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM public.agency_members am
        WHERE am.user_id = auth.uid()
          AND am.agency_id = p_agency_id
          AND am.role = 'ADMIN'
          AND am.is_active = TRUE
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_agency_broker_or_admin(p_agency_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN TRUE;
    END IF;
    IF auth.role() <> 'authenticated' OR auth.uid() IS NULL OR p_agency_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM public.agency_members am
        WHERE am.user_id = auth.uid()
          AND am.agency_id = p_agency_id
          AND am.role IN ('ADMIN', 'BROKER')
          AND am.is_active = TRUE
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_agency_smm_or_admin(p_agency_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN TRUE;
    END IF;
    IF auth.role() <> 'authenticated' OR auth.uid() IS NULL OR p_agency_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM public.agency_members am
        WHERE am.user_id = auth.uid()
          AND am.agency_id = p_agency_id
          AND am.role IN ('ADMIN', 'SMM')
          AND am.is_active = TRUE
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Core BakuEstate Domain Tables (Tenant-Isolated with agency_id)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL DEFAULT 'BINA_AZ'
        CHECK (source_type IN ('BINA_AZ', 'OFF_MARKET')),
    canonical_niche TEXT NOT NULL DEFAULT 'GENERAL'
        CHECK (canonical_niche IN ('LUXURY', 'AFFORDABLE', 'GENERAL', 'TIKTOK')),
    bina_id TEXT NULL,
    url TEXT NULL,

    -- Deduplication & Content Revision Metadata
    duplicate_of_listing_id UUID NULL REFERENCES public.listings(id) ON DELETE SET NULL,
    duplicate_confidence REAL NULL
        CHECK (duplicate_confidence IS NULL OR (duplicate_confidence >= 0.0 AND duplicate_confidence <= 1.0)),
    duplicate_resolution TEXT NOT NULL DEFAULT 'NONE'
        CHECK (duplicate_resolution IN ('NONE', 'PENDING_REVIEW', 'CONFIRMED_DUPLICATE', 'FALSE_POSITIVE')),
    photo_urls_hash TEXT NULL,
    content_revision INT NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
    last_rendered_revision INT NULL,

    -- Property & Normalized Pricing
    title TEXT NULL,
    price NUMERIC(14, 2) NULL CHECK (price IS NULL OR price >= 0),
    currency TEXT NOT NULL DEFAULT 'AZN' CHECK (currency IN ('AZN', 'USD', 'EUR')),
    price_azn_normalized NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (price_azn_normalized >= 0),
    location TEXT NULL,
    district_normalized TEXT NULL,
    address TEXT NULL,
    rooms INT NULL CHECK (rooms IS NULL OR rooms >= 0),
    area NUMERIC(10, 2) NULL CHECK (area IS NULL OR area >= 0),
    floor INT NULL,
    floors INT NULL,
    has_bill_of_sale BOOLEAN NOT NULL DEFAULT FALSE,
    is_owner BOOLEAN NOT NULL DEFAULT FALSE,
    contact_name TEXT NULL,
    owner_phone_raw TEXT NULL,
    owner_phone_normalized TEXT NULL,
    photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    description TEXT NULL,
    archetype TEXT NOT NULL DEFAULT 'budget'
        CHECK (archetype IN ('budget', 'luxury', 'villa', 'commercial')),

    -- 4 Decoupled State Machines
    source_availability TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (source_availability IN ('ACTIVE', 'REMOVED_ON_BINA', 'CONFIRMED_SOLD')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_checked_at TIMESTAMPTZ NULL,

    pipeline_status TEXT NOT NULL DEFAULT 'NEW'
        CHECK (pipeline_status IN ('NEW', 'QUEUED', 'RENDERING', 'DRAFT_READY', 'DISPATCHED', 'FAILED', 'SKIPPED_DUPLICATE')),

    editorial_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
        CHECK (editorial_status IN ('PENDING_REVIEW', 'APPROVED', 'PUBLISHED', 'NEEDS_RERENDER', 'REJECTED', 'ARCHIVED')),

    owner_outreach_status TEXT NOT NULL DEFAULT 'NOT_CONTACTED'
        CHECK (owner_outreach_status IN (
            'NOT_CONTACTED',
            'CONTACTED',
            'AVAILABILITY_CONFIRMED',
            'COMMISSION_AGREED',
            'UNRESPONSIVE',
            'REFUSED_AGENT',
            'OWNER_SOLD'
        )),
    commission_type TEXT NULL
        CHECK (commission_type IS NULL OR commission_type IN ('PERCENT', 'FIXED_AZN', 'NONE')),
    commission_value NUMERIC(12, 2) NULL CHECK (commission_value IS NULL OR commission_value >= 0),
    owner_min_price_azn NUMERIC(14, 2) NULL CHECK (owner_min_price_azn IS NULL OR owner_min_price_azn >= 0),
    owner_last_contacted_at TIMESTAMPTZ NULL,
    owner_next_checkin_at TIMESTAMPTZ NULL,
    owner_notes TEXT NULL,
    last_auto_rendered_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_listings_not_self_duplicate
        CHECK (duplicate_of_listing_id IS NULL OR duplicate_of_listing_id <> id),
    CONSTRAINT chk_listings_source_bina_fields
        CHECK (source_type = 'OFF_MARKET' OR (bina_id IS NOT NULL AND url IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_listings_agency_bina_id
    ON public.listings (agency_id, bina_id)
    WHERE bina_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_agency_created
    ON public.listings (agency_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listings_owner_phone_normalized
    ON public.listings (owner_phone_normalized)
    WHERE owner_phone_normalized IS NOT NULL AND owner_phone_normalized <> '';

CREATE INDEX IF NOT EXISTS idx_listings_district_rooms_area
    ON public.listings (agency_id, district_normalized, rooms, area);

CREATE INDEX IF NOT EXISTS idx_listings_editorial_availability
    ON public.listings (agency_id, editorial_status, source_availability);

CREATE INDEX IF NOT EXISTS idx_listings_duplicate_pending
    ON public.listings (agency_id, duplicate_resolution)
    WHERE duplicate_resolution = 'PENDING_REVIEW';

CREATE INDEX IF NOT EXISTS idx_listings_last_seen_at
    ON public.listings (agency_id, last_seen_at DESC);

DROP TRIGGER IF EXISTS trg_listings_set_updated_at ON public.listings;
CREATE TRIGGER trg_listings_set_updated_at
    BEFORE UPDATE ON public.listings
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

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

DROP TRIGGER IF EXISTS trg_listings_preserve_owner_phone ON public.listings;
CREATE TRIGGER trg_listings_preserve_owner_phone
    BEFORE UPDATE ON public.listings
    FOR EACH ROW EXECUTE FUNCTION public.preserve_non_empty_owner_phone();

-- Separated PII table: SMM role has zero access
CREATE TABLE IF NOT EXISTS public.listing_owner_contacts (
    listing_id UUID PRIMARY KEY REFERENCES public.listings(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    owner_name TEXT NULL,
    owner_phone_raw TEXT NULL,
    owner_phone_normalized TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_owner_contacts_agency
    ON public.listing_owner_contacts (agency_id);

DROP TRIGGER IF EXISTS trg_listing_owner_contacts_set_updated_at ON public.listing_owner_contacts;
CREATE TRIGGER trg_listing_owner_contacts_set_updated_at
    BEFORE UPDATE ON public.listing_owner_contacts
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- Pipeline Jobs Queue (supports CANCELLED & cooperative cancel_requested_at)
CREATE TABLE IF NOT EXISTS public.pipeline_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL,
    job_type TEXT NOT NULL
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
        )),
    listing_id UUID NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    trigger_source TEXT NOT NULL DEFAULT 'AUTO_SCHEDULER'
        CHECK (trigger_source IN ('AUTO_SCHEDULER', 'WEB_UI', 'TELEGRAM_WEBHOOK')),
    params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')),
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INT NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
    locked_by TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    cancel_requested_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NULL,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_queue_claim
    ON public.pipeline_jobs (status, created_at ASC)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_lease_expiry
    ON public.pipeline_jobs (lease_expires_at)
    WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_listing_id
    ON public.pipeline_jobs (listing_id)
    WHERE listing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_agency_created_desc
    ON public.pipeline_jobs (agency_id, created_at DESC);

-- Listing Events Audit Log
CREATE TABLE IF NOT EXISTS public.listing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    actor_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'SCRAPED_NEW',
            'PRICE_CHANGED',
            'KUPCA_CHANGED',
            'PHOTOS_CHANGED',
            'REMOVED_ON_BINA',
            'DUPLICATE_FLAGGED',
            'STATUS_CHANGED',
            'OWNER_UPDATED'
        )),
    old_value_json JSONB NULL,
    new_value_json JSONB NULL,
    price_delta_pct NUMERIC(8, 2) NULL,
    triggered_job_id UUID NULL REFERENCES public.pipeline_jobs(id) ON DELETE SET NULL,
    actor TEXT NOT NULL DEFAULT 'scraper'
        CHECK (actor IN ('scraper', 'liveness_poller', 'web_user', 'telegram_user', 'local_worker', 'migration')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_events_listing_created
    ON public.listing_events (listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listing_events_agency_created
    ON public.listing_events (agency_id, created_at DESC);

-- Render Versions
CREATE TABLE IF NOT EXISTS public.render_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    version_num INT NOT NULL CHECK (version_num >= 1),
    content_revision INT NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
    trigger_reason TEXT NOT NULL DEFAULT 'AUTO_INITIAL'
        CHECK (trigger_reason IN (
            'AUTO_INITIAL',
            'AUTO_PRICE_DROP',
            'MANUAL_RERENDER',
            'SCRIPT_ANGLE',
            'VOICE_SWITCH'
        )),
    script_angle TEXT NULL,
    voice_engine TEXT NULL,
    voice_id TEXT NULL,
    model_id TEXT NULL,
    script_text TEXT NULL,
    local_video_path TEXT NULL,
    storage_object_path TEXT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'supabase'
        CHECK (storage_provider IN ('supabase', 'r2')),
    video_cdn_url TEXT NULL,
    duration_seconds NUMERIC(8, 2) NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'SUPERSEDED')),
    hook_type TEXT NULL
        CHECK (hook_type IS NULL OR hook_type IN ('PRICE_FIRST', 'LOCATION_FIRST', 'LUXURY_LIFESTYLE')),
    duration_bucket TEXT NULL
        CHECK (duration_bucket IS NULL OR duration_bucket IN ('SHORT_25_30', 'LONG_40_50')),
    ab_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    rendered_price NUMERIC NULL,
    rendered_currency TEXT NOT NULL DEFAULT 'AZN',
    telegram_message_id TEXT NULL,
    storage_pruned_at TIMESTAMPTZ NULL,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,

    CONSTRAINT uq_render_versions_listing_version UNIQUE (listing_id, version_num)
);

CREATE INDEX IF NOT EXISTS idx_render_versions_listing_ver
    ON public.render_versions (listing_id, version_num DESC);

CREATE INDEX IF NOT EXISTS idx_render_versions_prune_candidates
    ON public.render_versions (status, created_at ASC)
    WHERE storage_pruned_at IS NULL AND storage_object_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_render_versions_agency_created
    ON public.render_versions (agency_id, created_at DESC);

-- Publications
CREATE TABLE IF NOT EXISTS public.publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    render_version_id UUID NULL REFERENCES public.render_versions(id) ON DELETE SET NULL,
    channel TEXT NOT NULL
        CHECK (channel IN ('INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS', 'TELEGRAM', 'WHATSAPP_STATUS')),
    post_url TEXT NULL,
    caption_used TEXT NULL,
    status TEXT NOT NULL DEFAULT 'PUBLISHED'
        CHECK (status IN ('DRAFT', 'DRAFT_READY', 'READY_TO_PUBLISH', 'PUBLISHED', 'ARCHIVED', 'REMOVED')),
    published_at TIMESTAMPTZ NULL DEFAULT NOW(),
    notes TEXT NULL,
    views_count INT NOT NULL DEFAULT 0 CHECK (views_count >= 0),
    likes_count INT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
    comments_count INT NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
    shares_count INT NOT NULL DEFAULT 0 CHECK (shares_count >= 0),
    external_post_id TEXT NULL,
    telemetry_status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (telemetry_status IN ('PENDING', 'ACTIVE', 'FROZEN', 'ERROR')),
    last_scraped_at TIMESTAMPTZ NULL,
    next_poll_at TIMESTAMPTZ NULL,
    poll_count INT NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
    scrape_error_count INT NOT NULL DEFAULT 0 CHECK (scrape_error_count >= 0),
    last_scrape_error TEXT NULL,
    verified_at TIMESTAMPTZ NULL,
    preflight_status TEXT NOT NULL DEFAULT 'UNCHECKED'
        CHECK (preflight_status IN ('UNCHECKED', 'PASSED', 'PRICE_MISMATCH', 'REMOVED_ON_BINA')),
    last_preflight_error TEXT NULL,
    telegram_dispatched_at TIMESTAMPTZ NULL,
    telegram_message_id BIGINT NULL,
    target_account_handle VARCHAR(64) NOT NULL DEFAULT '@bakuestate.official',
    channel_niche VARCHAR(32) NOT NULL DEFAULT 'GENERAL'
        CHECK (channel_niche IN ('LUXURY', 'AFFORDABLE', 'GENERAL', 'TIKTOK')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT publications_listing_id_target_account_handle_key UNIQUE (listing_id, target_account_handle)
);

CREATE INDEX IF NOT EXISTS idx_publications_listing_published
    ON public.publications (listing_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_publications_agency_channel
    ON public.publications (agency_id, channel, status);

CREATE INDEX IF NOT EXISTS idx_publications_active_scraping
    ON public.publications (next_poll_at ASC)
    WHERE status = 'PUBLISHED' AND telemetry_status = 'ACTIVE' AND post_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_publications_target_account
    ON public.publications (target_account_handle);

-- Buyer Leads
CREATE TABLE IF NOT EXISTS public.buyer_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    client_name TEXT NOT NULL CHECK (BTRIM(client_name) <> ''),
    phone_normalized TEXT NULL,
    social_handle TEXT NULL,
    source_channel TEXT NOT NULL DEFAULT 'TELEGRAM'
        CHECK (source_channel IN ('IG_DM', 'WHATSAPP', 'TIKTOK_DM', 'CALL', 'TELEGRAM', 'REFERRAL')),
    stage TEXT NOT NULL DEFAULT 'NEW_INQUIRY'
        CHECK (stage IN (
            'NEW_INQUIRY',
            'QUALIFIED',
            'VIEWING_SCHEDULED',
            'VIEWED',
            'NEGOTIATING',
            'DEPOSIT',
            'WON_CLOSED',
            'LOST',
            'COLD'
        )),
    budget_max_azn NUMERIC(14, 2) NULL CHECK (budget_max_azn IS NULL OR budget_max_azn >= 0),
    preferred_districts TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    min_rooms INT NULL CHECK (min_rooms IS NULL OR min_rooms >= 0),
    requires_kupca BOOLEAN NOT NULL DEFAULT FALSE,
    expected_commission_azn NUMERIC(12, 2) NULL CHECK (expected_commission_azn IS NULL OR expected_commission_azn >= 0),
    actual_commission_azn NUMERIC(12, 2) NULL CHECK (actual_commission_azn IS NULL OR actual_commission_azn >= 0),
    lost_reason TEXT NULL,
    notes TEXT NULL,
    next_followup_at TIMESTAMPTZ NULL,
    attributed_publication_id UUID NULL REFERENCES public.publications(id) ON DELETE SET NULL,
    attributed_channel_niche VARCHAR(32) DEFAULT 'GENERAL',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_agency_stage
    ON public.buyer_leads (agency_id, stage, next_followup_at);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_assigned
    ON public.buyer_leads (agency_id, assigned_agent_id);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_phone
    ON public.buyer_leads (phone_normalized)
    WHERE phone_normalized IS NOT NULL AND phone_normalized <> '';

DROP TRIGGER IF EXISTS trg_buyer_leads_set_updated_at ON public.buyer_leads;
CREATE TRIGGER trg_buyer_leads_set_updated_at
    BEFORE UPDATE ON public.buyer_leads
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- Lead <-> Listing Join
CREATE TABLE IF NOT EXISTS public.lead_listings (
    lead_id UUID NOT NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'INQUIRED'
        CHECK (relation IN ('INQUIRED', 'PITCHED', 'VIEWED', 'REJECTED', 'OFFERED')),
    notes TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (lead_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_listings_listing_id
    ON public.lead_listings (listing_id);

DROP TRIGGER IF EXISTS trg_lead_listings_set_updated_at ON public.lead_listings;
CREATE TRIGGER trg_lead_listings_set_updated_at
    BEFORE UPDATE ON public.lead_listings
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- Follow-Up Tasks
CREATE TABLE IF NOT EXISTS public.follow_up_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL
        CHECK (entity_type IN ('BUYER_LEAD', 'OWNER_OUTREACH', 'DUPLICATE_REVIEW')),
    lead_id UUID NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
    listing_id UUID NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (BTRIM(title) <> ''),
    due_at TIMESTAMPTZ NOT NULL,
    priority TEXT NOT NULL DEFAULT 'NORMAL'
        CHECK (priority IN ('LOW', 'NORMAL', 'HIGH')),
    status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'SNOOZED', 'DONE', 'CANCELLED')),
    reminder_sent_at TIMESTAMPTZ NULL,
    snooze_count INT NOT NULL DEFAULT 0 CHECK (snooze_count >= 0),
    completed_at TIMESTAMPTZ NULL,
    outcome_note TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_due_active
    ON public.follow_up_tasks (agency_id, due_at ASC, priority)
    WHERE status IN ('OPEN', 'SNOOZED');

CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_lead_id
    ON public.follow_up_tasks (lead_id)
    WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_listing_id
    ON public.follow_up_tasks (listing_id)
    WHERE listing_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_follow_up_tasks_set_updated_at ON public.follow_up_tasks;
CREATE TRIGGER trg_follow_up_tasks_set_updated_at
    BEFORE UPDATE ON public.follow_up_tasks
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- Social Comments
CREATE TABLE IF NOT EXISTS public.social_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    publication_id UUID NOT NULL REFERENCES public.publications(id) ON DELETE CASCADE,
    platform_comment_id TEXT NOT NULL,
    author_handle TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    like_count INT NOT NULL DEFAULT 0,
    is_intent_lead BOOLEAN NOT NULL DEFAULT FALSE,
    intent_category TEXT NULL,
    intent_confidence REAL NULL,
    suggested_reply TEXT NULL,
    buyer_lead_id UUID NULL REFERENCES public.buyer_leads(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_social_comments_platform_id UNIQUE (publication_id, platform_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_social_comments_publication
    ON public.social_comments (publication_id, created_at DESC);

-- Publication Telemetry Snapshots
CREATE TABLE IF NOT EXISTS public.publication_telemetry_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    publication_id UUID NOT NULL REFERENCES public.publications(id) ON DELETE CASCADE,
    snapshot_phase TEXT NOT NULL,
    views_count INT NOT NULL,
    likes_count INT NOT NULL,
    comments_count INT NOT NULL,
    ner_score REAL NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_publication
    ON public.publication_telemetry_snapshots (publication_id, captured_at DESC);

-- Preflight Checks (bina_id nullable for OFF_MARKET; includes PASSED_WITH_DB_FALLBACK)
CREATE TABLE IF NOT EXISTS public.preflight_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    bina_id INT NULL,
    check_type TEXT NULL,
    result TEXT NOT NULL
        CHECK (result IN ('PASSED', 'PASSED_WITH_DB_FALLBACK', 'PRICE_CHANGED', 'REMOVED_ON_BINA', 'SCRAPE_ERROR')),
    portal_price NUMERIC NULL,
    video_price NUMERIC NULL,
    price_delta_pct REAL NULL,
    response_time_ms INT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preflight_checks_listing
    ON public.preflight_checks (listing_id, checked_at DESC);

-- Clean Standalone v2 Cockpit Cards (Zero Citadel Schema Conflict)
CREATE TABLE IF NOT EXISTS public.cockpit_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    lead_id UUID NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
    listing_id UUID NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'CRM',
    priority TEXT NOT NULL DEFAULT 'HIGH'
        CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'EXECUTED', 'DISMISSED', 'SNOOZED')),
    headline TEXT NOT NULL,
    draft_text TEXT NULL,
    reason TEXT NULL,
    sentinel_warning TEXT NULL,
    strategic_rationale TEXT NULL,
    target_uri TEXT NULL,
    assigned_agent_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    acted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_cockpit_cards_agency_status
    ON public.cockpit_cards (agency_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_cockpit_cards_set_updated_at ON public.cockpit_cards;
CREATE TRIGGER trg_cockpit_cards_set_updated_at
    BEFORE UPDATE ON public.cockpit_cards
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- Lead Timeline Events
CREATE TABLE IF NOT EXISTS public.lead_timeline_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    lead_id UUID NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
    listing_id UUID NULL REFERENCES public.listings(id) ON DELETE SET NULL,
    actor_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    actor TEXT NOT NULL
        CHECK (actor IN ('OPERATOR', 'BUYER', 'SELLER', 'AI_SENTINEL', 'AI_SCRIBE', 'AI_STRATEGIST', 'AI_JANITOR', 'AI_HUB')),
    event_type TEXT NOT NULL
        CHECK (event_type IN ('INQUIRY', 'OBJECTION', 'CALL_LOG', 'OFFER', 'COMMISSION_AGREED', 'SHOWING_SCHEDULED', 'DEAL_CLOSED', 'DEAL_LOST', 'STAGE_CHANGE', 'OBJECTION_CAPTURED')),
    summary TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_timeline_events_lead_id
    ON public.lead_timeline_events (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_timeline_events_listing_id
    ON public.lead_timeline_events (listing_id, created_at DESC);

-- Executive Agent Conversations, Append-Only Messages, Learned Insights & AI Budget
CREATE TABLE IF NOT EXISTS public.agent_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    agent_id TEXT NOT NULL
        CHECK (agent_id IN ('mudir', 'analitika', 'musteri_psixologiyasi', 'farabi', 'teymur', 'usta')),
    room_type TEXT NOT NULL DEFAULT 'SPECIALIST'
        CHECK (room_type IN ('OMNI', 'SPECIALIST')),
    title TEXT NOT NULL DEFAULT 'Yeni Söhbət',
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_convs_lookup
    ON public.agent_conversations (agency_id, operator_id, agent_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_agent_conversations_set_updated_at ON public.agent_conversations;
CREATE TRIGGER trg_agent_conversations_set_updated_at
    BEFORE UPDATE ON public.agent_conversations
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

CREATE TABLE IF NOT EXISTS public.agent_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    sender_type TEXT NOT NULL CHECK (sender_type IN ('USER', 'AGENT', 'SYSTEM')),
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    seq_num BIGINT GENERATED ALWAYS AS IDENTITY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conv_order
    ON public.agent_messages (conversation_id, created_at ASC, seq_num ASC);

CREATE TABLE IF NOT EXISTS public.agent_learned_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    agent_id TEXT NOT NULL
        CHECK (agent_id IN ('mudir', 'analitika', 'musteri_psixologiyasi', 'farabi', 'teymur', 'usta')),
    persona_scope VARCHAR(32) NOT NULL DEFAULT 'general',
    domain TEXT NOT NULL,
    insight_text TEXT NOT NULL,
    confidence_score NUMERIC(3, 2) NOT NULL DEFAULT 0.85,
    source_reference TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_insights_agency_scope
    ON public.agent_learned_insights (agency_id, persona_scope, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_copilot_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    action TEXT NOT NULL,
    model TEXT NOT NULL
        CHECK (model IN ('gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-2.5-flash', 'deterministic-fallback')),
    status TEXT NOT NULL DEFAULT 'COMPLETED'
        CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    audio_seconds NUMERIC(10, 2) NOT NULL DEFAULT 0,
    reserved_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
    latency_ms INT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_copilot_runs_agency_date
    ON public.ai_copilot_runs (agency_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_copilot_runs_op_date
    ON public.ai_copilot_runs (operator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agency_ai_usage_monthly (
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    month_baku TEXT NOT NULL,
    reserved_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    spent_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (agency_id, month_baku)
);

-- Social Accounts (Vault secret references — service_role only)
CREATE TABLE IF NOT EXISTS public.social_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('INSTAGRAM', 'TIKTOK')),
    account_handle TEXT NOT NULL,
    external_account_id TEXT NULL,
    vault_secret_id UUID NULL,
    refresh_vault_secret_id UUID NULL,
    token_expires_at TIMESTAMPTZ NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_social_accounts_agency_platform_handle UNIQUE (agency_id, platform, account_handle)
);

DROP TRIGGER IF EXISTS trg_social_accounts_set_updated_at ON public.social_accounts;
CREATE TRIGGER trg_social_accounts_set_updated_at
    BEFORE UPDATE ON public.social_accounts
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- Lead <-> Listing Smart Matches
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

-- Worker Heartbeats & Worker Status View
CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    agency_id UUID NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_job_id UUID NULL REFERENCES public.pipeline_jobs(id) ON DELETE SET NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW public.worker_status
WITH (security_invoker = true)
AS
SELECT
    wh.worker_id,
    wh.agency_id,
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

-- -----------------------------------------------------------------------------
-- 6. Zero Anon & PUBLIC Lockdown + Default Privileges
-- -----------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon;

-- Grant execute on RBAC helper functions to authenticated + service_role only
GRANT EXECUTE ON FUNCTION public.current_agency_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_agency_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_agency_member(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_agency_admin(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_agency_broker_or_admin(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_agency_smm_or_admin(UUID) TO authenticated, service_role;

-- Service-role-only secrets / internal config / budget ledger tables
REVOKE ALL ON TABLE public.baku_estate_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.baku_estate_config TO service_role;
ALTER TABLE public.baku_estate_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.social_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.social_accounts TO service_role;
ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.agency_ai_usage_monthly FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agency_ai_usage_monthly TO service_role;
ALTER TABLE public.agency_ai_usage_monthly ENABLE ROW LEVEL SECURITY;

-- Worker telemetry: authenticated SELECT only, service_role full
REVOKE ALL ON TABLE public.worker_heartbeats FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.worker_heartbeats TO authenticated;
GRANT ALL ON TABLE public.worker_heartbeats TO service_role;
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rbac_worker_heartbeats_select ON public.worker_heartbeats;
CREATE POLICY rbac_worker_heartbeats_select
    ON public.worker_heartbeats FOR SELECT TO authenticated
    USING (agency_id IS NULL OR public.is_agency_member(agency_id));

REVOKE ALL ON TABLE public.worker_status FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.worker_status TO authenticated, service_role;

-- Standard authenticated + service_role DML grants (RLS governs row/role boundaries)
DO $$
DECLARE
    v_tbl TEXT;
    v_auth_tables TEXT[] := ARRAY[
        'agencies',
        'agency_members',
        'agency_settings',
        'listings',
        'listing_owner_contacts',
        'pipeline_jobs',
        'listing_events',
        'render_versions',
        'publications',
        'buyer_leads',
        'lead_listings',
        'follow_up_tasks',
        'social_comments',
        'publication_telemetry_snapshots',
        'preflight_checks',
        'cockpit_cards',
        'lead_timeline_events',
        'agent_conversations',
        'agent_messages',
        'agent_learned_insights',
        'ai_copilot_runs',
        'lead_listing_matches'
    ];
BEGIN
    FOREACH v_tbl IN ARRAY v_auth_tables LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon;', v_tbl);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, service_role;', v_tbl);
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', v_tbl);
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Complete Table x Role RBAC Policies (ADMIN / BROKER / SMM)
-- -----------------------------------------------------------------------------

-- agencies
DROP POLICY IF EXISTS rbac_agencies_select ON public.agencies;
CREATE POLICY rbac_agencies_select ON public.agencies
    FOR SELECT TO authenticated
    USING (public.is_agency_member(id));

DROP POLICY IF EXISTS rbac_agencies_update ON public.agencies;
CREATE POLICY rbac_agencies_update ON public.agencies
    FOR UPDATE TO authenticated
    USING (public.is_agency_admin(id))
    WITH CHECK (public.is_agency_admin(id));

-- agency_settings
DROP POLICY IF EXISTS rbac_agency_settings_select ON public.agency_settings;
CREATE POLICY rbac_agency_settings_select ON public.agency_settings
    FOR SELECT TO authenticated
    USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS rbac_agency_settings_update ON public.agency_settings;
CREATE POLICY rbac_agency_settings_update ON public.agency_settings
    FOR UPDATE TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

-- agency_members (BROKER/SMM read-only in own agency; only ADMIN can write)
DROP POLICY IF EXISTS rbac_agency_members_select ON public.agency_members;
CREATE POLICY rbac_agency_members_select ON public.agency_members
    FOR SELECT TO authenticated
    USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS rbac_agency_members_admin_write ON public.agency_members;
CREATE POLICY rbac_agency_members_admin_write ON public.agency_members
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

-- listings: ADMIN full CRUD; BROKER SELECT portfolio + INSERT/UPDATE own/unassigned; SMM SELECT only
DROP POLICY IF EXISTS rbac_listings_select ON public.listings;
CREATE POLICY rbac_listings_select ON public.listings
    FOR SELECT TO authenticated
    USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS rbac_listings_insert ON public.listings;
CREATE POLICY rbac_listings_insert ON public.listings
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_broker_or_admin(agency_id)
            AND (assigned_agent_id = auth.uid() OR assigned_agent_id IS NULL)
        )
    );

DROP POLICY IF EXISTS rbac_listings_update ON public.listings;
CREATE POLICY rbac_listings_update ON public.listings
    FOR UPDATE TO authenticated
    USING (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_broker_or_admin(agency_id)
            AND (assigned_agent_id = auth.uid() OR assigned_agent_id IS NULL)
        )
    )
    WITH CHECK (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_broker_or_admin(agency_id)
            AND (assigned_agent_id = auth.uid() OR assigned_agent_id IS NULL)
        )
    );

DROP POLICY IF EXISTS rbac_listings_delete ON public.listings;
CREATE POLICY rbac_listings_delete ON public.listings
    FOR DELETE TO authenticated
    USING (public.is_agency_admin(agency_id));

-- listing_owner_contacts: ADMIN full CRUD; BROKER SELECT/INSERT/UPDATE assigned/unassigned; SMM = 0 rows
DROP POLICY IF EXISTS rbac_owner_contacts_admin ON public.listing_owner_contacts;
CREATE POLICY rbac_owner_contacts_admin ON public.listing_owner_contacts
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

DROP POLICY IF EXISTS rbac_owner_contacts_broker_select ON public.listing_owner_contacts;
CREATE POLICY rbac_owner_contacts_broker_select ON public.listing_owner_contacts
    FOR SELECT TO authenticated
    USING (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.listings l
            WHERE l.id = listing_owner_contacts.listing_id
              AND l.agency_id = listing_owner_contacts.agency_id
              AND (l.assigned_agent_id = auth.uid() OR l.assigned_agent_id IS NULL)
        )
    );

DROP POLICY IF EXISTS rbac_owner_contacts_broker_insert ON public.listing_owner_contacts;
CREATE POLICY rbac_owner_contacts_broker_insert ON public.listing_owner_contacts
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.listings l
            WHERE l.id = listing_owner_contacts.listing_id
              AND l.agency_id = listing_owner_contacts.agency_id
              AND (l.assigned_agent_id = auth.uid() OR l.assigned_agent_id IS NULL)
        )
    );

DROP POLICY IF EXISTS rbac_owner_contacts_broker_update ON public.listing_owner_contacts;
CREATE POLICY rbac_owner_contacts_broker_update ON public.listing_owner_contacts
    FOR UPDATE TO authenticated
    USING (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.listings l
            WHERE l.id = listing_owner_contacts.listing_id
              AND l.agency_id = listing_owner_contacts.agency_id
              AND (l.assigned_agent_id = auth.uid() OR l.assigned_agent_id IS NULL)
        )
    )
    WITH CHECK (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.listings l
            WHERE l.id = listing_owner_contacts.listing_id
              AND l.agency_id = listing_owner_contacts.agency_id
              AND (l.assigned_agent_id = auth.uid() OR l.assigned_agent_id IS NULL)
        )
    );

-- buyer_leads: ADMIN full CRUD; BROKER SELECT/INSERT/UPDATE assigned_agent_id = auth.uid(); SMM = 0 rows
DROP POLICY IF EXISTS rbac_buyer_leads_admin ON public.buyer_leads;
CREATE POLICY rbac_buyer_leads_admin ON public.buyer_leads
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

DROP POLICY IF EXISTS rbac_buyer_leads_broker_select ON public.buyer_leads;
CREATE POLICY rbac_buyer_leads_broker_select ON public.buyer_leads
    FOR SELECT TO authenticated
    USING (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid());

DROP POLICY IF EXISTS rbac_buyer_leads_broker_insert ON public.buyer_leads;
CREATE POLICY rbac_buyer_leads_broker_insert ON public.buyer_leads
    FOR INSERT TO authenticated
    WITH CHECK (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid());

DROP POLICY IF EXISTS rbac_buyer_leads_broker_update ON public.buyer_leads;
CREATE POLICY rbac_buyer_leads_broker_update ON public.buyer_leads
    FOR UPDATE TO authenticated
    USING (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid())
    WITH CHECK (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid());

-- lead_listings: ADMIN full CRUD; BROKER SELECT/INSERT/UPDATE for own leads; SMM = 0 rows
DROP POLICY IF EXISTS rbac_lead_listings_admin ON public.lead_listings;
CREATE POLICY rbac_lead_listings_admin ON public.lead_listings
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

DROP POLICY IF EXISTS rbac_lead_listings_broker ON public.lead_listings;
CREATE POLICY rbac_lead_listings_broker ON public.lead_listings
    FOR ALL TO authenticated
    USING (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.buyer_leads bl
            WHERE bl.id = lead_listings.lead_id AND bl.agency_id = lead_listings.agency_id AND bl.assigned_agent_id = auth.uid()
        )
    )
    WITH CHECK (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.buyer_leads bl
            WHERE bl.id = lead_listings.lead_id AND bl.agency_id = lead_listings.agency_id AND bl.assigned_agent_id = auth.uid()
        )
    );

-- follow_up_tasks: ADMIN full CRUD; BROKER SELECT/INSERT/UPDATE assigned_agent_id = auth.uid(); SMM = 0 rows
DROP POLICY IF EXISTS rbac_follow_up_tasks_admin ON public.follow_up_tasks;
CREATE POLICY rbac_follow_up_tasks_admin ON public.follow_up_tasks
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

DROP POLICY IF EXISTS rbac_follow_up_tasks_broker_select ON public.follow_up_tasks;
CREATE POLICY rbac_follow_up_tasks_broker_select ON public.follow_up_tasks
    FOR SELECT TO authenticated
    USING (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid());

DROP POLICY IF EXISTS rbac_follow_up_tasks_broker_insert ON public.follow_up_tasks;
CREATE POLICY rbac_follow_up_tasks_broker_insert ON public.follow_up_tasks
    FOR INSERT TO authenticated
    WITH CHECK (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid());

DROP POLICY IF EXISTS rbac_follow_up_tasks_broker_update ON public.follow_up_tasks;
CREATE POLICY rbac_follow_up_tasks_broker_update ON public.follow_up_tasks
    FOR UPDATE TO authenticated
    USING (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid())
    WITH CHECK (public.is_agency_broker_or_admin(agency_id) AND assigned_agent_id = auth.uid());

-- lead_timeline_events: ADMIN full CRUD; BROKER SELECT/INSERT/UPDATE for own leads; SMM = 0 rows
DROP POLICY IF EXISTS rbac_lead_timeline_admin ON public.lead_timeline_events;
CREATE POLICY rbac_lead_timeline_admin ON public.lead_timeline_events
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

DROP POLICY IF EXISTS rbac_lead_timeline_broker ON public.lead_timeline_events;
CREATE POLICY rbac_lead_timeline_broker ON public.lead_timeline_events
    FOR ALL TO authenticated
    USING (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.buyer_leads bl
            WHERE bl.id = lead_timeline_events.lead_id AND bl.agency_id = lead_timeline_events.agency_id AND bl.assigned_agent_id = auth.uid()
        )
    )
    WITH CHECK (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.buyer_leads bl
            WHERE bl.id = lead_timeline_events.lead_id AND bl.agency_id = lead_timeline_events.agency_id AND bl.assigned_agent_id = auth.uid()
        )
    );

-- lead_listing_matches: ADMIN full CRUD; BROKER SELECT/UPDATE for own leads; SMM = 0 rows
DROP POLICY IF EXISTS rbac_lead_matches_admin ON public.lead_listing_matches;
CREATE POLICY rbac_lead_matches_admin ON public.lead_listing_matches
    FOR ALL TO authenticated
    USING (public.is_agency_admin(agency_id))
    WITH CHECK (public.is_agency_admin(agency_id));

DROP POLICY IF EXISTS rbac_lead_matches_broker ON public.lead_listing_matches;
CREATE POLICY rbac_lead_matches_broker ON public.lead_listing_matches
    FOR ALL TO authenticated
    USING (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.buyer_leads bl
            WHERE bl.id = lead_listing_matches.lead_id AND bl.agency_id = lead_listing_matches.agency_id AND bl.assigned_agent_id = auth.uid()
        )
    )
    WITH CHECK (
        public.is_agency_broker_or_admin(agency_id)
        AND EXISTS (
            SELECT 1 FROM public.buyer_leads bl
            WHERE bl.id = lead_listing_matches.lead_id AND bl.agency_id = lead_listing_matches.agency_id AND bl.assigned_agent_id = auth.uid()
        )
    );

-- Media & Social tables: ADMIN + SMM full CRUD; BROKER SELECT only
DO $$
DECLARE
    v_media_tbl TEXT;
    v_media_tables TEXT[] := ARRAY[
        'render_versions',
        'publications',
        'preflight_checks',
        'social_comments',
        'publication_telemetry_snapshots'
    ];
BEGIN
    FOREACH v_media_tbl IN ARRAY v_media_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', 'rbac_' || v_media_tbl || '_select', v_media_tbl);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));',
            'rbac_' || v_media_tbl || '_select',
            v_media_tbl
        );
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', 'rbac_' || v_media_tbl || '_write', v_media_tbl);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_agency_smm_or_admin(agency_id)) WITH CHECK (public.is_agency_smm_or_admin(agency_id));',
            'rbac_' || v_media_tbl || '_write',
            v_media_tbl
        );
    END LOOP;
END;
$$;

-- listing_events: all agency members SELECT; ADMIN/BROKER INSERT
DROP POLICY IF EXISTS rbac_listing_events_select ON public.listing_events;
CREATE POLICY rbac_listing_events_select ON public.listing_events
    FOR SELECT TO authenticated
    USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS rbac_listing_events_insert ON public.listing_events;
CREATE POLICY rbac_listing_events_insert ON public.listing_events
    FOR INSERT TO authenticated
    WITH CHECK (public.is_agency_broker_or_admin(agency_id));

-- pipeline_jobs & cockpit_cards: ADMIN full CRUD; BROKER/SMM SELECT in agency + INSERT/UPDATE own/unassigned
DROP POLICY IF EXISTS rbac_pipeline_jobs_select ON public.pipeline_jobs;
CREATE POLICY rbac_pipeline_jobs_select ON public.pipeline_jobs
    FOR SELECT TO authenticated
    USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS rbac_pipeline_jobs_write ON public.pipeline_jobs;
CREATE POLICY rbac_pipeline_jobs_write ON public.pipeline_jobs
    FOR ALL TO authenticated
    USING (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_member(agency_id)
            AND (assigned_agent_id = auth.uid() OR created_by = auth.uid() OR assigned_agent_id IS NULL)
        )
    )
    WITH CHECK (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_member(agency_id)
            AND (assigned_agent_id = auth.uid() OR created_by = auth.uid() OR assigned_agent_id IS NULL)
        )
    );

DROP POLICY IF EXISTS rbac_cockpit_cards_select ON public.cockpit_cards;
CREATE POLICY rbac_cockpit_cards_select ON public.cockpit_cards
    FOR SELECT TO authenticated
    USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS rbac_cockpit_cards_write ON public.cockpit_cards;
CREATE POLICY rbac_cockpit_cards_write ON public.cockpit_cards
    FOR ALL TO authenticated
    USING (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_member(agency_id)
            AND (assigned_agent_id = auth.uid() OR created_by = auth.uid() OR assigned_agent_id IS NULL)
        )
    )
    WITH CHECK (
        public.is_agency_admin(agency_id)
        OR (
            public.is_agency_member(agency_id)
            AND (assigned_agent_id = auth.uid() OR created_by = auth.uid() OR assigned_agent_id IS NULL)
        )
    );

-- AI Copilot tables: ADMIN SELECT audit in agency; all members full CRUD on own operator_id = auth.uid()
DO $$
DECLARE
    v_ai_tbl TEXT;
    v_ai_tables TEXT[] := ARRAY[
        'agent_conversations',
        'agent_messages',
        'agent_learned_insights',
        'ai_copilot_runs'
    ];
BEGIN
    FOREACH v_ai_tbl IN ARRAY v_ai_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', 'rbac_' || v_ai_tbl || '_admin_select', v_ai_tbl);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_agency_admin(agency_id));',
            'rbac_' || v_ai_tbl || '_admin_select',
            v_ai_tbl
        );
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', 'rbac_' || v_ai_tbl || '_own', v_ai_tbl);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_agency_member(agency_id) AND operator_id = auth.uid()) WITH CHECK (public.is_agency_member(agency_id) AND operator_id = auth.uid());',
            'rbac_' || v_ai_tbl || '_own',
            v_ai_tbl
        );
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Realtime Publication Registration
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'worker_heartbeats'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.worker_heartbeats;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pipeline_jobs'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.pipeline_jobs;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'cockpit_cards'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.cockpit_cards;
        END IF;
    END IF;
END;
$$;
