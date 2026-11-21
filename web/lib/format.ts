import type {
  Archetype,
  DuplicateResolution,
  DurationBucket,
  EditorialStatus,
  FollowUpEntityType,
  HookType,
  JobStatus,
  JobTriggerSource,
  JobType,
  LeadListingRelation,
  LeadSourceChannel,
  LeadStage,
  ListingEventType,
  OwnerOutreachStatus,
  PipelineStatus,
  PreflightStatus,
  PublicationChannel,
  PublicationStatus,
  RenderStatus,
  RenderTriggerReason,
  SourceAvailability,
  TaskPriority,
  TelemetryStatus,
} from "./types";

const BAKU_TZ = "Asia/Baku";

export function formatAzn(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const formatted = new Intl.NumberFormat("az-AZ", {
    maximumFractionDigits: 0,
  }).format(Math.round(Number(value)));
  return `${formatted} ₼`;
}

export function formatPrice(
  price: number | null | undefined,
  currency: string = "AZN"
): string {
  if (price === null || price === undefined || Number.isNaN(Number(price))) {
    return "—";
  }
  const formatted = new Intl.NumberFormat("az-AZ", {
    maximumFractionDigits: 0,
  }).format(Math.round(Number(price)));
  const symbol = currency === "AZN" ? "₼" : currency === "USD" ? "$" : "€";
  return `${formatted} ${symbol}`;
}

