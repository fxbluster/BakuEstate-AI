"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  X,
  Shield,
  ShieldAlert,
  MessageCircle,
  Mic,
  MicOff,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Save,
  CheckCircle2,
  Zap,
  Building2,
  User,
  FileEdit,
} from "lucide-react";
import { useCopilot } from "@/lib/copilot-context";
import { checkAddressLeak, checkCommissionShaving } from "@/lib/copilot-core";
import {
  invokeCopilot,
  SentinelAuditResult,
  ScribeTemplateResult,
  VoiceDebriefResult,
} from "@/lib/ai-client";
import { buildWhatsAppUrl } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { LeadStage } from "@/lib/types";

const STAGE_OPTIONS: { value: LeadStage; label: string }[] = [
  { value: "NEW_INQUIRY", label: "Yeni Sorğu (New Inquiry)" },
  { value: "QUALIFIED", label: "Təsdiqlənmiş (Qualified)" },
  { value: "VIEWING_SCHEDULED", label: "Baxış Təyin Edilib" },
  { value: "VIEWED", label: "Baxış Keçirildi (Viewed)" },
  { value: "NEGOTIATING", label: "Danışıqlar (Negotiating)" },
  { value: "DEPOSIT", label: "Beh / Depozit (Deposit)" },
  { value: "WON_CLOSED", label: "Uğurla Bağlandı (Won)" },
  { value: "LOST", label: "İtirildi (Lost)" },
  { value: "COLD", label: "Soyuq (Cold)" },
];

/**
 * Negotiates dynamic audio MIME type supported by browser.
 * Safari / iOS requires audio/mp4 or audio/aac.
 * Chrome / Android uses audio/webm;codecs=opus.
 */
function getSupportedMimeType(): {
  canonical: "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/aac";
  codecString: string;
} {
  if (typeof window === "undefined" || !("MediaRecorder" in window)) {
    return { canonical: "audio/webm", codecString: "audio/webm" };
  }

  const candidates: {
    codec: string;
    canonical: "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/aac";
  }[] = [
    { codec: "audio/webm;codecs=opus", canonical: "audio/webm" },
    { codec: "audio/webm", canonical: "audio/webm" },
    { codec: "audio/mp4", canonical: "audio/mp4" },
    { codec: "audio/aac", canonical: "audio/aac" },
    { codec: "audio/ogg;codecs=opus", canonical: "audio/ogg" },
    { codec: "audio/ogg", canonical: "audio/ogg" },
  ];

  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.codec)) {
      return { canonical: c.canonical, codecString: c.codec };
    }
  }

  return { canonical: "audio/webm", codecString: "" };
}

