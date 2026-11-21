-- =============================================================================
-- Migration: 202611200001_buyer_leads_attribution
-- Purpose:   Add publication attribution (attributed_publication_id) and 
--            channel niche tracking (attributed_channel_niche) to buyer_leads
--            for full-funnel closed-loop attribution across social channels.
-- =============================================================================

ALTER TABLE public.buyer_leads
  ADD COLUMN IF NOT EXISTS attributed_publication_id UUID REFERENCES public.publications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attributed_channel_niche VARCHAR(32) DEFAULT 'GENERAL';

CREATE INDEX IF NOT EXISTS idx_buyer_leads_publication
  ON public.buyer_leads (attributed_publication_id);

CREATE INDEX IF NOT EXISTS idx_buyer_leads_niche
  ON public.buyer_leads (attributed_channel_niche);