export function formatBakuDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("az-AZ", {
    timeZone: BAKU_TZ,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatBakuDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("az-AZ", {
    timeZone: BAKU_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatRelativeAz(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) {
    return diffSec >= 0 ? "İndi" : "Az əvvəl";
  }
  if (abs < 3600) {
    const mins = Math.round(abs / 60);
    return diffSec >= 0 ? `${mins} dəq sonra` : `${mins} dəq əvvəl`;
  }
  if (abs < 86400) {
    const hrs = Math.round(abs / 3600);
    return diffSec >= 0 ? `${hrs} saat sonra` : `${hrs} saat əvvəl`;
  }
  const days = Math.round(abs / 86400);
  return diffSec >= 0 ? `${days} gün sonra` : `${days} gün əvvəl`;
}

export function isOverdue(iso: string): boolean {
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

export function getTomorrowMorningBakuIso(): string {
  // Compute tomorrow 10:00 in Asia/Baku (UTC+4 = +04:00, no DST)
  const bakuOffsetMs = 4 * 60 * 60 * 1000;
  const nowBaku = new Date(Date.now() + bakuOffsetMs);
  const tomorrowBakuUtc = Date.UTC(
    nowBaku.getUTCFullYear(),
    nowBaku.getUTCMonth(),
    nowBaku.getUTCDate() + 1,
    10,
    0,
    0
  );
  return new Date(tomorrowBakuUtc - bakuOffsetMs).toISOString();
}

export function getPlusHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function buildWhatsAppUrl(
  rawPhone: string | null | undefined,
  message?: string
): string | null {
  if (!rawPhone) return null;
  let digits = rawPhone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0") && digits.length === 10) {
    digits = `994${digits.slice(1)}`;
  } else if (digits.length === 9 && /^(50|51|55|70|77|99|10)/.test(digits)) {
    digits = `994${digits}`;
  }
  const base = `https://wa.me/${digits}`;
  if (message) {
    return `${base}?text=${encodeURIComponent(message)}`;
  }
  return base;
}

export function normalizePhoneInput(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("994") && digits.length === 12) {
    return `+${digits}`;
  }
  if (digits.startsWith("0") && digits.length === 10) {
    return `+994${digits.slice(1)}`;
  }
  if (digits.length === 9) {
    return `+994${digits}`;
  }
  return `+${digits}`;
}

export type BadgeTone =
  | "neutral"
  | "gold"
  | "emerald"
  | "sky"
  | "amber"
  | "rose"
  | "violet";

export const EDITORIAL_STATUS_META: Record<
  EditorialStatus,
  { label: string; tone: BadgeTone }
> = {
  PENDING_REVIEW: { label: "Baxış gözləyir", tone: "amber" },
  APPROVED: { label: "Təsdiqlənib", tone: "sky" },
  PUBLISHED: { label: "Paylaşılıb", tone: "emerald" },
  NEEDS_RERENDER: { label: "Yenidən Render", tone: "violet" },
  REJECTED: { label: "Rədd edilib", tone: "rose" },
  ARCHIVED: { label: "Arxiv", tone: "neutral" },
};

export const SOURCE_AVAILABILITY_META: Record<
  SourceAvailability,
  { label: string; tone: BadgeTone }
> = {
  ACTIVE: { label: "Aktiv (bina.az)", tone: "emerald" },
  REMOVED_ON_BINA: { label: "bina.az-da silinib", tone: "rose" },
  CONFIRMED_SOLD: { label: "Satılıb", tone: "rose" },
};

export const PIPELINE_STATUS_META: Record<
  PipelineStatus,
  { label: string; tone: BadgeTone }
> = {
  NEW: { label: "Yeni", tone: "sky" },
  QUEUED: { label: "Növbədə", tone: "amber" },
  RENDERING: { label: "Render gedir", tone: "violet" },
  DISPATCHED: { label: "Göndərilib", tone: "emerald" },
  FAILED: { label: "Xəta", tone: "rose" },
  SKIPPED_DUPLICATE: { label: "Şübhəli Təkrar", tone: "amber" },
};

export const OWNER_OUTREACH_META: Record<
  OwnerOutreachStatus,
  { label: string; tone: BadgeTone }
> = {
  NOT_CONTACTED: { label: "Əlaqə qurulmayıb", tone: "neutral" },
  CONTACTED: { label: "Yazılıb / Zəng edilib", tone: "sky" },
  AVAILABILITY_CONFIRMED: { label: "Aktualdır", tone: "emerald" },
  COMMISSION_AGREED: { label: "Komissiya razılaşdırılıb", tone: "gold" },
  UNRESPONSIVE: { label: "Cavab vermir", tone: "amber" },
  REFUSED_AGENT: { label: "Vasitəçidən imtina", tone: "rose" },
  OWNER_SOLD: { label: "Mülkiyyətçi satıb", tone: "rose" },
};

export const DUPLICATE_RESOLUTION_META: Record<
  DuplicateResolution,
  { label: string; tone: BadgeTone }
> = {
  NONE: { label: "Təkrarsız", tone: "neutral" },
  PENDING_REVIEW: { label: "Təkrar Təsdiqi", tone: "amber" },
  CONFIRMED_DUPLICATE: { label: "Təsdiqlənmiş Təkrar", tone: "rose" },
  FALSE_POSITIVE: { label: "Ayrı Mənzil", tone: "emerald" },
};

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  budget: "Büdcə",
  luxury: "Lüks",
  villa: "Villa / Həyət evi",
  commercial: "Obyekt",
};

export const LEAD_STAGE_META: Record<
  LeadStage,
  { label: string; tone: BadgeTone }
> = {
  NEW_INQUIRY: { label: "Yeni Sorğu", tone: "sky" },
  QUALIFIED: { label: "Kvalifikasiya", tone: "violet" },
  VIEWING_SCHEDULED: { label: "Baxış Təyin Edilib", tone: "amber" },
  VIEWED: { label: "Baxış Keçirilib", tone: "gold" },
  NEGOTIATING: { label: "Danışıqlar", tone: "gold" },
  DEPOSIT: { label: "Beh / Depozit", tone: "emerald" },
  WON_CLOSED: { label: "Bağlandı (Qazanc)", tone: "emerald" },
  LOST: { label: "İtirildi", tone: "rose" },
  COLD: { label: "Soyuq", tone: "neutral" },
};

export const LEAD_SOURCE_LABELS: Record<LeadSourceChannel, string> = {
  IG_DM: "Instagram DM",
  WHATSAPP: "WhatsApp",
  TIKTOK_DM: "TikTok DM",
  CALL: "Telefon Zəngi",
  TELEGRAM: "Telegram",
  REFERRAL: "Tövsiyə",
};

export const LEAD_RELATION_LABELS: Record<LeadListingRelation, string> = {
  INQUIRED: "Maraqlanıb",
  PITCHED: "Təklif edilib",
  VIEWED: "Baxış keçirib",
  REJECTED: "Bəyənməyib",
  OFFERED: "Təklif verib",
};

export const JOB_STATUS_META: Record<
  JobStatus,
  { label: string; tone: BadgeTone }
> = {
  QUEUED: { label: "Növbədə", tone: "amber" },
  RUNNING: { label: "İcrada", tone: "violet" },
  SUCCEEDED: { label: "Uğurlu", tone: "emerald" },
  FAILED: { label: "Xətalı", tone: "rose" },
  EXPIRED: { label: "Müddəti bitib", tone: "neutral" },
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  SCRAPE_NEW: "Yeni Elan Yığımı",
  RENDER_INITIAL: "İlkin Video Render",
  RENDER_PRICE_DROP: "Qiymət Endirimi Renderi",
  RERENDER: "Yenidən Render",
  LIVENESS_CHECK: "Aktivlik Yoxlaması",
  SYNC_SOCIAL_METRICS: "Sosial Telemetriya Yoxlaması",
};

export const JOB_TRIGGER_LABELS: Record<JobTriggerSource, string> = {
  AUTO_SCHEDULER: "Avtomatik",
  WEB_UI: "Veb CRM",
  TELEGRAM_WEBHOOK: "Telegram",
};

export const RENDER_STATUS_META: Record<
  RenderStatus,
  { label: string; tone: BadgeTone }
> = {
  QUEUED: { label: "Növbədə", tone: "amber" },
  RUNNING: { label: "Renderdə", tone: "violet" },
  COMPLETED: { label: "Hazır", tone: "emerald" },
  FAILED: { label: "Xəta", tone: "rose" },
  SUPERSEDED: { label: "Əvəzlənib", tone: "neutral" },
};

export const RENDER_TRIGGER_LABELS: Record<RenderTriggerReason, string> = {
  AUTO_INITIAL: "Avto İlkin",
  AUTO_PRICE_DROP: "Qiymət Endirimi",
  MANUAL_RERENDER: "Əl ilə Render",
  SCRIPT_ANGLE: "Ssenari Dəyişikliyi",
  VOICE_SWITCH: "Səs Dəyişikliyi",
};

export const PUBLICATION_CHANNEL_LABELS: Record<PublicationChannel, string> = {
  INSTAGRAM_REELS: "Instagram Reels",
  TIKTOK: "TikTok",
  YOUTUBE_SHORTS: "YouTube Shorts",
  TELEGRAM: "Telegram",
  WHATSAPP_STATUS: "WhatsApp Status",
};

export const EVENT_TYPE_META: Record<
  ListingEventType,
  { label: string; tone: BadgeTone }
> = {
  SCRAPED_NEW: { label: "Yeni Elan Yığıldı", tone: "sky" },
  PRICE_CHANGED: { label: "Qiymət Dəyişdi", tone: "gold" },
  KUPCA_CHANGED: { label: "Kupça Statusu Dəyişdi", tone: "emerald" },
  PHOTOS_CHANGED: { label: "Fotolar Yeniləndi", tone: "violet" },
  REMOVED_ON_BINA: { label: "bina.az-dan Silindi", tone: "rose" },
  DUPLICATE_FLAGGED: { label: "Şübhəli Təkrar", tone: "amber" },
  STATUS_CHANGED: { label: "Status Yeniləndi", tone: "neutral" },
  OWNER_UPDATED: { label: "Mülkiyyətçi Qeydi", tone: "sky" },
};

export const TASK_PRIORITY_META: Record<
  TaskPriority,
  { label: string; tone: BadgeTone }
> = {
  HIGH: { label: "Vacib", tone: "rose" },
  NORMAL: { label: "Normal", tone: "gold" },
  LOW: { label: "Aşağı", tone: "neutral" },
};

export const TASK_ENTITY_LABELS: Record<FollowUpEntityType, string> = {
  BUYER_LEAD: "Müştəri",
  OWNER_OUTREACH: "Mülkiyyətçi",
  DUPLICATE_REVIEW: "Təkrar Yoxlaması",
};

export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "0";
  }
  const n = Number(value);
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return n.toLocaleString("az-AZ");
}

