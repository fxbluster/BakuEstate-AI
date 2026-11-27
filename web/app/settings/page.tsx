import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient, getServerSessionMember } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { SettingsClient } from "@/components/SettingsClient";
import type { AgencyMember, AgencySettings } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="exec-card p-8 text-center space-y-3">
        <p className="text-sm text-slate-300">
          Supabase bağlantısı konfiqurasiya edilməyib.
        </p>
        <Link href="/" className="exec-btn-secondary text-xs">
          İcmala qayıt
        </Link>
      </div>
    );
  }

  const member = await getServerSessionMember();
  if (!member) {
    redirect("/login");
  }

  if (member.role !== "ADMIN") {
    return (
      <div className="exec-card max-w-xl mx-auto p-8 text-center space-y-4 border-rose-500/40 bg-rose-950/15">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-500/40 bg-rose-500/15 text-rose-300">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-bold text-slate-100">
            İcazə Məhdudiyyəti — Yalnız ADMIN
          </h1>
          <p className="text-xs text-slate-300 leading-relaxed">
            Agentlik ayarları, niş yönləndirmə qaydaları, AI büdcəsi və komanda
            komissiya bölgüsü yalnız <strong className="text-gold-300">ADMIN</strong>{" "}
            roluna malik istifadəçilər üçün açıqdır.
          </p>
        </div>
        <div>
          <Link href="/" className="exec-btn-secondary text-xs">
            İcmal Səhifəsinə Qayıt
          </Link>
        </div>
      </div>
    );
  }

  const supabase = await createClient();

  const [settingsRes, membersRes] = await Promise.all([
    supabase
      .from("agency_settings")
      .select("*")
      .eq("agency_id", member.agency_id)
      .maybeSingle(),
    supabase
      .from("agency_members")
      .select(
        "user_id, agency_id, role, display_name, whatsapp_phone, telegram_chat_id, commission_split_pct, is_active, created_at"
      )
      .eq("agency_id", member.agency_id)
      .order("created_at", { ascending: true }),
  ]);

  const fallbackSettings: AgencySettings = {
    agency_id: member.agency_id,
    public_phone: "+994 50 000 00 00",
    telegram_chat_id: null,
    niche_rules_json: {
      luxury_min_azn: 250000,
      affordable_max_azn: 120000,
      viral_drop_pct: 10,
    },
    social_api_mode: "TELEGRAM_FALLBACK",
    watermark_preset_json: {},
    monthly_ai_budget_usd: 50,
    ai_rate_limit_rpm: 20,
    auto_render_enabled: false,
    updated_at: new Date().toISOString(),
  };

  const initialSettings =
    (settingsRes.data as AgencySettings | null) ?? fallbackSettings;
  const initialMembers = (membersRes.data as AgencyMember[] | null) ?? [];

  return (
    <SettingsClient
      initialSettings={initialSettings}
      initialMembers={initialMembers}
      currentUserId={member.user_id}
    />
  );
}
