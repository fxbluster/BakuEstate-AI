-- =============================================================================
-- Migration: 202611220001_tri_persona_and_timeline_constraints
-- Purpose:   Tri-Persona Executive Copilot (mudir, analitika, musteri_psixologiyasi),
--            timeline event expansion (AI_HUB, STAGE_CHANGE, OBJECTION_CAPTURED),
--            persona_scope episodic memory isolation, and pipeline background
--            Telegram video dispatching (TELEGRAM_DISPATCH).
-- =============================================================================

-- 1. Update agent_id CHECK constraint on agent_conversations
ALTER TABLE public.agent_conversations
  DROP CONSTRAINT IF EXISTS agent_conversations_agent_id_check;

ALTER TABLE public.agent_conversations
  ADD CONSTRAINT agent_conversations_agent_id_check
  CHECK (agent_id = ANY (ARRAY['mudir'::text, 'analitika'::text, 'musteri_psixologiyasi'::text, 'farabi'::text, 'teymur'::text, 'usta'::text]));

-- 2. Update agent_id CHECK constraint on agent_learned_insights
ALTER TABLE public.agent_learned_insights
  DROP CONSTRAINT IF EXISTS agent_learned_insights_agent_id_check;

ALTER TABLE public.agent_learned_insights
  ADD CONSTRAINT agent_learned_insights_agent_id_check
  CHECK (agent_id = ANY (ARRAY['mudir'::text, 'analitika'::text, 'musteri_psixologiyasi'::text, 'farabi'::text, 'teymur'::text, 'usta'::text]));

-- 3. Add persona_scope column for strict episodic retrieval isolation
ALTER TABLE public.agent_learned_insights
  ADD COLUMN IF NOT EXISTS persona_scope VARCHAR(32) DEFAULT 'general';

CREATE INDEX IF NOT EXISTS idx_agent_insights_persona_scope 
  ON public.agent_learned_insights (persona_scope);

-- 4. Update lead_timeline_events CHECK constraints (fixing existing silent failures)
ALTER TABLE public.lead_timeline_events
  DROP CONSTRAINT IF EXISTS lead_timeline_events_actor_check;

ALTER TABLE public.lead_timeline_events
  ADD CONSTRAINT lead_timeline_events_actor_check
  CHECK (actor = ANY (ARRAY['OPERATOR'::text, 'BUYER'::text, 'SELLER'::text, 'AI_SENTINEL'::text, 'AI_SCRIBE'::text, 'AI_STRATEGIST'::text, 'AI_JANITOR'::text, 'AI_HUB'::text]));

ALTER TABLE public.lead_timeline_events
  DROP CONSTRAINT IF EXISTS lead_timeline_events_event_type_check;

ALTER TABLE public.lead_timeline_events
  ADD CONSTRAINT lead_timeline_events_event_type_check
  CHECK (event_type = ANY (ARRAY['INQUIRY'::text, 'OBJECTION'::text, 'CALL_LOG'::text, 'OFFER'::text, 'COMMISSION_AGREED'::text, 'SHOWING_SCHEDULED'::text, 'DEAL_CLOSED'::text, 'DEAL_LOST'::text, 'STAGE_CHANGE'::text, 'OBJECTION_CAPTURED'::text]));

-- 5. Data Migration: Map legacy learned insights to modern persona scopes
UPDATE public.agent_learned_insights SET persona_scope = 'crm' WHERE agent_id IN ('farabi', 'musteri_psixologiyasi');
UPDATE public.agent_learned_insights SET persona_scope = 'analytics' WHERE agent_id IN ('teymur', 'analitika');
UPDATE public.agent_learned_insights SET persona_scope = 'general' WHERE agent_id IN ('mudir', 'usta');

-- 6. Update pipeline_jobs job_type CHECK constraint for background Telegram dispatch
ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_job_type_check;

ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_job_type_check
  CHECK (job_type = ANY (ARRAY[
    'SCRAPE_NEW'::text, 
    'RENDER_INITIAL'::text, 
    'RENDER_PRICE_DROP'::text, 
    'RERENDER'::text, 
    'LIVENESS_CHECK'::text, 
    'SYNC_SOCIAL_METRICS'::text, 
    'PREFLIGHT_CHECK'::text,
    'TELEGRAM_DISPATCH'::text
  ]));
