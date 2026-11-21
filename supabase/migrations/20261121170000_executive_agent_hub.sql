-- =============================================================================
-- Migration: 20261121170000_executive_agent_hub
-- Purpose:   BakuEstate-AI Autonomous Executive Agent Hub & Living Memory Architecture:
--            Persistent conversational threading (agent_conversations) and living episodic
--            memory extraction (agent_learned_insights) across 4 executive council agents
--            (Müdir, Farabi, Usta, Teymur).
--
-- Safety:    No hard foreign key reference to auth.users(id) on operator_id to prevent
--            foreign key failures in local test runners and headless background jobs.
--            Operator RLS enforced using auth.uid() = operator_id.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table: public.agent_conversations
-- Consolidates conversation threading and multi-turn message history into a
-- single relational table using a JSONB messages array for atomic retrieval and update.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    agent_id TEXT NOT NULL CHECK (agent_id IN ('mudir', 'farabi', 'teymur', 'usta')),
    room_type TEXT NOT NULL DEFAULT 'SPECIALIST' CHECK (room_type IN ('OMNI', 'SPECIALIST')),
    title TEXT NOT NULL DEFAULT 'Yeni Söhbət',
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on (operator_id, agent_id, updated_at DESC)
CREATE INDEX IF NOT EXISTS idx_agent_convs_lookup 
    ON public.agent_conversations (operator_id, agent_id, updated_at DESC);

-- Enable Row Level Security
ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;

-- Operator RLS Policy
DROP POLICY IF EXISTS "Operators manage own agent conversations" ON public.agent_conversations;
CREATE POLICY "Operators manage own agent conversations"
    ON public.agent_conversations FOR ALL
    TO authenticated
    USING (auth.uid() = operator_id)
    WITH CHECK (auth.uid() = operator_id);

-- Service Role Policy (Unrestricted administrative management for background jobs/edge gateway)
DROP POLICY IF EXISTS "Service role manages all agent conversations" ON public.agent_conversations;
CREATE POLICY "Service role manages all agent conversations"
    ON public.agent_conversations FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Automated updated_at trigger maintenance
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'baku_estate_set_updated_at'
    ) THEN
        DROP TRIGGER IF EXISTS trg_agent_conversations_set_updated_at ON public.agent_conversations;
        CREATE TRIGGER trg_agent_conversations_set_updated_at
            BEFORE UPDATE ON public.agent_conversations
            FOR EACH ROW
            EXECUTE FUNCTION public.baku_estate_set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Table: public.agent_learned_insights
-- Living episodic memory extracted from completed deals, buyer debriefs, and
-- video campaign metrics. Partitioned by agent and domain.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_learned_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    agent_id TEXT NOT NULL CHECK (agent_id IN ('mudir', 'farabi', 'teymur', 'usta')),
    domain TEXT NOT NULL,
    insight_text TEXT NOT NULL,
    confidence_score NUMERIC(3,2) NOT NULL DEFAULT 0.85,
    source_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on (agent_id, domain)
CREATE INDEX IF NOT EXISTS idx_agent_insights_domain 
    ON public.agent_learned_insights (agent_id, domain);

-- Additional index on operator_id for scoped retrieval
CREATE INDEX IF NOT EXISTS idx_agent_insights_op_domain
    ON public.agent_learned_insights (operator_id, agent_id, domain);

-- Enable Row Level Security
ALTER TABLE public.agent_learned_insights ENABLE ROW LEVEL SECURITY;

-- Operator RLS Policy
DROP POLICY IF EXISTS "Operators read and append own insights" ON public.agent_learned_insights;
CREATE POLICY "Operators read and append own insights"
    ON public.agent_learned_insights FOR ALL
    TO authenticated
    USING (auth.uid() = operator_id)
    WITH CHECK (auth.uid() = operator_id);

-- Service Role Policy (Unrestricted administrative management for background jobs/edge gateway)
DROP POLICY IF EXISTS "Service role manages all agent learned insights" ON public.agent_learned_insights;
CREATE POLICY "Service role manages all agent learned insights"
    ON public.agent_learned_insights FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 3. Table Permissions & Grants
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_conversations TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_learned_insights TO anon, authenticated, service_role;
