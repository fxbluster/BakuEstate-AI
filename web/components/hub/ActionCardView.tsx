"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  MessageCircle,
  BookmarkCheck,
  TrendingUp,
  Copy,
  Check,
  Loader2,
  ArrowRight,
} from "lucide-react";
import type { ActionCardPayload } from "@/lib/ai-client";
import { invokeCopilot } from "@/lib/ai-client";
import { buildWhatsAppUrl } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

interface ActionCardViewProps {
  card: ActionCardPayload;
  onActionComplete?: (type: string) => void;
}

const STAGE_LABELS: Record<string, string> = {
  NEW_INQUIRY: "Yeni Sorğu",
  QUALIFIED: "Təsdiqlənmiş",
  VIEWING_SCHEDULED: "Baxış Təyin Edilib",
  VIEWED: "Baxış Keçirildi",
  NEGOTIATING: "Danışıqlar",
  DEPOSIT: "Beh / Depozit",
  WON_CLOSED: "Uğurla Bağlandı",
  LOST: "İtirildi",
  COLD: "Soyuq",
};

export function ActionCardView({ card, onActionComplete }: ActionCardViewProps) {
  const [status, setStatus] = useState<"PENDING" | "EXECUTING" | "EXECUTED" | "ERROR">("PENDING");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 1. UPDATE_LEAD_STAGE Handler
  const handleConfirmStageUpdate = async () => {
    if (card.type !== "UPDATE_LEAD_STAGE") return;
    setStatus("EXECUTING");
    setErrorMessage(null);

    try {
      const supabase = createClient();

      // 1. Update buyer_leads table
      const { error: updateError } = await supabase
        .from("buyer_leads")
        .update({
          stage: card.recommended_stage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", card.lead_id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // 2. Append immutable record to lead_timeline_events
      const { error: timelineError } = await supabase
        .from("lead_timeline_events")
        .insert({
          lead_id: card.lead_id,
          actor: "AI_HUB",
          event_type: "STAGE_CHANGE",
          summary: `Mərhələ yeniləndi: ${STAGE_LABELS[card.current_stage] || card.current_stage} ➔ ${STAGE_LABELS[card.recommended_stage] || card.recommended_stage}`,
          metadata: {
            from_stage: card.current_stage,
            to_stage: card.recommended_stage,
            rationale: card.rationale,
            timestamp: new Date().toISOString(),
          },
        });

      if (timelineError) {
        console.warn("Timeline log warning:", timelineError.message);
      }

      setStatus("EXECUTED");
      onActionComplete?.(card.type);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg || "Mərhələ yenilənərkən xəta baş verdi.");
      setStatus("ERROR");
    }
  };

  // 2. DISPATCH_WHATSAPP Handler
  const handleOpenWhatsApp = () => {
    if (card.type !== "DISPATCH_WHATSAPP") return;
    const url = card.wa_link || buildWhatsAppUrl(card.phone_number, card.draft_text);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      setStatus("EXECUTED");
      onActionComplete?.(card.type);
    }
  };

  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  // 3. SAVE_INSIGHT Handler (routed via /api/ai/copilot to avoid client RLS / schema drift)
  const handleSaveInsight = async () => {
    if (card.type !== "SAVE_INSIGHT") return;
    setStatus("EXECUTING");
    setErrorMessage(null);

    try {
      const res = await invokeCopilot({
        action: "save_insight",
        agent_id: card.agent_id,
        domain: card.domain,
        insight_text: card.insight_text,
        confidence_score: card.confidence_score,
      });

      if (!res.ok) {
        throw new Error(res.error || "Episodik yaddaşa yazılarkən xəta baş verdi.");
      }

      setStatus("EXECUTED");
      onActionComplete?.(card.type);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg || "Episodik yaddaşa yazılarkən xəta baş verdi.");
      setStatus("ERROR");
    }
  };

  // Render Based on Type
  if (card.type === "UPDATE_LEAD_STAGE") {
    const fromLabel = STAGE_LABELS[card.current_stage] || card.current_stage;
    const toLabel = STAGE_LABELS[card.recommended_stage] || card.recommended_stage;

    return (
      <div className="mt-2.5 rounded-xl border border-gold-500/30 bg-gradient-to-br from-gold-500/10 via-obsidian-950 to-obsidian-900 p-3 shadow-md">
        <div className="flex items-center justify-between gap-2 border-b border-gold-500/20 pb-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-gold-300">
            <TrendingUp className="h-4 w-4 text-gold-400" />
            <span>Tövsiyə Edilən CRM Mərhələsi</span>
          </div>
          <span className="rounded bg-gold-500/20 px-1.5 py-0.5 text-[10px] font-mono text-gold-400">
            1-Klik İcra
          </span>
        </div>

        <div className="my-2.5 flex items-center justify-center gap-2 rounded-lg bg-obsidian-900/80 px-3 py-2 text-xs">
          <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 line-through opacity-70">
            {fromLabel}
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-gold-400" />
          <span className="rounded bg-emerald-950/80 border border-emerald-500/40 px-2 py-0.5 font-bold text-emerald-300">
            {toLabel}
          </span>
        </div>

        {card.rationale && (
          <p className="text-[11px] text-slate-400 italic mb-3 leading-relaxed">
            💡 {card.rationale}
          </p>
        )}

        {errorMessage && (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-rose-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {status === "EXECUTED" ? (
            <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Mərhələ Yeniləndi</span>
            </div>
          ) : (
            <button
              type="button"
              disabled={status === "EXECUTING"}
              onClick={handleConfirmStageUpdate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-gold-500 to-amber-500 px-3 py-1.5 text-xs font-bold text-obsidian-950 shadow-sm transition hover:brightness-110 active:scale-95 disabled:opacity-50"
            >
              {status === "EXECUTING" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Yenilənir...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Mərhələni Təsdiq Et</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (card.type === "DISPATCH_WHATSAPP") {
    return (
      <div className="mt-2.5 rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-obsidian-950 to-obsidian-900 p-3 shadow-md">
        <div className="flex items-center justify-between gap-2 border-b border-emerald-500/20 pb-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
            <MessageCircle className="h-4 w-4 text-emerald-400" />
            <span>WhatsApp Danışıq Skripti</span>
          </div>
          {card.listing_code && (
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-mono text-emerald-400">
              Kod: {card.listing_code}
            </span>
          )}
        </div>

        <div className="my-2.5 rounded-lg border border-slate-800 bg-obsidian-900/90 p-2.5">
          <p className="text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">
            {card.draft_text}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => handleCopyText(card.draft_text)}
            className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-400">Kopyalandı</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>Kopyala</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleOpenWhatsApp}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition active:scale-95"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            <span>WhatsApp-da Göndər</span>
            <ExternalLink className="h-3 w-3 opacity-80" />
          </button>
        </div>
      </div>
    );
  }

  if (card.type === "SAVE_INSIGHT") {
    return (
      <div className="mt-2.5 rounded-xl border border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-obsidian-950 to-obsidian-900 p-3 shadow-md">
        <div className="flex items-center justify-between gap-2 border-b border-violet-500/20 pb-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-violet-300">
            <BookmarkCheck className="h-4 w-4 text-violet-400" />
            <span>Episodik Yaddaş Qeydi</span>
          </div>
          <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-mono text-violet-300">
            Domen: {card.domain} ({Math.round(card.confidence_score * 100)}%)
          </span>
        </div>

        <div className="my-2.5 rounded-lg border border-slate-800 bg-obsidian-900/90 p-2.5">
          <p className="text-xs text-slate-200 leading-relaxed italic">
            &ldquo;{card.insight_text}&rdquo;
          </p>
        </div>

        {errorMessage && (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-rose-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {status === "EXECUTED" ? (
            <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>Yaddaşa Əlavə Edildi</span>
            </div>
          ) : (
            <button
              type="button"
              disabled={status === "EXECUTING"}
              onClick={handleSaveInsight}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition hover:brightness-110 active:scale-95 disabled:opacity-50"
            >
              {status === "EXECUTING" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Yazılır...</span>
                </>
              ) : (
                <>
                  <BookmarkCheck className="h-3.5 w-3.5" />
                  <span>Yaddaşa Saxla</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}
