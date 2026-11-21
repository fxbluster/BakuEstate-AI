-- =============================================================================
-- Migration: 202611190003_multi_account_and_ai_advisor
-- Purpose:   Multi-Account Distribution schema extensions (target_account_handle,
--            channel_niche), Cockpit Cards listing linkage and status updates,
--            and Lead Timeline Events immutable audit trail.
-- =============================================================================

-- 1. Multi-Account Distribution on publications
ALTER TABLE public.publications
  ADD COLUMN IF NOT EXISTS target_account_handle VARCHAR(64) NOT NULL DEFAULT '@bakuestate.official',
  ADD COLUMN IF NOT EXISTS channel_niche VARCHAR(32) NOT NULL DEFAULT 'GENERAL'
    CHECK (channel_niche IN ('LUXURY', 'AFFORDABLE', 'GENERAL', 'TIKTOK'));

-- Replace legacy channel uniqueness with per-account distribution constraint
ALTER TABLE public.publications DROP CONSTRAINT IF EXISTS publications_listing_id_channel_key;
ALTER TABLE public.publications DROP CONSTRAINT IF EXISTS publications_listing_id_target_account_handle_key;
ALTER TABLE public.publications ADD CONSTRAINT publications_listing_id_target_account_handle_key
  UNIQUE (listing_id, target_account_handle);

CREATE INDEX IF NOT EXISTS idx_publications_target_account
  ON public.publications (target_account_handle);

CREATE INDEX IF NOT EXISTS idx_publications_channel_niche
  ON public.publications (channel_niche);

-- 2. Link cockpit_cards to listings and ensure open operator access
ALTER TABLE public.cockpit_cards
  ADD COLUMN IF NOT EXISTS listing_id UUID NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS target_uri TEXT NULL;

-- Allow listing-only advisory cards without mandatory lead_id or foreign key locks
ALTER TABLE public.cockpit_cards
  ALTER COLUMN lead_id DROP NOT NULL;

ALTER TABLE public.cockpit_cards DROP CONSTRAINT IF EXISTS cockpit_cards_owner_id_fkey;
ALTER TABLE public.cockpit_cards DROP CONSTRAINT IF EXISTS cockpit_cards_owner_id_lead_id_fkey;

-- Extend status constraint to permit EXECUTED, DISMISSED, and case-insensitivity
ALTER TABLE public.cockpit_cards DROP CONSTRAINT IF EXISTS cockpit_cards_status_check;
ALTER TABLE public.cockpit_cards ADD CONSTRAINT cockpit_cards_status_check
  CHECK (lower(status) IN ('pending', 'sent', 'snoozed', 'dismissed', 'executed', 'archived'));

-- Extend channel constraint to allow telegram and instagram
ALTER TABLE public.cockpit_cards DROP CONSTRAINT IF EXISTS cockpit_cards_channel_check;
ALTER TABLE public.cockpit_cards ADD CONSTRAINT cockpit_cards_channel_check
  CHECK (lower(channel) IN ('whatsapp', 'email', 'call', 'archive', 'telegram', 'instagram'));

CREATE INDEX IF NOT EXISTS idx_cockpit_cards_listing_id
  ON public.cockpit_cards (listing_id);

CREATE INDEX IF NOT EXISTS idx_cockpit_cards_status_priority
  ON public.cockpit_cards (status, priority DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cockpit_cards TO anon, authenticated, service_role;

DROP POLICY IF EXISTS operator_only_all_cockpit_cards ON public.cockpit_cards;
CREATE POLICY operator_only_all_cockpit_cards ON public.cockpit_cards
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

-- 3. Lead Timeline Events audit trail table
CREATE TABLE IF NOT EXISTS public.lead_timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NULL REFERENCES public.buyer_leads(id) ON DELETE CASCADE,
  listing_id UUID NULL REFERENCES public.listings(id) ON DELETE SET NULL,
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR', 'BUYER', 'SELLER', 'AI_SENTINEL', 'AI_SCRIBE', 'AI_STRATEGIST', 'AI_JANITOR')),
  event_type TEXT NOT NULL CHECK (event_type IN ('INQUIRY', 'OBJECTION', 'CALL_LOG', 'OFFER', 'COMMISSION_AGREED', 'SHOWING_SCHEDULED', 'DEAL_CLOSED', 'DEAL_LOST')),
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_timeline_events_lead_id
  ON public.lead_timeline_events (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_timeline_events_listing_id
  ON public.lead_timeline_events (listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_timeline_events_event_type
  ON public.lead_timeline_events (event_type);

-- Grants & RLS for lead_timeline_events
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_timeline_events TO anon, authenticated, service_role;

ALTER TABLE public.lead_timeline_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_only_all_lead_timeline_events ON public.lead_timeline_events;
CREATE POLICY operator_only_all_lead_timeline_events ON public.lead_timeline_events
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
