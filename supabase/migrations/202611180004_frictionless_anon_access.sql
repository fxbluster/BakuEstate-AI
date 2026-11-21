-- =============================================================================
-- Migration: 202611180004_frictionless_anon_access
-- Purpose:   Allow direct frictionless operator access without email/password
--            barriers on personal devices, as requested by operator.
-- =============================================================================

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
        'pipeline_jobs',
        'worker_heartbeats'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_tables LOOP
        -- Grant full DML permissions to anon (in addition to authenticated and service_role)
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO anon;', v_table);
        
        -- Replace single-operator authenticated-only policy with open operator policy
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', 'operator_only_all_' || v_table, v_table);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);',
            'operator_only_all_' || v_table,
            v_table
        );
    END LOOP;
END;
$$;

-- Grant access on worker_status view to anon
GRANT SELECT ON public.worker_status TO anon;

-- Grant execute on relevant helper RPCs to anon
GRANT EXECUTE ON FUNCTION public.count_today_auto_renders_baku() TO anon;
