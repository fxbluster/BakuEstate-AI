// =============================================================================
// BakuEstate-AI: 24/7 Follow-Up Reminder Dispatcher (Supabase Edge Function)
// File: supabase/functions/followup-dispatcher/index.ts
//
// Scheduled every 5 minutes via pg_cron:
//   - Respects Asia/Baku (UTC+4) quiet hours: 21:30 - 09:00 (no notifications)
//   - Sends immediate Telegram ping with [Done / +3h / Tomorrow] inline buttons
//     for due HIGH-priority follow_up_tasks
//   - Sends 1 batched morning digest once >= 09:30 Asia/Baku (gated by quiet hours
//     and reminder_sent_at) for overdue & today's NORMAL/LOW tasks, chunked <= 3800 chars
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const BAKU_OFFSET_MS = 4 * 60 * 60 * 1000; // Asia/Baku is fixed UTC+4 (no DST)
const TELEGRAM_MAX_CHUNK_CHARS = 3800;

interface TaskRecord {
  id: string;
  agency_id: string;
  entity_type: "BUYER_LEAD" | "OWNER_OUTREACH" | "DUPLICATE_REVIEW";
  lead_id: string | null;
  listing_id: string | null;
  title: string;
  due_at: string;
  priority: "LOW" | "NORMAL" | "HIGH";
  status: "OPEN" | "SNOOZED" | "DONE" | "CANCELLED";
  reminder_sent_at: string | null;
  buyer_leads?: {
    client_name: string | null;
    phone_normalized: string | null;
    stage: string | null;
  } | null;
  listings?: {
    bina_id: string | null;
    location: string | null;
    price_azn_normalized: number | null;
    owner_outreach_status: string | null;
    source_availability: string | null;
  } | null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseHmToMinutes(hm: string, fallbackMinutes: number): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hm.trim());
  if (!m) return fallbackMinutes;
  return Number(m[1]) * 60 + Number(m[2]);
}

function getBakuClock(nowUtc: Date = new Date()): {
  hour: number;
  minute: number;
  minutesOfDay: number;
  formattedTime: string;
  dayStartIso: string;
  dayEndIso: string;
} {
  const bakuDate = new Date(nowUtc.getTime() + BAKU_OFFSET_MS);
  const y = bakuDate.getUTCFullYear();
  const mo = bakuDate.getUTCMonth();
  const d = bakuDate.getUTCDate();
  const hour = bakuDate.getUTCHours();
  const minute = bakuDate.getUTCMinutes();

  const dayStartUtc = Date.UTC(y, mo, d, 0, 0, 0) - BAKU_OFFSET_MS;
  const dayEndUtc = Date.UTC(y, mo, d, 23, 59, 59, 999) - BAKU_OFFSET_MS;

  return {
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    formattedTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    dayStartIso: new Date(dayStartUtc).toISOString(),
    dayEndIso: new Date(dayEndUtc).toISOString(),
  };
}

function isQuietHours(minutesOfDay: number, quietStartMin: number, quietEndMin: number): boolean {
  if (quietStartMin > quietEndMin) {
    // Overnight window e.g. 21:30 (1290) -> 09:00 (540)
    return minutesOfDay >= quietStartMin || minutesOfDay < quietEndMin;
  }
  return minutesOfDay >= quietStartMin && minutesOfDay < quietEndMin;
}

function formatBakuDateTime(iso: string): string {
  const dt = new Date(new Date(iso).getTime() + BAKU_OFFSET_MS);
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mi = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}

