# -*- coding: utf-8 -*-
"""
Vahid Test: Executive Agent Hub DDL Miqrasiya Faylının Doğrulanması
Path: tests/test_executive_agent_hub_migration.py
Məqsəd: supabase/migrations/20261121170000_executive_agent_hub.sql faylının
        sintaksis, struktur, indeks, RLS və təhlükəsizlik qaydalarını yoxlamaq.
"""

import os
import re
import unittest


class TestExecutiveAgentHubMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        cls.migration_path = os.path.join(
            cls.repo_root,
            "supabase",
            "migrations",
            "20261121170000_executive_agent_hub.sql",
        )
        if not os.path.exists(cls.migration_path):
            raise FileNotFoundError(f"Migration file not found: {cls.migration_path}")
        with open(cls.migration_path, "r", encoding="utf-8") as f:
            cls.sql_content = f.read()

    def test_file_exists_and_non_empty(self):
        """Miqrasiya faylının mövcudluğu və boş olmaması"""
        self.assertTrue(os.path.exists(self.migration_path))
        self.assertGreater(len(self.sql_content), 100)

    def test_no_hard_auth_users_foreign_key(self):
        """Təhlükəsizlik: operator_id üzərində REFERENCES auth.users(id) olmamalıdır"""
        self.assertNotIn(
            "REFERENCES auth.users",
            self.sql_content,
            "CRITICAL: REFERENCES auth.users found in migration. This breaks local test runners!",
        )

    def test_agent_conversations_table_schema(self):
        """agent_conversations cədvəlinin tam sxem spesifikasiyası"""
        sql = self.sql_content

        self.assertIn("CREATE TABLE IF NOT EXISTS public.agent_conversations", sql)
        self.assertIn("id UUID PRIMARY KEY DEFAULT gen_random_uuid()", sql)
        self.assertIn("operator_id UUID NOT NULL DEFAULT auth.uid()", sql)

        # 4 executive council agent IDs check
        self.assertIn("agent_id TEXT NOT NULL CHECK", sql)
        for agent in ["mudir", "farabi", "teymur", "usta"]:
            self.assertIn(f"'{agent}'", sql)

        # room_type check
        self.assertIn("room_type TEXT NOT NULL DEFAULT 'SPECIALIST'", sql)
        self.assertIn("'OMNI'", sql)
        self.assertIn("'SPECIALIST'", sql)

        # metadata fields
        self.assertIn("title TEXT NOT NULL DEFAULT 'Yeni Söhbət'", sql)
        self.assertIn("messages JSONB NOT NULL DEFAULT '[]'::jsonb", sql)
        self.assertIn("is_pinned BOOLEAN NOT NULL DEFAULT FALSE", sql)
        self.assertIn("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()", sql)
        self.assertIn("updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()", sql)

    def test_agent_conversations_indexing_and_rls(self):
        """agent_conversations indeksləri və RLS siyasətləri"""
        sql = self.sql_content

        # Composite index on (operator_id, agent_id, updated_at DESC)
        self.assertIn("idx_agent_convs_lookup", sql)
        self.assertIn("public.agent_conversations (operator_id, agent_id, updated_at DESC)", sql)

        # RLS enabled
        self.assertIn("ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY", sql)

        # Operator policy
        self.assertIn('POLICY "Operators manage own agent conversations"', sql)
        self.assertIn("auth.uid() = operator_id", sql)

    def test_agent_learned_insights_table_schema(self):
        """agent_learned_insights cədvəlinin tam sxem spesifikasiyası"""
        sql = self.sql_content

        self.assertIn("CREATE TABLE IF NOT EXISTS public.agent_learned_insights", sql)
        self.assertIn("id UUID PRIMARY KEY DEFAULT gen_random_uuid()", sql)
        self.assertIn("operator_id UUID NOT NULL DEFAULT auth.uid()", sql)
        self.assertIn("domain TEXT NOT NULL", sql)
        self.assertIn("insight_text TEXT NOT NULL", sql)
        self.assertIn("confidence_score NUMERIC(3,2) NOT NULL DEFAULT 0.85", sql)
        self.assertIn("source_reference TEXT", sql)
        self.assertIn("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()", sql)

    def test_agent_learned_insights_indexing_and_rls(self):
        """agent_learned_insights indeksləri və RLS siyasətləri"""
        sql = self.sql_content

        # Domain index on (agent_id, domain)
        self.assertIn("idx_agent_insights_domain", sql)
        self.assertIn("public.agent_learned_insights (agent_id, domain)", sql)

        # RLS enabled
        self.assertIn("ALTER TABLE public.agent_learned_insights ENABLE ROW LEVEL SECURITY", sql)

        # Operator policy
        self.assertIn('POLICY "Operators read and append own insights"', sql)
        self.assertIn("auth.uid() = operator_id", sql)

    def test_table_grants(self):
        """Cədvəl hüquqları (anon, authenticated, service_role)"""
        sql = self.sql_content
        self.assertIn("GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_conversations TO anon, authenticated, service_role", sql)
        self.assertIn("GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_learned_insights TO anon, authenticated, service_role", sql)

    def test_balanced_parentheses_and_quotes(self):
        """SQL sintaksis təmizliyi (mötərizələr və dırnaqlar)"""
        # Remove comments before checking parenthesis balance
        cleaned = re.sub(r"--[^\n]*", "", self.sql_content)
        cleaned = re.sub(r"/\*[\s\S]*?\*/", "", cleaned)

        open_parens = cleaned.count("(")
        close_parens = cleaned.count(")")
        self.assertEqual(open_parens, close_parens, f"Unbalanced parentheses: (={open_parens}, )={close_parens}")


if __name__ == "__main__":
    unittest.main()
