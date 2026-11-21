-- =============================================================================
-- Migration: 202611190001_social_lifecycle
-- Purpose:   Social lifecycle state machine, unauthenticated observer telemetry,
--            A/B experiment tagging, and audience intelligence comments schema.
-- =============================================================================

-- 1. Extend publications table with telemetry and status machine
ALTER TABLE public.publications DROP CONSTRAINT IF EXISTS publications_status_check;
ALTER TABLE public.publications ADD CONSTRAINT publications_status_check
  CHECK (status IN ('DRAFT', 'DRAFT_READY', 'PUBLISHED', 'ARCHIVED', 'REMOVED'));

ALTER TABLE public.publications
  ADD COLUMN IF NOT EXISTS views_count INT NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  ADD COLUMN IF NOT EXISTS likes_count INT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  ADD COLUMN IF NOT EXISTS comments_count INT NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  ADD COLUMN IF NOT EXISTS shares_count INT NOT NULL DEFAULT 0 CHECK (shares_count >= 0),
  ADD COLUMN IF NOT EXISTS external_post_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS telemetry_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (telemetry_status IN ('PENDING', 'ACTIVE', 'FROZEN', 'ERROR')),
  ADD COLUMN IF NOT EXISTS last_scraped_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS poll_count INT NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  ADD COLUMN IF NOT EXISTS scrape_error_count INT NOT NULL DEFAULT 0 CHECK (scrape_error_count >= 0),
  ADD COLUMN IF NOT EXISTS last_scrape_error TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_publications_active_scraping
  ON public.publications (next_poll_at ASC)
  WHERE status = 'PUBLISHED' AND telemetry_status = 'ACTIVE' AND post_url IS NOT NULL;

-- 2. Extend render_versions with structured A/B tags
ALTER TABLE public.render_versions
  ADD COLUMN IF NOT EXISTS hook_type TEXT NULL
    CHECK (hook_type IS NULL OR hook_type IN ('PRICE_FIRST', 'LOCATION_FIRST', 'LUXURY_LIFESTYLE')),
  ADD COLUMN IF NOT EXISTS duration_bucket TEXT NULL
    CHECK (duration_bucket IS NULL OR duration_bucket IN ('SHORT_25_30', 'LONG_40_50')),
  ADD COLUMN IF NOT EXISTS ab_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Social comments table with idempotency & lead linkage
CREATE TABLE IF NOT EXISTS public.social_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id UUID NOT NULL REFERENCES public.publications(id) ON DELETE CASCADE,
  platform_comment_id TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  like_count INT NOT NULL DEFAULT 0,
  is_intent_lead BOOLEAN NOT NULL DEFAULT FALSE,
  intent_category TEXT NULL, -- 'PRICE', 'LOCATION', 'MORTGAGE', 'PHONE_REQ', 'NOISE'
  intent_confidence REAL NULL,
  suggested_reply TEXT NULL,
  buyer_lead_id UUID NULL REFERENCES public.buyer_leads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_social_comments_platform_id UNIQUE (publication_id, platform_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_social_comments_publication
  ON public.social_comments (publication_id, created_at DESC);

-- 4. Publication telemetry snapshots for curve tracking and A/B scoring
CREATE TABLE IF NOT EXISTS public.publication_telemetry_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id UUID NOT NULL REFERENCES public.publications(id) ON DELETE CASCADE,
  snapshot_phase TEXT NOT NULL, -- 'T+4h', 'T+12h', 'T+24h', 'T+48h', 'T+7d'
  views_count INT NOT NULL,
  likes_count INT NOT NULL,
  comments_count INT NOT NULL,
  ner_score REAL NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_publication
  ON public.publication_telemetry_snapshots (publication_id, captured_at DESC);

-- 5. Extend pipeline_jobs to allow SYNC_SOCIAL_METRICS
ALTER TABLE public.pipeline_jobs DROP CONSTRAINT IF EXISTS pipeline_jobs_job_type_check;
ALTER TABLE public.pipeline_jobs ADD CONSTRAINT pipeline_jobs_job_type_check
  CHECK (job_type IN ('SCRAPE_NEW', 'RENDER_INITIAL', 'RENDER_PRICE_DROP', 'RERENDER', 'LIVENESS_CHECK', 'SYNC_SOCIAL_METRICS'));

-- 6. Grant DML permissions to anon, authenticated, service_role
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_comments TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.publication_telemetry_snapshots TO anon, authenticated, service_role;

-- 7. Row Level Security policies (frictionless single-operator access)
ALTER TABLE public.social_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_telemetry_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_only_all_social_comments ON public.social_comments;
CREATE POLICY operator_only_all_social_comments ON public.social_comments
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS operator_only_all_publication_telemetry_snapshots ON public.publication_telemetry_snapshots;
CREATE POLICY operator_only_all_publication_telemetry_snapshots ON public.publication_telemetry_snapshots
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