export function CopilotDrawer() {
  const {
    isOpen,
    closeCopilot,
    activeTab,
    setActiveTab,
    selectedLeadId,
    selectedListingId,
    initialText,
  } = useCopilot();

  // Tab 1: Shield State
  const [shieldInput, setShieldInput] = useState("");
  const [shieldLoading, setShieldLoading] = useState(false);
  const [shieldError, setShieldError] = useState<string | null>(null);
  const [sentinelResult, setSentinelResult] = useState<SentinelAuditResult | null>(null);
  const [scribeResult, setScribeResult] = useState<ScribeTemplateResult | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [phoneForWa, setPhoneForWa] = useState("");

  // Tab 2: Showing Debrief State
  const [debriefNotes, setDebriefNotes] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [debriefResult, setDebriefResult] = useState<VoiceDebriefResult | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [savingLead, setSavingLead] = useState(false);

  // Editable fields for debrief review
  const [editTranscript, setEditTranscript] = useState("");
  const [editStage, setEditStage] = useState<string>("VIEWED");
  const [editOfferAzn, setEditOfferAzn] = useState<string>("");
  const [editObjections, setEditObjections] = useState<string>("");
  const [editNextAction, setEditNextAction] = useState("");

  // MediaRecorder refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const negotiatedMimeRef = useRef<ReturnType<typeof getSupportedMimeType>>({
    canonical: "audio/webm",
    codecString: "audio/webm",
  });

  // Synchronize initialText if provided
  useEffect(() => {
    if (initialText) {
      setShieldInput(initialText);
    }
  }, [initialText]);

  // Fetch lead phone if leadId is set
  useEffect(() => {
    if (!selectedLeadId) {
      setPhoneForWa("");
      return;
    }
    async function loadLeadPhone() {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("buyer_leads")
          .select("phone_normalized")
          .eq("id", selectedLeadId)
          .maybeSingle();
        if (data) {
          setPhoneForWa(data.phone_normalized || "");
        }
      } catch {
        // Ignore
      }
    }
    loadLeadPhone();
  }, [selectedLeadId]);

  // Real-time deterministic scans on shieldInput
  const addressScan = checkAddressLeak(shieldInput);
  const commissionScan = checkCommissionShaving(shieldInput);

  // Cleanup audio timer on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const handleCopy = useCallback(async (text: string, fieldId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Fallback
    }
  }, []);

  // 1-Click Sanitization replacement
  const handleApplySanitization = useCallback(() => {
    if (addressScan.sanitizedText) {
      setShieldInput(addressScan.sanitizedText);
    }
  }, [addressScan.sanitizedText]);

  // Tab 1: Run Sentinel & Scribe AI Audit
  const handleRunShieldAudit = async () => {
    if (!shieldInput.trim()) return;
    setShieldLoading(true);
    setShieldError(null);
    setSentinelResult(null);
    setScribeResult(null);

    try {
      // 1. Sentinel Audit
      const auditRes = await invokeCopilot<SentinelAuditResult>({
        action: "sentinel_audit",
        text: shieldInput,
        listing_id: selectedListingId || undefined,
      });

      if (auditRes.ok && auditRes.data) {
        setSentinelResult(auditRes.data);
      } else if (!auditRes.ok) {
        setShieldError(auditRes.error || "Sentinel təhlili zamanı xəta baş verdi.");
      }

      // 2. Scribe Response Draft
      const scribeRes = await invokeCopilot<ScribeTemplateResult>({
        action: "scribe_response",
        prompt: shieldInput,
        lead_id: selectedLeadId || undefined,
        listing_id: selectedListingId || undefined,
        language_style: "baku_colloquial",
      });

      if (scribeRes.ok && scribeRes.data) {
        setScribeResult(scribeRes.data);
      } else if (!scribeRes.ok) {
        setShieldError((prev) => prev || scribeRes.error || "Scribe cavabı alınarkən xəta baş verdi.");
      }
    } catch (err) {
      console.error("Shield audit error:", err);
      setShieldError(err instanceof Error ? err.message : "Şəbəkə xətası baş verdi.");
    } finally {
      setShieldLoading(false);
    }
  };

  // Tab 2: Audio Recording logic with 45s cap
  const stopRecording = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const startRecording = async () => {
    audioChunksRef.current = [];
    setRecordSeconds(0);
    setSaveSuccess(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const negotiated = getSupportedMimeType();
      negotiatedMimeRef.current = negotiated;

      const options = negotiated.codecString ? { mimeType: negotiated.codecString } : undefined;
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop audio tracks
        stream.getTracks().forEach((track) => track.stop());

        const audioBlob = new Blob(audioChunksRef.current, {
          type: negotiatedMimeRef.current.canonical,
        });

        if (audioBlob.size === 0) return;

        // Convert to Base64
        setDebriefLoading(true);
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Data = (reader.result as string)?.split(",")[1];
          if (!base64Data) {
            setDebriefLoading(false);
            return;
          }

          try {
            const debriefRes = await invokeCopilot<VoiceDebriefResult>({
              action: "voice_debrief",
              audio_base64: base64Data,
              mime_type: negotiatedMimeRef.current.canonical,
              listing_id: selectedListingId || undefined,
              lead_id: selectedLeadId || undefined,
            });

            if (debriefRes.ok && debriefRes.data) {
              const d = debriefRes.data;
              setDebriefResult(d);
              setEditTranscript(d.transcript_az || "");
              setEditStage(d.extracted_stage || "VIEWED");
              setEditOfferAzn(d.extracted_offer_azn ? String(d.extracted_offer_azn) : "");
              setEditObjections(
                Array.isArray(d.extracted_objections) ? d.extracted_objections.join(", ") : ""
              );
              setEditNextAction(d.next_action || "");
            }
          } catch (e) {
            console.error("Voice debrief error:", e);
          } finally {
            setDebriefLoading(false);
          }
        };
      };

      mediaRecorder.start(250); // collect chunks every 250ms
      setIsRecording(true);

      // Start 45s timer
      let elapsed = 0;
      timerIntervalRef.current = setInterval(() => {
        elapsed += 1;
        setRecordSeconds(elapsed);
        if (elapsed >= 45) {
          stopRecording();
        }
      }, 1000);
    } catch (err) {
      console.warn("Microphone access denied or error:", err);
      alert("Mikrofona icazə verilmədi və ya brauzer dəstəkləmir. Klaviaturanın diktə düyməsindən istifadə edə bilərsiniz.");
    }
  };

  // Text-based debrief extraction if notes were typed/dictated
  const handleAnalyzeTextDebrief = async () => {
    if (!debriefNotes.trim()) return;
    setDebriefLoading(true);
    setSaveSuccess(false);

    try {
      // Simulate/trigger extraction from typed notes
      const prompt = `Görüş qeydi: "${debriefNotes}". Zəhmət olmasa mərhələni, qiymət təklifini və növbəti addımı təyin et.`;
      const res = await invokeCopilot<VoiceDebriefResult>({
        action: "scribe_response",
        prompt,
        lead_id: selectedLeadId || undefined,
        listing_id: selectedListingId || undefined,
      });

      // Populate draft review with heuristic extraction
      const stageMatch = debriefNotes.toLowerCase().includes("bəyəndi")
        ? "OFFER"
        : debriefNotes.toLowerCase().includes("bahadır")
          ? "NEGOTIATING"
          : "VIEWED";

      const offerMatch = debriefNotes.match(/(\d{2,6})\s*(?:min|000)?\s*azn/i);
      const extractedOffer = offerMatch ? parseInt(offerMatch[1], 10) : null;

      const fallbackDebrief: VoiceDebriefResult = {
        transcript_az: debriefNotes,
        extracted_stage: stageMatch,
        extracted_offer_azn: extractedOffer,
        extracted_objections: [debriefNotes],
        next_action:
          res.ok && res.data && typeof res.data === "object" && "draft_text" in res.data && typeof (res.data as Record<string, unknown>).draft_text === "string"
            ? ((res.data as Record<string, unknown>).draft_text as string)
            : "Müştəri ilə əlaqə saxla",
      };

      setDebriefResult(fallbackDebrief);
      setEditTranscript(debriefNotes);
      setEditStage(stageMatch);
      setEditOfferAzn(extractedOffer ? String(extractedOffer) : "");
      setEditObjections(debriefNotes);
      setEditNextAction(fallbackDebrief.next_action);
    } catch (err) {
      console.error("Text debrief analysis error:", err);
    } finally {
      setDebriefLoading(false);
    }
  };

  // Save debriefed updates to Supabase
  const handleConfirmSaveDebrief = async () => {
    setSavingLead(true);
    try {
      const supabase = createClient();

      // 1. Append to lead_timeline_events
      const { error: timelineErr } = await supabase.from("lead_timeline_events").insert({
        lead_id: selectedLeadId || null,
        listing_id: selectedListingId || null,
        actor: "AI_JANITOR",
        event_type: editStage === "OFFER" ? "OFFER" : "CALL_LOG",
        summary: editNextAction || "Baxış qeydi və analitika",
        metadata: {
          transcript_az: editTranscript,
          stage: editStage,
          offer_azn: editOfferAzn ? Number(editOfferAzn) : null,
          objections: editObjections.split(",").map((s) => s.trim()).filter(Boolean),
          next_action: editNextAction,
        },
      });
      if (timelineErr) throw timelineErr;

      // 2. Update buyer_leads if leadId is present
      if (selectedLeadId) {
        const updatePayload: Record<string, unknown> = {
          stage: editStage,
        };
        if (editOfferAzn && !Number.isNaN(Number(editOfferAzn))) {
          updatePayload.budget_max_azn = Number(editOfferAzn);
        }
        if (editTranscript) {
          updatePayload.notes = editTranscript;
        }

        const { error: leadErr } = await supabase
          .from("buyer_leads")
          .update(updatePayload)
          .eq("id", selectedLeadId);
        if (leadErr) throw leadErr;
      }

      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        setDebriefResult(null);
        setDebriefNotes("");
      }, 3000);
    } catch (err) {
      console.error("Failed to commit debrief:", err);
      alert("Yadda saxlama zamanı xəta baş verdi.");
    } finally {
      setSavingLead(false);
    }
  };

  if (!isOpen) return null;

  const waTargetUrl = phoneForWa
    ? buildWhatsAppUrl(phoneForWa, scribeResult?.draft_text || "")
    : null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-200">
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-0 md:pl-10">
        <div className="w-screen max-w-xl flex flex-col bg-obsidian-900 border-l border-slate-800/90 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4 bg-obsidian-950/70">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 text-obsidian-950 shadow-md">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <span>⚡ AI Qərargahı — Copilot</span>
                  <span className="rounded-full bg-gold-500/20 border border-gold-500/40 px-2 py-0.5 text-[10px] font-semibold text-gold-300">
                    24/7 Canlı
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400">
                  Sentinel Qalxanı & Görüş Debrief Mərkəzi
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selectedLeadId && (
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-mono rounded-lg border border-slate-800 bg-obsidian-850 px-2 py-1 text-slate-300">
                  <User className="h-3 w-3 text-gold-400" />
                  <span>#{selectedLeadId.slice(0, 6)}</span>
                </span>
              )}
              {selectedListingId && (
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-mono rounded-lg border border-slate-800 bg-obsidian-850 px-2 py-1 text-slate-300">
                  <Building2 className="h-3 w-3 text-emerald-400" />
                  <span>#{selectedListingId}</span>
                </span>
              )}
              <button
                type="button"
                onClick={closeCopilot}
                className="rounded-lg p-1.5 text-slate-400 hover:text-slate-100 hover:bg-obsidian-800 transition"
                aria-label="Bağla"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex border-b border-slate-800/80 bg-obsidian-950/40 p-1.5 gap-1.5">
            <button
              type="button"
              onClick={() => setActiveTab("shield")}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2 px-3 text-xs font-semibold transition ${
                activeTab === "shield"
                  ? "bg-gold-500/15 text-gold-300 border border-gold-500/30 shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850"
              }`}
            >
              <Shield className="h-4 w-4" />
              <span>İsmarış və Danışıq Qalxanı</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("debrief")}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2 px-3 text-xs font-semibold transition ${
                activeTab === "debrief"
                  ? "bg-gold-500/15 text-gold-300 border border-gold-500/30 shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850"
              }`}
            >
              <Mic className="h-4 w-4" />
              <span>Görüş Qeydi (Debrief)</span>
            </button>
          </div>

          {/* Tab Content Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {activeTab === "shield" && (
              <div className="space-y-4">
                {/* Input Textarea */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <FileEdit className="h-3.5 w-3.5 text-gold-400" />
                      <span>Müştəri İsmarışı və ya Danışıq Qeydi:</span>
                    </label>
                    <span className="text-[11px] text-slate-400">
                      0ms Real-Time Sentinel
                    </span>
                  </div>

                  <textarea
                    rows={4}
                    value={shieldInput}
                    onChange={(e) => setShieldInput(e.target.value)}
                    placeholder="Müştərinin yazdığı mesajı bura yapışdırın... (Məs: Salam, Təbriz küçəsindəki evin bina və mənzil nömrəsini deyin, komissiyanı 50 manat edin)"
                    className="exec-input resize-none text-xs leading-relaxed"
                  />
                </div>

                {/* Instant Address Leak Detection Banner */}
                {addressScan.hasLeak && (
                  <div className="rounded-xl border border-rose-500/50 bg-rose-950/40 p-3.5 space-y-2.5 animate-in slide-in-from-top-1">
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-xs font-bold text-rose-200">
                          SENTINEL DƏQİQ ÜNVAN SIZMASI XƏBƏRDARLIĞI!
                        </p>
                        <p className="text-[11px] text-rose-300 leading-relaxed">
                          Dəqiq ünvan detalları aşkarlandı:{" "}
                          <span className="font-mono font-bold bg-rose-900/60 px-1 py-0.5 rounded">
                            {addressScan.leakedTokens.join(", ")}
                          </span>
                          . Müştəri vasitəçini kənarda qoyub birbaşa ünvana gedə bilər!
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1 border-t border-rose-500/20">
                      <span className="text-[10px] text-rose-300/80">
                        Bina/mənzil nömrəsi gizlədilməlidir.
                      </span>
                      <button
                        type="button"
                        onClick={handleApplySanitization}
                        className="rounded-lg bg-rose-600 hover:bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white shadow transition"
                      >
                        [ 🛡️ Ünvanı Maskala ]
                      </button>
                    </div>
                  </div>
                )}

                {/* Instant Commission Shaving Detection Banner */}
                {commissionScan.hasShaving && (
                  <div className="rounded-xl border border-amber-500/50 bg-amber-950/40 p-3.5 flex items-start gap-2.5 animate-in slide-in-from-top-1">
                    <Zap className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-amber-200">
                        50–100 AZN Komissiya Endirimi Təzyiqi!
                      </p>
                      <p className="text-[11px] text-amber-300/90 leading-relaxed">
                        Müştəri xidmət haqqından imtina və ya kəskin endirim tələb edir:{" "}
                        <span className="font-mono bg-amber-900/50 px-1 py-0.5 rounded">
                          {commissionScan.detectedTokens.join(", ")}
                        </span>
                        . Standart Sentinel reyestr və hüquqi təhlükəsizlik arqumenti tövsiyə olunur.
                      </p>
                    </div>
                  </div>
                )}

                {/* Audit Action Button */}
                <button
                  type="button"
                  disabled={shieldLoading || !shieldInput.trim()}
                  onClick={handleRunShieldAudit}
                  className="exec-btn-primary w-full py-2.5 text-xs font-bold"
                >
                  {shieldLoading ? (
                    <span className="flex items-center gap-2 animate-pulse">
                      <Sparkles className="h-4 w-4 animate-spin" />
                      <span>Sentinel & Scribe Təhlil Edir...</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      <span>Sentinel Təhlükəsizlik və Komissiya Müdafiəsini Yoxla</span>
                    </span>
                  )}
                </button>

                {shieldError && (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-300">
                    {shieldError}
                  </div>
                )}

                {/* Sentinel AI Rebuttal Card */}
                {sentinelResult && (
                  <div className="space-y-3 pt-2">
                    {sentinelResult.commission_defense_rebuttal && (
                      <div className="rounded-xl border border-amber-500/40 bg-obsidian-950/90 p-4 space-y-2.5 shadow-md">
                        <div className="flex items-center justify-between text-xs font-bold text-amber-400">
                          <span className="flex items-center gap-1.5">
                            <Shield className="h-4 w-4 text-amber-400" />
                            <span>Komissiya Müdafiə Arqumenti (Baku Dialekt):</span>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              handleCopy(
                                sentinelResult.commission_defense_rebuttal!,
                                "sentinel_rebuttal"
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300 hover:bg-amber-500/20 transition"
                          >
                            {copiedField === "sentinel_rebuttal" ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-400" />
                                <span>Kopyalandı!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                <span>Kopyala</span>
                              </>
                            )}
                          </button>
                        </div>
                        <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap font-sans">
                          {sentinelResult.commission_defense_rebuttal}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Scribe WhatsApp Battlecard */}
                {scribeResult && (
                  <div className="rounded-xl border border-gold-500/40 bg-obsidian-950/95 p-4 space-y-3 shadow-lg animate-in slide-in-from-bottom-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                          <MessageCircle className="h-3.5 w-3.5" />
                        </span>
                        <h4 className="text-xs font-bold text-gold-300">
                          {scribeResult.headline || "Scribe WhatsApp Qaralaması"}
                        </h4>
                      </div>
                      <span className="font-mono text-[10px] text-slate-400 bg-obsidian-850 px-2 py-0.5 rounded border border-slate-800">
                        {scribeResult.listing_code}
                      </span>
                    </div>

                    <div className="rounded-xl border border-slate-800/80 bg-obsidian-900/90 p-3 space-y-2">
                      <p className="text-xs text-slate-100 font-sans whitespace-pre-wrap leading-relaxed">
                        {scribeResult.draft_text}
                      </p>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => handleCopy(scribeResult.draft_text, "scribe_draft")}
                        className="exec-btn-secondary py-1.5 px-3 text-xs"
                      >
                        {copiedField === "scribe_draft" ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                            <span>Kopyalandı!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>Mesajı Kopyala</span>
                          </>
                        )}
                      </button>

                      {waTargetUrl && (
                        <a
                          href={waTargetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 px-3.5 py-1.5 text-xs font-bold text-white shadow-md transition"
                        >
                          <MessageCircle className="h-3.5 w-3.5" />
                          <span>WhatsApp ilə Aç</span>
                          <ExternalLink className="h-3 w-3 opacity-80" />
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === "debrief" && (
              <div className="space-y-4">
                {/* Voice / Text Options Description */}
                <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/60 p-3.5 space-y-1">
                  <p className="text-xs font-semibold text-slate-200">
                    Baxışdan sonra sürətli səsli və ya mətn debriefi:
                  </p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Səs düyməsini sıxıb 45 saniyə ərzində danışın və ya mobil klaviaturanızın səsli diktəsindən istifadə edin.
                  </p>
                </div>

                {/* Push-to-Talk Audio Box */}
                <div className="rounded-2xl border border-gold-500/30 bg-gradient-to-b from-obsidian-950 to-obsidian-900 p-5 text-center space-y-4 shadow-lg">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={debriefLoading}
                      className={`relative flex h-20 w-20 items-center justify-center rounded-full transition shadow-xl ${
                        isRecording
                          ? "bg-rose-600 text-white animate-pulse ring-8 ring-rose-500/20"
                          : "bg-gradient-to-br from-gold-400 to-gold-600 text-obsidian-950 hover:scale-105 active:scale-95"
                      }`}
                      aria-label={isRecording ? "Səsi Dayandır" : "Səs Yazmağa Başla"}
                    >
                      {isRecording ? (
                        <MicOff className="h-8 w-8 animate-bounce" />
                      ) : (
                        <Mic className="h-8 w-8" />
                      )}
                    </button>

                    <div className="space-y-1">
                      <p className="text-xs font-bold text-slate-100">
                        {isRecording ? "🔴 Səs Yazılır (Danışın)..." : "Mikrofonu Sıxın və Danışın"}
                      </p>
                      <p className="font-mono text-xs text-gold-400">
                        {isRecording
                          ? `00:${recordSeconds < 10 ? "0" : ""}${recordSeconds} / 00:45`
                          : "Maksimum 45 saniyə"}
                      </p>
                    </div>
                  </div>

                  {isRecording && (
                    <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-rose-500 h-1.5 transition-all duration-300"
                        style={{ width: `${(recordSeconds / 45) * 100}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Alternative: Mobile Keyboard Voice Dictation Textarea */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <FileEdit className="h-3.5 w-3.5 text-gold-400" />
                      <span>Və ya Mətni Yazın / Mobil Diktə Edin:</span>
                    </label>
                  </div>
                  <textarea
                    rows={3}
                    value={debriefNotes}
                    onChange={(e) => setDebriefNotes(e.target.value)}
                    placeholder="Məs: Müştəri mənzili bəyəndi amma mətbəx mebelini istəyir, 175 minə düşsələr sabah beh verəcək..."
                    className="exec-input resize-none text-xs leading-relaxed"
                  />
                  {debriefNotes.trim().length > 0 && (
                    <button
                      type="button"
                      disabled={debriefLoading}
                      onClick={handleAnalyzeTextDebrief}
                      className="exec-btn-secondary w-full py-2 text-xs font-medium"
                    >
                      <span>📝 Mətn Qeydini Analiz Et və Çıxarış Al</span>
                    </button>
                  )}
                </div>

                {debriefLoading && (
                  <div className="flex items-center justify-center gap-2 py-4 text-xs text-gold-400 animate-pulse">
                    <Sparkles className="h-4 w-4 animate-spin" />
                    <span>Janitor Səsi Dinləyir və Struktur Çıxarış Hazırlayır...</span>
                  </div>
                )}

                {/* Editable Extracted Preview Before Commit */}
                {debriefResult && (
                  <div className="rounded-xl border border-gold-500/40 bg-obsidian-950 p-4 space-y-3.5 shadow-xl animate-in slide-in-from-bottom-2">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <span className="text-xs font-bold text-gold-300 flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        <span>Çıxarılan Nəticə (Təsdiqdən Əvvəl Redaktə Edin):</span>
                      </span>
                    </div>

                    {/* Verbatim Transcript */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-300">
                        Azərbaycan Dilində Transkripsiya:
                      </label>
                      <textarea
                        rows={2}
                        value={editTranscript}
                        onChange={(e) => setEditTranscript(e.target.value)}
                        className="exec-input text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* Deal Stage */}
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-slate-300">
                          Mərhələ (Stage):
                        </label>
                        <select
                          value={editStage}
                          onChange={(e) => setEditStage(e.target.value)}
                          className="exec-select w-full text-xs py-2"
                        >
                          {STAGE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Offer AZN */}
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-slate-300">
                          Təklif Edilən Qiymət (AZN):
                        </label>
                        <input
                          type="number"
                          value={editOfferAzn}
                          onChange={(e) => setEditOfferAzn(e.target.value)}
                          placeholder="Məs: 175000"
                          className="exec-input text-xs py-2"
                        />
                      </div>
                    </div>

                    {/* Objections */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-300">
                        Qeydə Alınan İtirazlar / Şərtlər:
                      </label>
                      <input
                        type="text"
                        value={editObjections}
                        onChange={(e) => setEditObjections(e.target.value)}
                        placeholder="Məs: mətbəx mebeli, təmir xərci"
                        className="exec-input text-xs py-2"
                      />
                    </div>

                    {/* Next Action */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-300">
                        Növbəti Əməliyyat Addımı:
                      </label>
                      <input
                        type="text"
                        value={editNextAction}
                        onChange={(e) => setEditNextAction(e.target.value)}
                        placeholder="Məs: Mülkiyyətçi ilə 175 min AZN təklifini dəqiqləşdir"
                        className="exec-input text-xs py-2"
                      />
                    </div>

                    {/* Commit Save Button */}
                    <button
                      type="button"
                      disabled={savingLead}
                      onClick={handleConfirmSaveDebrief}
                      className="exec-btn-primary w-full py-2.5 text-xs font-bold"
                    >
                      {savingLead ? (
                        <span className="flex items-center gap-2 animate-pulse">
                          <Save className="h-4 w-4 animate-spin" />
                          <span>CRM Bazasına Yazılır...</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Save className="h-4 w-4" />
                          <span>[ Təsdiqlə və Yadda Saxla ]</span>
                        </span>
                      )}
                    </button>
                  </div>
                )}

                {saveSuccess && (
                  <div className="rounded-xl border border-emerald-500/50 bg-emerald-950/60 p-3.5 flex items-center gap-2 text-xs text-emerald-200 animate-in fade-in">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span>Görüş qeydi və CRM yeniləməsi uğurla yadda saxlanıldı!</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
