"use client";

import React, { useState } from "react";
import {
  MessageSquare,
  ExternalLink,
  Save,
  CheckCircle2,
  X,
  Maximize2,
  Minimize2,
  RefreshCw,
  Tag,
  ShieldCheck,
  User,
  Bot,
  Copy,
  AlertCircle,
} from "lucide-react";
import type { StageCardInstance, CrmNegotiationPayload } from "@/lib/copilot-context";
import { createClient } from "@/lib/supabase/client";

export interface CrmNegotiationCardProps {
  card: StageCardInstance;
  isMaximized?: boolean;
  onMaximizeToggle?: () => void;
  onClose?: () => void;
  onRefresh?: () => void;
}

export function CrmNegotiationCard({
  card,
  isMaximized = false,
  onMaximizeToggle,
  onClose,
  onRefresh,
}: CrmNegotiationCardProps) {
  const payload = card.payload as CrmNegotiationPayload;

  const leadId = payload.leadId || card.targetEntityId || "";
  const leadName = payload.leadName?.trim() || "Müştəri";
  const phone = payload.phone || "";

  const dialogueHistory =
    payload.dialogueHistory && payload.dialogueHistory.length > 0
      ? payload.dialogueHistory
      : [];

  const defaultDraft = payload.draftText || "";

  const [draftText, setDraftText] = useState(defaultDraft);
  const [isCopied, setIsCopied] = useState(false);

  // Extracted objection tag state (only when provided by payload)
  const initialObjection = payload.extractedObjection ?? null;

  const [objection, setObjection] = useState<typeof initialObjection>(initialObjection);

  // Save insight state
  const [isSavingInsight, setIsSavingInsight] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Clean phone number for wa.me
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const waLink =
    payload.waLink ||
    (cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(draftText)}` : "");

  const handleCopy = () => {
    navigator.clipboard.writeText(draftText);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleSaveInsight = async () => {
    if (!objection || isSavingInsight || saveStatus === "saved") return;
    setIsSavingInsight(true);
    setSaveStatus("loading");
    setSaveError(null);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
      } catch {
        // Cookie auth fallback
      }

      const res = await fetch("/api/ai/copilot", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "save_insight",
          agent_id: "musteri_psixologiyasi",
          domain: objection.domain || "OBJECTION_PRICE_PER_M2",
          insight_text: objection.insightText,
          confidence_score: objection.confidence || 0.95,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false || (!data?.ok && data?.status !== "success")) {
        throw new Error(data?.error || "İnsayt yaddaşa yazıla bilmədi");
      }

      setSaveStatus("saved");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Yaddaşa yazarkən xəta baş verdi";
      setSaveError(msg);
      setSaveStatus("error");
    } finally {
      setIsSavingInsight(false);
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-obsidian-950/95 border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-xl transition-all duration-300">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-obsidian-900/90 border-b border-slate-800/80 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-200 truncate">
                {leadName}
                {leadId ? ` (#${leadId})` : ""}
              </span>
              {cleanPhone && (
                <span className="px-2 py-0.5 text-[10px] font-mono text-emerald-300 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                  +{cleanPhone}
                </span>
              )}
              <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                Müştəri Psixologiyası
              </span>
            </div>
            <p className="text-[11px] text-slate-400 truncate">
              {payload.listingSpecs?.title || "Müştəri danışığı və cavab hazırlığı"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Yenilə"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
          {onMaximizeToggle && (
            <button
              onClick={onMaximizeToggle}
              title={isMaximized ? "Kiçilt" : "Böyüt"}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
            >
              {isMaximized ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              title="Bağla"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Main Content Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* WhatsApp Chat Dialogue Thread */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-xs text-slate-400 px-1">
            <span className="font-medium flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
              WhatsApp Yazışma Arxivi
            </span>
            <span className="text-[10px]">Real vaxt sinxronizasiyası</span>
          </div>

          <div className="p-3.5 rounded-xl bg-obsidian-900/90 border border-slate-800/80 space-y-3">
            {dialogueHistory.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">
                Yazışma tarixçəsi hələ mövcud deyil.
              </p>
            ) : (
              dialogueHistory.map((item, idx) => (
                <div
                  key={item.id || idx}
                  className={`flex gap-2.5 ${
                    item.sender === "lead" ? "justify-start" : "justify-end"
                  }`}
                >
                  {item.sender === "lead" && (
                    <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 text-xs shrink-0">
                      <User className="w-3.5 h-3.5" />
                    </div>
                  )}
                  <div
                    className={`max-w-[85%] rounded-2xl p-3 text-xs leading-relaxed ${
                      item.sender === "lead"
                        ? "bg-slate-800/90 text-slate-200 border border-slate-700/60 rounded-tl-sm"
                        : "bg-emerald-600/20 text-emerald-100 border border-emerald-500/30 rounded-tr-sm"
                    }`}
                  >
                    <p>{item.text}</p>
                    {item.time && (
                      <span className="block text-[9px] text-slate-400 mt-1 text-right">
                        {item.time}
                      </span>
                    )}
                  </div>
                  {item.sender !== "lead" && (
                    <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 text-xs shrink-0">
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Extracted Objection & 1-Click Human Confirmation */}
        {objection && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Tag className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-semibold text-amber-300">
                  Aşkarlanmış Alıcı Etirazı (Avtonom Analiz)
                </span>
              </div>
              <button
                onClick={() => setObjection(null)}
                title="Etirazı ləğv et"
                className="text-slate-400 hover:text-slate-200 p-0.5 rounded transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/20 text-amber-200 border border-amber-500/30">
                🏷️ {objection.tag}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">
                Dəqiqlik: {Math.round((objection.confidence || 0.9) * 100)}%
              </span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed bg-black/30 p-2 rounded-lg border border-slate-800">
              {objection.insightText}
            </p>

            <div className="flex items-center justify-between pt-1">
              <span className="text-[10px] text-slate-400">
                Təsdiqləndikdən sonra Müştəri Psixologiyası yaddaşına yazılır.
              </span>
              <button
                onClick={handleSaveInsight}
                disabled={isSavingInsight || saveStatus === "saved"}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  saveStatus === "saved"
                    ? "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 cursor-default"
                    : isSavingInsight
                    ? "bg-amber-600/80 text-obsidian-950 cursor-wait"
                    : "bg-amber-500 hover:bg-amber-400 text-obsidian-950 font-semibold shadow-md active:scale-95"
                }`}
              >
                {saveStatus === "saved" ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>✅ Yaddaşa Yazıldı</span>
                  </>
                ) : isSavingInsight ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Yazılır...</span>
                  </>
                ) : (
                  <>
                    <Save className="w-3.5 h-3.5" />
                    <span>💾 Təsdiqlə və Yaddaşa Yaz</span>
                  </>
                )}
              </button>
            </div>

            {saveError && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{saveError}</span>
              </div>
            )}
          </div>
        )}

        {/* AI Drafted Authentic Baku Response */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-300 px-1">
            <span className="font-semibold flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Təbii Bakı Dialektində Cavab Təklifi
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
              >
                <Copy className="w-3 h-3" />
                <span>{isCopied ? "Kopyalandı!" : "Kopyala"}</span>
              </button>
            </div>
          </div>

          <div className="relative rounded-xl overflow-hidden border border-slate-700/80 bg-obsidian-900/90 focus-within:border-emerald-500/80 transition-colors">
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              rows={4}
              className="w-full p-3.5 bg-transparent text-slate-100 text-xs leading-relaxed resize-none focus:outline-none"
              placeholder="WhatsApp cavab mətni..."
            />
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-400 px-1">
            <span>Anti-korporativ filtr aktivdir (Süni girişlər yoxdur).</span>
            <span>{draftText.length} simvol</span>
          </div>
        </div>

        {/* Primary Action Button: WhatsApp Launcher */}
        <div className="pt-2">
          {waLink ? (
            <>
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-obsidian-950 transition-all duration-200 shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98]"
              >
                <MessageSquare className="w-4 h-4 fill-current" />
                <span>💬 WhatsApp-da Aç</span>
                <ExternalLink className="w-3.5 h-3.5 opacity-70 ml-1" />
              </a>
              <p className="text-[10px] text-center text-slate-400 mt-1.5">
                Müştərinin WhatsApp nömrəsinə birbaşa pre-filled cavabla keçid açılacaq.
              </p>
            </>
          ) : (
            <div className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-medium bg-slate-800/70 text-slate-400 border border-slate-700/60">
              <MessageSquare className="w-4 h-4" />
              <span>WhatsApp nömrəsi mövcud deyil</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