function chunkLinesForTelegram(
  lines: string[],
  maxChars: number = TELEGRAM_MAX_CHUNK_CHARS,
): string[] {
  const limit = Math.max(100, maxChars);
  const chunks: string[] = [];
  let current = "";

  for (const rawLine of lines) {
    const line = rawLine.length > limit ? `${rawLine.slice(0, limit - 1)}…` : rawLine;
    if (!current) {
      current = line;
      continue;
    }
    if (current.length + 1 + line.length <= limit) {
      current = `${current}\n${line}`;
    } else {
      chunks.push(current);
      current = line;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }),
  });
  return resp.ok;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Mandatory fail-closed cron secret guard
  const expectedCronSecret = (Deno.env.get("CRON_SECRET") ?? "").trim();
  if (!expectedCronSecret) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: CRON_SECRET not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  if (!provided || !timingSafeEqual(expectedCronSecret, provided)) {
    return new Response(JSON.stringify({ error: "Forbidden: invalid cron secret" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const botToken = (Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").trim();
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();

  if (!botToken || !supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Missing required environment secrets" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const quietStartMin = parseHmToMinutes(Deno.env.get("BAKU_QUIET_START") ?? "21:30", 21 * 60 + 30);
  const quietEndMin = parseHmToMinutes(Deno.env.get("BAKU_QUIET_END") ?? "09:00", 9 * 60);
  const now = new Date();
  const baku = getBakuClock(now);

  if (isQuietHours(baku.minutesOfDay, quietStartMin, quietEndMin)) {
    return new Response(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason: "quiet_hours_baku",
        baku_time: baku.formattedTime,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve per-agency Telegram chat destinations to strictly prevent cross-agency PII leakage
  const agencyChatMap = new Map<string, string>();
  const { data: settingsRows, error: settingsErr } = await supabase
    .from("agency_settings")
    .select("agency_id, telegram_chat_id");
  if (settingsErr) {
    console.error("Failed to load agency_settings:", settingsErr.message);
  } else {
    for (const row of settingsRows ?? []) {
      const aId = String(row.agency_id ?? "").trim();
      const cId = String(row.telegram_chat_id ?? "").trim();
      if (aId && cId) {
        agencyChatMap.set(aId, cId);
      }
    }
  }

  const nowIso = now.toISOString();
  let highSentCount = 0;
  let digestSentCount = 0;

  // ---------------------------------------------------------------------------
  // 1. Immediate Pings for Due HIGH-Priority Tasks (scoped per agency_id)
  // ---------------------------------------------------------------------------
  const { data: highTasks, error: highErr } = await supabase
    .from("follow_up_tasks")
    .select(
      "id, agency_id, entity_type, lead_id, listing_id, title, due_at, priority, status, reminder_sent_at, buyer_leads(client_name, phone_normalized, stage), listings(bina_id, location, price_azn_normalized, owner_outreach_status, source_availability)",
    )
    .eq("priority", "HIGH")
    .in("status", ["OPEN", "SNOOZED"])
    .lte("due_at", nowIso)
    .is("reminder_sent_at", null)
    .order("due_at", { ascending: true })
    .limit(15);

  if (highErr) {
    console.error("Failed to query HIGH tasks:", highErr.message);
  } else if (highTasks && highTasks.length > 0) {
    for (const task of highTasks as unknown as TaskRecord[]) {
      const targetChatId = agencyChatMap.get(String(task.agency_id ?? "").trim());
      if (!targetChatId) {
        console.warn(`Skipping HIGH task ${task.id}: no telegram_chat_id configured for agency ${task.agency_id}`);
        continue;
      }

      const entityLabel =
        task.entity_type === "BUYER_LEAD"
          ? "👤 Müştəri Follow-Up"
          : task.entity_type === "OWNER_OUTREACH"
          ? "🏠 Mülkiyyətçi Əlaqəsi"
          : "🔎 Təkrar Elan Yoxlaması";

      const soldWarning =
        task.listings &&
        (task.listings.owner_outreach_status === "OWNER_SOLD" ||
          task.listings.source_availability === "REMOVED_ON_BINA" ||
          task.listings.source_availability === "CONFIRMED_SOLD")
          ? "⚠️ <b>DİQQƏT:</b> Bağlı elan satılıb/silinib — müştəriyə alternativ təklif edin!"
          : null;

      const lines = [
        `🔔 <b>VACİB XATIRLATMA (HIGH)</b>`,
        `📌 <b>Növ:</b> ${entityLabel}`,
        `📝 <b>Tapşırıq:</b> ${escapeHtml(task.title)}`,
        `⏰ <b>Vaxt (Bakı):</b> <code>${formatBakuDateTime(task.due_at)}</code>`,
        task.buyer_leads?.phone_normalized
          ? `📞 <b>Müştəri:</b> ${escapeHtml(task.buyer_leads.client_name ?? "")} (<code>${task.buyer_leads.phone_normalized}</code>)`
          : null,
        task.listings?.bina_id
          ? `🔗 <b>Elan:</b> #${task.listings.bina_id} — ${escapeHtml(task.listings.location ?? "Bakı")}`
          : null,
        soldWarning,
      ].filter(Boolean);

      const sent = await sendTelegramMessage(botToken, targetChatId, lines.join("\n"), {
        inline_keyboard: [
          [
            { text: "✅ Tamamlandı", callback_data: `task_done_${task.id}` },
            { text: "⏰ +3 saat", callback_data: `task_snooze_3h_${task.id}` },
            { text: "📅 Sabaha", callback_data: `task_tomorrow_${task.id}` },
          ],
        ],
      });

      if (sent) {
        await supabase
          .from("follow_up_tasks")
          .update({ reminder_sent_at: nowIso })
          .eq("id", task.id);
        highSentCount++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. 09:30+ Asia/Baku Batched Morning Digest for NORMAL / LOW Tasks
  //    Grouped strictly by agency_id so each agency only receives its own tasks.
  // ---------------------------------------------------------------------------
  const digestStartMin = 9 * 60 + 30; // 09:30 Baku
  const inDigestWindow = baku.minutesOfDay >= digestStartMin;

  if (inDigestWindow) {
    const { data: normalTasks, error: normalErr } = await supabase
      .from("follow_up_tasks")
      .select(
        "id, agency_id, entity_type, lead_id, listing_id, title, due_at, priority, status, reminder_sent_at, buyer_leads(client_name, phone_normalized, stage), listings(bina_id, location, price_azn_normalized, owner_outreach_status, source_availability)",
      )
      .in("priority", ["NORMAL", "LOW"])
      .in("status", ["OPEN", "SNOOZED"])
      .lte("due_at", baku.dayEndIso)
      .or(`reminder_sent_at.is.null,reminder_sent_at.lt.${baku.dayStartIso}`)
      .order("due_at", { ascending: true })
      .limit(100);

    if (normalErr) {
      console.error("Failed to query NORMAL/LOW digest tasks:", normalErr.message);
    } else if (normalTasks && normalTasks.length > 0) {
      const tasksByAgency = new Map<string, TaskRecord[]>();
      for (const task of normalTasks as unknown as TaskRecord[]) {
        const aId = String(task.agency_id ?? "").trim();
        if (!aId) continue;
        const list = tasksByAgency.get(aId) ?? [];
        list.push(task);
        tasksByAgency.set(aId, list);
      }

      for (const [agencyId, agencyTasks] of tasksByAgency.entries()) {
        const targetChatId = agencyChatMap.get(agencyId);
        if (!targetChatId) {
          console.warn(`Skipping digest for agency ${agencyId}: no telegram_chat_id configured`);
          continue;
        }

        const batchTasks = agencyTasks.slice(0, 30);
        const overdueCount = batchTasks.filter((t) => new Date(t.due_at).getTime() < now.getTime()).length;
        const lines = [
          `☀️ <b>Sabahınız Xeyir! Gündəlik Follow-Up Xülasəsi (${batchTasks.length})</b>`,
          overdueCount > 0 ? `⚠️ Gecikmiş: <b>${overdueCount}</b> | Bugünkü: <b>${batchTasks.length - overdueCount}</b>` : null,
          "",
        ].filter((v) => v !== null) as string[];

        const inlineRows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < batchTasks.length; i++) {
          const t = batchTasks[i];
          const tag =
            t.entity_type === "BUYER_LEAD"
              ? "👤"
              : t.entity_type === "OWNER_OUTREACH"
              ? "🏠"
              : "🔎";
          const overdueMark = new Date(t.due_at).getTime() < now.getTime() ? " [GECİKİB]" : "";
          const safeTitle = t.title.length > 300 ? `${t.title.slice(0, 297)}...` : t.title;
          lines.push(
            `${i + 1}. ${tag} <b>${escapeHtml(safeTitle)}</b> — <code>${formatBakuDateTime(t.due_at)}</code>${overdueMark}`,
          );
          if (i < 5) {
            inlineRows.push([
              { text: `✅ #${i + 1} Bitdi`, callback_data: `task_done_${t.id}` },
              { text: `⏰ +3s`, callback_data: `task_snooze_3h_${t.id}` },
              { text: `📅 Sabah`, callback_data: `task_tomorrow_${t.id}` },
            ]);
          }
        }

        const chunks = chunkLinesForTelegram(lines, TELEGRAM_MAX_CHUNK_CHARS);
        let digestOk = chunks.length > 0;
        for (let idx = 0; idx < chunks.length; idx++) {
          const isLast = idx === chunks.length - 1;
          const sent = await sendTelegramMessage(
            botToken,
            targetChatId,
            chunks[idx],
            isLast && inlineRows.length > 0 ? { inline_keyboard: inlineRows } : undefined,
          );
          if (!sent) {
            digestOk = false;
            break;
          }
        }

        if (digestOk) {
          const ids = batchTasks.map((t) => t.id);
          await supabase
            .from("follow_up_tasks")
            .update({ reminder_sent_at: nowIso })
            .in("id", ids);
          digestSentCount += ids.length;
        }
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      baku_time: baku.formattedTime,
      in_digest_window: inDigestWindow,
      high_reminders_sent: highSentCount,
      morning_digest_tasks_sent: digestSentCount,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