export const PUBLICATION_STATUS_META: Record<
  PublicationStatus,
  { label: string; tone: BadgeTone }
> = {
  DRAFT: { label: "Qaralama", tone: "neutral" },
  DRAFT_READY: { label: "Yayıma Hazır", tone: "amber" },
  READY_TO_PUBLISH: { label: "Təsdiqlənib / Hazır", tone: "sky" },
  PUBLISHED: { label: "Canlı Yayımda", tone: "emerald" },
  ARCHIVED: { label: "Arxiv", tone: "neutral" },
  REMOVED: { label: "Silinib", tone: "rose" },
};

export const PREFLIGHT_STATUS_META: Record<
  PreflightStatus,
  { label: string; tone: BadgeTone }
> = {
  UNCHECKED: { label: "Yoxlanılmayıb", tone: "neutral" },
  PENDING: { label: "Gözləyir", tone: "neutral" },
  CHECKING: { label: "Yoxlanılır...", tone: "sky" },
  PASSED: { label: "✅ Yoxlanılıb", tone: "emerald" },
  PRICE_CHANGED: { label: "⚠️ Qiymət Dəyişib", tone: "amber" },
  PRICE_MISMATCH: { label: "⚠️ Qiymət Fərqi", tone: "amber" },
  REMOVED_ON_BINA: { label: "❌ bina.az-dan Silinib", tone: "rose" },
  FAILED: { label: "Xəta", tone: "rose" },
  ERROR: { label: "Xəta", tone: "rose" },
};

export const TELEMETRY_STATUS_META: Record<
  TelemetryStatus,
  { label: string; tone: BadgeTone }
> = {
  PENDING: { label: "Gözləyir", tone: "neutral" },
  ACTIVE: { label: "Monitorinq Aktiv", tone: "emerald" },
  FROZEN: { label: "Dondurulub (7 gün+)", tone: "sky" },
  ERROR: { label: "Xəta", tone: "rose" },
};

export const HOOK_TYPE_LABELS: Record<HookType, string> = {
  PRICE_FIRST: "Qiymət İlkin (Price-First)",
  LOCATION_FIRST: "Məkan İlkin (Location-First)",
  LUXURY_LIFESTYLE: "Lüks Həyat Tərzi (Luxury)",
};

export const DURATION_BUCKET_LABELS: Record<DurationBucket, string> = {
  SHORT_25_30: "25–30 san (Qısa)",
  LONG_40_50: "40–50 san (Uzun)",
};

export const INTENT_CATEGORY_META: Record<
  string,
  { label: string; tone: BadgeTone }
> = {
  PRICE: { label: "Qiymət Marağı", tone: "gold" },
  LOCATION: { label: "Ünvan / Məkan", tone: "sky" },
  MORTGAGE: { label: "İpoteka / Kupça", tone: "emerald" },
  PHONE_REQ: { label: "Əlaqə / WhatsApp", tone: "violet" },
  NOISE: { label: "Ümumi", tone: "neutral" },
};
