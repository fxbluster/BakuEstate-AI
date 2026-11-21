-- =============================================================================
-- BakuEstate-AI: 24/7 Follow-Up, Listing Deduplication & Web CRM Core Schema
-- Migration: 202611180001_crm_core_schema.sql
--
-- Creates the 8 canonical CRM tables, constraints, indexes, triggers, and
-- strict single-operator Row-Level Security (RLS) policies with ZERO anon/public
-- access.
--
-- Operator Setup (run once after creating your Supabase Auth user):
--   ALTER DATABASE postgres SET app.operator_uid = '<YOUR-SUPABASE-AUTH-USER-UUID>';
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Utility Trigger & Strict Single-Operator RLS Helper
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.baku_estate_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE public.baku_estate_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.baku_estate_config TO service_role;
ALTER TABLE public.baku_estate_config ENABLE ROW LEVEL SECURITY;

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

-- Fail-closed single-operator guard:
--   * service_role: allowed (server-side Edge Functions & local Windows worker)
--   * authenticated: allowed ONLY when auth.uid() matches `app.operator_uid`
--     or private `public.baku_estate_config` (`key = 'operator_uid'`)
--   * anon / public: ALWAYS denied (also revoked at GRANT level below)
CREATE OR REPLACE FUNCTION public.is_crm_operator()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_operator_uid_text TEXT;
    v_operator_uid UUID;
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN TRUE;
    END IF;

    IF auth.role() <> 'authenticated' OR auth.uid() IS NULL THEN
        RETURN FALSE;
    END IF;

    v_operator_uid_text := NULLIF(BTRIM(current_setting('app.operator_uid', true)), '');
    IF v_operator_uid_text IS NULL THEN
        SELECT NULLIF(BTRIM(value), '')
          INTO v_operator_uid_text
          FROM public.baku_estate_config
         WHERE key = 'operator_uid';
    END IF;

    IF v_operator_uid_text IS NULL THEN
        RETURN FALSE;
    END IF;

    BEGIN
        v_operator_uid := v_operator_uid_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN FALSE;
    END;

    RETURN auth.uid() = v_operator_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.is_crm_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_crm_operator() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1. listings (Canonical Listing + Owner Outreach + Dedup Metadata)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bina_id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,

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
        CHECK (pipeline_status IN ('NEW', 'QUEUED', 'RENDERING', 'DISPATCHED', 'FAILED', 'SKIPPED_DUPLICATE')),

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

    -- Auto-Render Cooldown Guardrail
    last_auto_rendered_at TIMESTAMPTZ NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_listings_not_self_duplicate
        CHECK (duplicate_of_listing_id IS NULL OR duplicate_of_listing_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_listings_owner_phone_normalized
    ON public.listings (owner_phone_normalized)
    WHERE owner_phone_normalized IS NOT NULL AND owner_phone_normalized <> '';

CREATE INDEX IF NOT EXISTS idx_listings_district_rooms_area
    ON public.listings (district_normalized, rooms, area);

CREATE INDEX IF NOT EXISTS idx_listings_editorial_availability
    ON public.listings (editorial_status, source_availability);

CREATE INDEX IF NOT EXISTS idx_listings_duplicate_pending
    ON public.listings (duplicate_resolution)
    WHERE duplicate_resolution = 'PENDING_REVIEW';

CREATE INDEX IF NOT EXISTS idx_listings_owner_outreach
    ON public.listings (owner_outreach_status);

CREATE INDEX IF NOT EXISTS idx_listings_last_seen_at
    ON public.listings (last_seen_at DESC);

DROP TRIGGER IF EXISTS trg_listings_set_updated_at ON public.listings;
CREATE TRIGGER trg_listings_set_updated_at
    BEFORE UPDATE ON public.listings
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. pipeline_jobs (Cloud <-> Local PC Idempotent Job Queue)
--    Created before listing_events so listing_events.triggered_job_id can FK cleanly.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pipeline_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL
        CHECK (job_type IN ('SCRAPE_NEW', 'RENDER_INITIAL', 'RENDER_PRICE_DROP', 'RERENDER', 'LIVENESS_CHECK')),
    listing_id UUID NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    trigger_source TEXT NOT NULL DEFAULT 'AUTO_SCHEDULER'
        CHECK (trigger_source IN ('AUTO_SCHEDULER', 'WEB_UI', 'TELEGRAM_WEBHOOK')),
    params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INT NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
    locked_by TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
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

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_created_desc
    ON public.pipeline_jobs (created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. listing_events (Immutable Change & Audit Log)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.listing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_listing_events_type_created
    ON public.listing_events (event_type, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. render_versions (Versioned Video Render History — Never Overwrites)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.render_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    video_cdn_url TEXT NULL,
    duration_seconds NUMERIC(8, 2) NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'SUPERSEDED')),
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

CREATE INDEX IF NOT EXISTS idx_render_versions_auto_daily
    ON public.render_versions (trigger_reason, created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. publications (Social Platform Publication & Post URL Tracking)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    render_version_id UUID NULL REFERENCES public.render_versions(id) ON DELETE SET NULL,
    channel TEXT NOT NULL
        CHECK (channel IN ('INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS', 'TELEGRAM', 'WHATSAPP_STATUS')),
    post_url TEXT NULL,
    caption_used TEXT NULL,
    status TEXT NOT NULL DEFAULT 'PUBLISHED'
        CHECK (status IN ('DRAFT', 'PUBLISHED', 'REMOVED')),
    published_at TIMESTAMPTZ NULL DEFAULT NOW(),
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_publications_listing_published
    ON public.publications (listing_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_publications_channel_status
    ON public.publications (channel, status);

-- -----------------------------------------------------------------------------
-- 6. buyer_leads (Buyer Inquiry & Sales Funnel)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.buyer_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    expected_commission_azn NUMERIC(12, 2) NULL CHECK (expected_commission_azn IS NULL OR expected_commission_azn >= 0),
    actual_commission_azn NUMERIC(12, 2) NULL CHECK (actual_commission_azn IS NULL OR actual_commission_azn >= 0),
    lost_reason TEXT NULL,
    notes TEXT NULL,
    next_followup_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_stage
    ON public.buyer_leads (stage);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_next_followup
    ON public.buyer_leads (next_followup_at ASC)
    WHERE next_followup_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_buyer_leads_phone
    ON public.buyer_leads (phone_normalized)
    WHERE phone_normalized IS NOT NULL AND phone_normalized <> '';

DROP TRIGGER IF EXISTS trg_buyer_leads_set_updated_at ON public.buyer_leads;
CREATE TRIGGER trg_buyer_leads_set_updated_at
    BEFORE UPDATE ON public.buyer_leads
    FOR EACH ROW EXECUTE FUNCTION public.baku_estate_set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. lead_listings (Buyer Lead <-> Listing Many-to-Many Join Table)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lead_listings (
    lead_id UUID NOT NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
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

-- -----------------------------------------------------------------------------
-- 8. follow_up_tasks (Unified Buyer + Owner + Duplicate Review Reminder Queue)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.follow_up_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    ON public.follow_up_tasks (due_at ASC, priority)
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

-- -----------------------------------------------------------------------------
-- Strict Row-Level Security (RLS) & Privilege Revocation (ZERO anon/public access)
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_table TEXT;
    v_tables TEXT[] := ARRAY[
        'listings',
        'listing_events',
        'render_versions',
        'publications',
        'buyer_leads',
        'lead_listings',
        'follow_up_tasks',
        'pipeline_jobs'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_tables LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon;', v_table);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, service_role;', v_table);
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', v_table);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', 'operator_only_all_' || v_table, v_table);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_crm_operator()) WITH CHECK (public.is_crm_operator());',
            'operator_only_all_' || v_table,
            v_table
        );
    END LOOP;
END;
$$;
