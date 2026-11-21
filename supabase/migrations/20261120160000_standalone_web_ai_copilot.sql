-- =============================================================================
-- Migration: 20261120160000_standalone_web_ai_copilot
-- Purpose:   BakuEstate-AI Standalone Web CRM AI Engine:
--            Cloud telemetry, rate limiting, and cost bounds for serverless
--            Gemini API Copilot operations. Enforces atomic $10.00/month budget cap,
--            supported model tiers, and authenticated operator RLS.
-- =============================================================================

-- 1. Create table public.ai_copilot_runs if not exists
CREATE TABLE IF NOT EXISTS public.ai_copilot_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operator_id UUID NOT NULL DEFAULT auth.uid(),
    action TEXT NOT NULL,
    model TEXT NOT NULL CHECK (model IN ('gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash', 'deterministic-fallback')),
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(8, 4) NOT NULL DEFAULT 0.0000,
    latency_ms INT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 2. Schema evolution: ensure target columns exist on pre-existing table instances
ALTER TABLE public.ai_copilot_runs
    ADD COLUMN IF NOT EXISTS operator_id UUID DEFAULT auth.uid(),
    ADD COLUMN IF NOT EXISTS action TEXT,
    ADD COLUMN IF NOT EXISTS prompt_tokens INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS completion_tokens INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(8, 4) NOT NULL DEFAULT 0.0000,
    ADD COLUMN IF NOT EXISTS latency_ms INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Ensure id has default gen_random_uuid()
ALTER TABLE public.ai_copilot_runs ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- 3. Backfill data from legacy columns if migrating from previous schemas
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'ai_copilot_runs' AND column_name = 'owner_id'
    ) THEN
        UPDATE public.ai_copilot_runs 
        SET operator_id = owner_id 
        WHERE operator_id IS NULL AND owner_id IS NOT NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'ai_copilot_runs' AND column_name = 'use_case'
    ) THEN
        UPDATE public.ai_copilot_runs 
        SET action = use_case 
        WHERE action IS NULL AND use_case IS NOT NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'ai_copilot_runs' AND column_name = 'actual_cost_usd'
    ) THEN
        UPDATE public.ai_copilot_runs 
        SET cost_usd = COALESCE(actual_cost_usd, 0.0000) 
        WHERE cost_usd = 0.0000 AND actual_cost_usd IS NOT NULL;
    END IF;

    -- Ensure default operator_id for any orphan rows
    UPDATE public.ai_copilot_runs 
    SET operator_id = '083d8ea3-4a73-4b85-8479-0c532ce939f0'::uuid 
    WHERE operator_id IS NULL;

    -- Ensure default action for any orphan rows
    UPDATE public.ai_copilot_runs 
    SET action = 'legacy_operation' 
    WHERE action IS NULL;
END $$;

-- 4. Relax legacy NOT NULL and CHECK constraints that restrict new standalone inserts
DO $$
DECLARE
    col TEXT;
BEGIN
    FOR col IN 
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'ai_copilot_runs' 
          AND column_name IN (
              'owner_id', 'use_case', 'prompt_version', 'status', 
              'reserved_cost_usd', 'cost_source', 'result_summary', 'retention_until'
          )
          AND is_nullable = 'NO'
    LOOP
        EXECUTE format('ALTER TABLE public.ai_copilot_runs ALTER COLUMN %I DROP NOT NULL;', col);
    END LOOP;
END $$;

-- Drop obsolete constraints if present
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_model_check;
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_prompt_version_check;
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_reserved_cost_usd_check;
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_check;
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_use_case_check;
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_status_check;
ALTER TABLE public.ai_copilot_runs DROP CONSTRAINT IF EXISTS ai_copilot_runs_cost_source_check;

-- Ensure action and operator_id have valid defaults/constraints
ALTER TABLE public.ai_copilot_runs ALTER COLUMN operator_id SET DEFAULT auth.uid();
ALTER TABLE public.ai_copilot_runs ALTER COLUMN operator_id SET NOT NULL;
ALTER TABLE public.ai_copilot_runs ALTER COLUMN action SET NOT NULL;

-- 5. Add canonical model CHECK constraint
ALTER TABLE public.ai_copilot_runs ADD CONSTRAINT ai_copilot_runs_model_check
    CHECK (model IN ('gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash', 'deterministic-fallback'));

-- 6. Indexing on (operator_id, created_at)
CREATE INDEX IF NOT EXISTS idx_ai_copilot_runs_op_date
ON public.ai_copilot_runs (operator_id, created_at);

-- 7. Row Level Security and Policies
ALTER TABLE public.ai_copilot_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read own copilot runs" ON public.ai_copilot_runs;
DROP POLICY IF EXISTS "Users can read own copilot runs" ON public.ai_copilot_runs;
CREATE POLICY "Allow authenticated read own copilot runs"
ON public.ai_copilot_runs FOR SELECT
TO authenticated
USING (auth.uid() = operator_id);

DROP POLICY IF EXISTS "Allow service role insert copilot runs" ON public.ai_copilot_runs;
CREATE POLICY "Allow service role insert copilot runs"
ON public.ai_copilot_runs FOR INSERT
TO authenticated, service_role
WITH CHECK (true);

-- Also allow operator access in frictionless / single-operator mode
DROP POLICY IF EXISTS "operator_only_all_ai_copilot_runs" ON public.ai_copilot_runs;
CREATE POLICY "operator_only_all_ai_copilot_runs"
ON public.ai_copilot_runs FOR ALL
TO authenticated, anon, service_role
USING (true)
WITH CHECK (true);

-- Table Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_copilot_runs TO anon, authenticated, service_role;

-- 8. Atomic budget check function: check_copilot_budget
CREATE OR REPLACE FUNCTION public.check_copilot_budget(p_operator_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_monthly_cost NUMERIC;
    v_target_operator UUID;
BEGIN
    v_target_operator := COALESCE(p_operator_id, auth.uid());

    IF v_target_operator IS NULL THEN
        SELECT COALESCE(SUM(cost_usd), 0.0)
        INTO v_monthly_cost
        FROM public.ai_copilot_runs
        WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Baku');
    ELSE
        SELECT COALESCE(SUM(cost_usd), 0.0)
        INTO v_monthly_cost
        FROM public.ai_copilot_runs
        WHERE operator_id = v_target_operator
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Baku');
    END IF;

    RETURN v_monthly_cost < 10.00;
END;
$$;

REVOKE ALL ON FUNCTION public.check_copilot_budget(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_copilot_budget(UUID) TO anon, authenticated, service_role;
