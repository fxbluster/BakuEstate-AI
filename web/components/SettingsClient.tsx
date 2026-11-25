"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Percent,
  Phone,
  Save,
  Settings,
  Shield,
  Sliders,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { AgencyMember, AgencyRole, AgencySettings } from "@/lib/types";

interface SettingsClientProps {
  initialSettings: AgencySettings;
  initialMembers: AgencyMember[];
  currentUserId: string;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }
  } catch {
    // Fallback to cookie auth
  }
  return headers;
}

export function SettingsClient({
  initialSettings,
  initialMembers,
  currentUserId,
}: SettingsClientProps) {
  const [publicPhone, setPublicPhone] = useState(
    initialSettings.public_phone ?? ""
  );
  const [telegramChatId, setTelegramChatId] = useState(
    initialSettings.telegram_chat_id ?? ""
  );
  const [socialApiMode, setSocialApiMode] = useState<
    "OFFICIAL" | "TELEGRAM_FALLBACK"
  >(initialSettings.social_api_mode ?? "TELEGRAM_FALLBACK");

  const [luxuryMinAzn, setLuxuryMinAzn] = useState(
    String(initialSettings.niche_rules_json?.luxury_min_azn ?? 250000)
  );
  const [affordableMaxAzn, setAffordableMaxAzn] = useState(
    String(initialSettings.niche_rules_json?.affordable_max_azn ?? 120000)
  );
  const [viralDropPct, setViralDropPct] = useState(
    String(initialSettings.niche_rules_json?.viral_drop_pct ?? 10)
  );

  const [watermarkText, setWatermarkText] = useState(
    String(
      (initialSettings.watermark_preset_json as Record<string, unknown>)
        ?.text ?? ""
    )
  );
  const [watermarkPosition, setWatermarkPosition] = useState(
    String(
      (initialSettings.watermark_preset_json as Record<string, unknown>)
        ?.position ?? "bottom-right"
    )
  );

  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState(
    String(initialSettings.monthly_ai_budget_usd ?? 50)
  );
  const [aiRateLimitRpm, setAiRateLimitRpm] = useState(
    String(initialSettings.ai_rate_limit_rpm ?? 20)
  );

  const [members, setMembers] = useState<AgencyMember[]>(initialMembers);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingMemberId, setSavingMemberId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  async function handleSaveSettings(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSavingSettings(true);
    setFeedback(null);

    try {
      const headers = await getAuthHeaders();
      const payload = {
        public_phone: publicPhone.trim(),
        telegram_chat_id: telegramChatId.trim() || null,
        social_api_mode: socialApiMode,
        niche_rules_json: {
          luxury_min_azn: Number(luxuryMinAzn) || 250000,
          affordable_max_azn: Number(affordableMaxAzn) || 120000,
          viral_drop_pct: Number(viralDropPct) || 10,
        },
        watermark_preset_json: {
          ...(initialSettings.watermark_preset_json ?? {}),
          text: watermarkText.trim(),
          position: watermarkPosition,
        },
        monthly_ai_budget_usd: Math.max(0, Number(monthlyBudgetUsd) || 0),
        ai_rate_limit_rpm: Math.max(1, Number(aiRateLimitRpm) || 20),
      };

      const res = await fetch("/api/agency/settings", {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(
          data?.error || `Ayarlar saxlanmadı (HTTP ${res.status})`
        );
      }

      setFeedback({
        type: "ok",
        text: "Agentlik ayarları yeniləndi. Niş qaydaları dəyişibsə kanonik nişlər yenidən hesablandı.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: err instanceof Error ? err.message : "Ayar saxlama xətası",
      });
    } finally {
      setSavingSettings(false);
    }
  }

  function updateMemberLocal(
    userId: string,
    patch: Partial<Pick<AgencyMember, "role" | "commission_split_pct" | "is_active">>
  ) {
    setMembers((prev) =>
      prev.map((m) => (m.user_id === userId ? { ...m, ...patch } : m))
    );
  }

  async function handleSaveMember(member: AgencyMember) {
    setSavingMemberId(member.user_id);
    setFeedback(null);

    try {
      const split = Number(member.commission_split_pct);
      if (Number.isNaN(split) || split < 0 || split > 100) {
        throw new Error("Komissiya payı 0 ilə 100 arasında olmalıdır.");
      }

      const headers = await getAuthHeaders();
      const res = await fetch("/api/agency/members", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          user_id: member.user_id,
          role: member.role,
          commission_split_pct: split,
          is_active: member.is_active,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(
          data?.error || `Üzv məlumatı yenilənmədi (HTTP ${res.status})`
        );
      }

      setFeedback({
        type: "ok",
        text: `${member.display_name} üçün rol (${member.role}), komissiya (${split}%) və status yeniləndi.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: err instanceof Error ? err.message : "Üzv yeniləmə xətası",
      });
    } finally {
      setSavingMemberId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Admin Nəzarət Paneli
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Agentlik Ayarları &amp; Komanda
          </h1>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-gold-500/40 bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300">
          <Shield className="h-3.5 w-3.5" />
          <span>ADMIN İcazəsi</span>
        </span>
      </div>

      {feedback && (
        <div
          className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${
            feedback.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          <span className="flex items-center gap-2">
            {feedback.type === "ok" && <CheckCircle2 className="h-4 w-4" />}
            <span>{feedback.text}</span>
          </span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs opacity-75 hover:opacity-100"
          >
            Bağla
          </button>
        </div>
      )}

      {/* Agency Settings Form */}
      <form onSubmit={handleSaveSettings} className="exec-card p-6 space-y-6">
        <div className="flex items-center gap-2 border-b border-slate-800/80 pb-3">
          <Settings className="h-5 w-5 text-gold-400" />
          <h2 className="text-base font-semibold text-slate-100">
            Ümumi Parametrlər, Niş Qaydaları &amp; AI Büdcəsi
          </h2>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <label
              htmlFor="settings-public-phone"
              className="flex items-center gap-1.5 text-xs font-medium text-slate-300"
            >
              <Phone className="h-3.5 w-3.5 text-gold-400" />
              <span>İctimai Telefon</span>
            </label>
            <input
              id="settings-public-phone"
              type="text"
              required
              value={publicPhone}
              onChange={(e) => setPublicPhone(e.target.value)}
              placeholder="+994 50 000 00 00"
              className="exec-input text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="settings-telegram-chat"
              className="text-xs font-medium text-slate-300"
            >
              Telegram Chat ID
            </label>
            <input
              id="settings-telegram-chat"
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="-1001234567890"
              className="exec-input text-xs font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="settings-social-mode"
              className="text-xs font-medium text-slate-300"
            >
              Sosial API Rejimi
            </label>
            <select
              id="settings-social-mode"
              value={socialApiMode}
              onChange={(e) =>
                setSocialApiMode(
                  e.target.value as "OFFICIAL" | "TELEGRAM_FALLBACK"
                )
              }
              className="exec-select w-full text-xs"
            >
              <option value="TELEGRAM_FALLBACK">
                TELEGRAM_FALLBACK (Keçid Rejimi)
              </option>
              <option value="OFFICIAL">
                OFFICIAL (Rəsmi Meta &amp; TikTok API)
              </option>
            </select>
          </div>
        </div>

        {/* Niche Rules */}
        <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/60 p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-gold-300">
            <Sliders className="h-4 w-4" />
            <span>Kanonik Niş Hədləri (Dəyişdikdə Elanlar Yenidən Hesablanır)</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label
                htmlFor="settings-luxury-min"
                className="text-xs text-slate-300"
              >
                Lüks Min. Qiymət (AZN)
              </label>
              <input
                id="settings-luxury-min"
                type="number"
                min="0"
                value={luxuryMinAzn}
                onChange={(e) => setLuxuryMinAzn(e.target.value)}
                className="exec-input text-xs"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="settings-affordable-max"
                className="text-xs text-slate-300"
              >
                Sərfəli Maks. Qiymət (AZN)
              </label>
              <input
                id="settings-affordable-max"
                type="number"
                min="0"
                value={affordableMaxAzn}
                onChange={(e) => setAffordableMaxAzn(e.target.value)}
                className="exec-input text-xs"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="settings-viral-drop"
                className="text-xs text-slate-300"
              >
                Viral Endirim Həddi (%)
              </label>
              <input
                id="settings-viral-drop"
                type="number"
                min="1"
                max="90"
                value={viralDropPct}
                onChange={(e) => setViralDropPct(e.target.value)}
                className="exec-input text-xs"
              />
            </div>
          </div>
        </div>

        {/* Watermark & AI Budget */}
        <div className="grid gap-4 md:grid-cols-4">
          <div className="space-y-1.5">
            <label
              htmlFor="settings-watermark-text"
              className="text-xs font-medium text-slate-300"
            >
              Su Nişanı Mətni
            </label>
            <input
              id="settings-watermark-text"
              type="text"
              value={watermarkText}
              onChange={(e) => setWatermarkText(e.target.value)}
              placeholder="BakuEstate.az"
              className="exec-input text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="settings-watermark-pos"
              className="text-xs font-medium text-slate-300"
            >
              Su Nişanı Mövqeyi
            </label>
            <select
              id="settings-watermark-pos"
              value={watermarkPosition}
              onChange={(e) => setWatermarkPosition(e.target.value)}
              className="exec-select w-full text-xs"
            >
              <option value="bottom-right">Aşağı Sağ</option>
              <option value="bottom-left">Aşağı Sol</option>
              <option value="top-right">Yuxarı Sağ</option>
              <option value="top-left">Yuxarı Sol</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="settings-ai-budget"
              className="flex items-center gap-1.5 text-xs font-medium text-slate-300"
            >
              <Cpu className="h-3.5 w-3.5 text-gold-400" />
              <span>Aylıq AI Büdcə (USD)</span>
            </label>
            <input
              id="settings-ai-budget"
              type="number"
              min="0"
              step="1"
              value={monthlyBudgetUsd}
              onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
              className="exec-input text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="settings-ai-rpm"
              className="text-xs font-medium text-slate-300"
            >
              AI Rate Limit (RPM)
            </label>
            <input
              id="settings-ai-rpm"
              type="number"
              min="1"
              max="500"
              value={aiRateLimitRpm}
              onChange={(e) => setAiRateLimitRpm(e.target.value)}
              className="exec-input text-xs"
            />
          </div>
        </div>

        <div className="flex justify-end border-t border-slate-800/80 pt-4">
          <button
            type="submit"
            disabled={savingSettings}
            className="exec-btn-primary text-xs"
          >
            <Save className="h-3.5 w-3.5" />
            <span>
              {savingSettings ? "Saxlanılır..." : "Ayarları Yadda Saxla"}
            </span>
          </button>
        </div>
      </form>

      {/* Team Members & Commission Split Management */}
      <section className="exec-card p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-gold-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Komanda Üzvləri &amp; Komissiya Bölgüsü ({members.length})
              </h2>
              <p className="text-xs text-slate-400">
                Rol (ADMIN / BROKER / SMM), aktivlik statusu və broker komissiya
                faizini (<code className="font-mono">commission_split_pct</code>)
                idarə edin.
              </p>
            </div>
          </div>
        </div>

        {members.length === 0 ? (
          <p className="text-xs text-slate-400 py-4 text-center">
            Agentlik üzvü tapılmadı.
          </p>
        ) : (
          <div className="space-y-3">
            {members.map((m) => {
              const isSelf = m.user_id === currentUserId;
              const saving = savingMemberId === m.user_id;

              return (
                <div
                  key={m.user_id}
                  className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-obsidian-950/70 p-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-100">
                        {m.display_name}
                      </span>
                      {isSelf && (
                        <span className="rounded-full border border-gold-500/40 bg-gold-500/15 px-2 py-0.5 text-[10px] font-semibold text-gold-300">
                          Siz
                        </span>
                      )}
                      {!m.is_active && (
                        <span className="rounded-full border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-300">
                          Deaktiv
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-slate-500 truncate">
                      {m.whatsapp_phone || m.user_id}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <select
                      aria-label={`Rol — ${m.display_name}`}
                      value={m.role}
                      onChange={(e) =>
                        updateMemberLocal(m.user_id, {
                          role: e.target.value as AgencyRole,
                        })
                      }
                      className="exec-select py-1.5 text-xs"
                    >
                      <option value="ADMIN">ADMIN</option>
                      <option value="BROKER">BROKER</option>
                      <option value="SMM">SMM</option>
                    </select>

                    <div className="flex items-center gap-1.5">
                      <Percent className="h-3.5 w-3.5 text-gold-400" />
                      <input
                        aria-label={`Komissiya Payı — ${m.display_name}`}
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={m.commission_split_pct}
                        onChange={(e) =>
                          updateMemberLocal(m.user_id, {
                            commission_split_pct: Number(e.target.value),
                          })
                        }
                        className="exec-input w-20 py-1.5 text-xs text-center font-mono"
                      />
                      <span className="text-xs text-slate-400">%</span>
                    </div>

                    <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-obsidian-900 px-2.5 py-1.5 text-xs text-slate-200 cursor-pointer">
                      <input
                        aria-label={`Status — ${m.display_name}`}
                        type="checkbox"
                        checked={m.is_active}
                        disabled={isSelf}
                        onChange={(e) =>
                          updateMemberLocal(m.user_id, {
                            is_active: e.target.checked,
                          })
                        }
                        className="accent-gold-400"
                      />
                      <span>{m.is_active ? "Aktiv" : "Deaktiv"}</span>
                    </label>

                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleSaveMember(m)}
                      className="exec-btn-secondary py-1.5 text-xs"
                    >
                      <Save className="h-3.5 w-3.5 text-gold-400" />
                      <span>{saving ? "Saxlanır..." : "Üzvü Saxla"}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
