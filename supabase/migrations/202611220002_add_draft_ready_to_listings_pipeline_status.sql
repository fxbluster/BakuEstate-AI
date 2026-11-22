-- Migration: 202611220002_add_draft_ready_to_listings_pipeline_status.sql
-- Purpose: Add 'DRAFT_READY' to public.listings pipeline_status check constraint
--          for selective publishing and draft staging workflows.

ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_pipeline_status_check;
ALTER TABLE public.listings ADD CONSTRAINT listings_pipeline_status_check
  CHECK (pipeline_status IN ('NEW', 'QUEUED', 'RENDERING', 'DRAFT_READY', 'DISPATCHED', 'FAILED', 'SKIPPED_DUPLICATE'));
