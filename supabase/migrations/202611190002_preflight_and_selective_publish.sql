-- =============================================================================
-- Migration: 202611190002_preflight_and_selective_publish
-- Purpose:   Pre-Flight Verification Gate & Selective Publishing schema
--            additions, publication state machine extension, rendered price
--            tracking on render versions, and real-time preflight audit log.
-- =============================================================================

-- 1. Extend publications table with preflight verification timestamps and ready state
ALTER TABLE public.publications DROP CONSTRAINT IF EXISTS publications_status_check;
ALTER TABLE public.publications ADD CONSTRAINT publications_status_check
  CHECK (status IN ('DRAFT', 'DRAFT_READY', 'READY_TO_PUBLISH', 'PUBLISHED', 'ARCHIVED', 'REMOVED'));

ALTER TABLE public.publications
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS preflight_status TEXT NOT NULL DEFAULT 'UNCHECKED'
    CHECK (preflight_status IN ('UNCHECKED', 'PASSED', 'PRICE_MISMATCH', 'REMOVED_ON_BINA')),
  ADD COLUMN IF NOT EXISTS last_preflight_error TEXT NULL,
  ADD COLUMN IF NOT EXISTS telegram_dispatched_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS telegram_message_id INT NULL;

-- 2. Extend render_versions with rendered pricing metadata for strict equality assertion
ALTER TABLE public.render_versions
  ADD COLUMN IF NOT EXISTS rendered_price NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS rendered_currency TEXT NOT NULL DEFAULT 'AZN';

-- 3. Preflight check audit log table
CREATE TABLE IF NOT EXISTS public.preflight_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  bina_id INT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASSED', 'PRICE_CHANGED', 'REMOVED_ON_BINA', 'SCRAPE_ERROR')),
  portal_price NUMERIC NULL,
  video_price NUMERIC NULL,
  price_delta_pct REAL NULL,
  response_time_ms INT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_preflight_checks_listing
  ON public.preflight_checks (listing_id, checked_at DESC);

-- 4. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.preflight_checks TO anon, authenticated, service_role;

-- 5. Row Level Security policies (frictionless single-operator access matching 202611180004)
ALTER TABLE public.preflight_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_only_all_preflight_checks ON public.preflight_checks;
CREATE POLICY operator_only_all_preflight_checks ON public.preflight_checks
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
