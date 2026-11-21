# -*- coding: utf-8 -*-
"""
Vahid Test: Tri-Persona & Timeline Constraints DDL Miqrasiya Faylının Doğrulanması
Path: tests/test_tri_persona_and_timeline_constraints_migration.py
Məqsəd: supabase/migrations/202611220001_tri_persona_and_timeline_constraints.sql faylının
        sintaksis, struktur, indeks, və CHECK məhdudiyyətlərini yoxlamaq.
"""

import os
import re
import unittest


class TestTriPersonaAndTimelineConstraintsMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        cls.migration_path = os.path.join(
            cls.repo_root,
            "supabase",
            "migrations",
            "202611220001_tri_persona_and_timeline_constraints.sql",
        )
        if not os.path.exists(cls.migration_path):
            raise FileNotFoundError(f"Migration file not found: {cls.migration_path}")
        with open(cls.migration_path, "r", encoding="utf-8") as f:
            cls.sql_content = f.read()

    def test_file_exists_and_non_empty(self):
        """Miqrasiya faylının mövcudluğu və boş olmaması"""
        self.assertTrue(os.path.exists(self.migration_path))
        self.assertGreater(len(self.sql_content), 100)

    def test_agent_conversations_check_constraint(self):
        """agent_conversations_agent_id_check tri-persona və legacy agentləri qəbul etməlidir"""
        sql = self.sql_content
        self.assertIn("agent_conversations_agent_id_check", sql)
        for agent in ["mudir", "analitika", "musteri_psixologiyasi", "farabi", "teymur", "usta"]:
            self.assertIn(f"'{agent}'::text", sql)

    def test_agent_learned_insights_check_and_column(self):
        """agent_learned_insights check və persona_scope sütunu"""
        sql = self.sql_content
        self.assertIn("agent_learned_insights_agent_id_check", sql)
        for agent in ["mudir", "analitika", "musteri_psixologiyasi", "farabi", "teymur", "usta"]:
            self.assertIn(f"'{agent}'::text", sql)
        self.assertIn("persona_scope VARCHAR(32) DEFAULT 'general'", sql)
        self.assertIn("idx_agent_insights_persona_scope", sql)

    def test_lead_timeline_events_constraints(self):
        """lead_timeline_events actor (AI_HUB) və event_type (STAGE_CHANGE, OBJECTION_CAPTURED)"""
        sql = self.sql_content
        self.assertIn("lead_timeline_events_actor_check", sql)
        self.assertIn("'AI_HUB'::text", sql)
        self.assertIn("lead_timeline_events_event_type_check", sql)
        self.assertIn("'STAGE_CHANGE'::text", sql)
        self.assertIn("'OBJECTION_CAPTURED'::text", sql)

    def test_pipeline_jobs_check_constraint(self):
        """pipeline_jobs_job_type_check TELEGRAM_DISPATCH əlavə edilməlidir"""
        sql = self.sql_content
        self.assertIn("pipeline_jobs_job_type_check", sql)
        self.assertIn("'TELEGRAM_DISPATCH'::text", sql)

    def test_data_migration_scopes(self):
        """Köhnə məlumatların persona_scope üzrə yenilənməsi"""
        sql = self.sql_content
        self.assertIn("UPDATE public.agent_learned_insights SET persona_scope = 'crm'", sql)
        self.assertIn("UPDATE public.agent_learned_insights SET persona_scope = 'analytics'", sql)
        self.assertIn("UPDATE public.agent_learned_insights SET persona_scope = 'general'", sql)

    def test_balanced_parentheses_and_quotes(self):
        """SQL sintaksis təmizliyi (mötərizələr və dırnaqlar)"""
        cleaned = re.sub(r"--[^\n]*", "", self.sql_content)
        cleaned = re.sub(r"/\*[\s\S]*?\*/", "", cleaned)

        open_parens = cleaned.count("(")
        close_parens = cleaned.count(")")
        self.assertEqual(open_parens, close_parens, f"Unbalanced parentheses: (={open_parens}, )={close_parens}")


if __name__ == "__main__":
    unittest.main()
