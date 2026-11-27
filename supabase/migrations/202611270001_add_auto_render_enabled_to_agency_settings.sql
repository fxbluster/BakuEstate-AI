ALTER TABLE public.agency_settings
  ADD COLUMN IF NOT EXISTS auto_render_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.agency_settings
  SET auto_render_enabled = FALSE
  WHERE auto_render_enabled IS DISTINCT FROM FALSE;
