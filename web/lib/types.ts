export type Currency = "AZN" | "USD" | "EUR";
export type Archetype = "budget" | "luxury" | "villa" | "commercial";
export type DuplicateResolution =
  | "NONE"
  | "PENDING_REVIEW"
  | "CONFIRMED_DUPLICATE"
  | "FALSE_POSITIVE";
export type SourceAvailability =
  | "ACTIVE"
  | "REMOVED_ON_BINA"
  | "CONFIRMED_SOLD";
export type PipelineStatus =
  | "NEW"
  | "QUEUED"
  | "RENDERING"
  | "DRAFT_READY"
  | "DISPATCHED"
  | "FAILED"
  | "SKIPPED_DUPLICATE";
export type EditorialStatus =
  | "PENDING_REVIEW"
  | "APPROVED"
  | "PUBLISHED"
  | "NEEDS_RERENDER"
  | "REJECTED"
  | "ARCHIVED";
export type OwnerOutreachStatus =
  | "NOT_CONTACTED"
  | "CONTACTED"
  | "AVAILABILITY_CONFIRMED"
  | "COMMISSION_AGREED"
  | "UNRESPONSIVE"
  | "REFUSED_AGENT"
  | "OWNER_SOLD";
export type CommissionType = "PERCENT" | "FIXED_AZN" | "NONE";

export type ListingEventType =
  | "SCRAPED_NEW"
  | "PRICE_CHANGED"
  | "KUPCA_CHANGED"
  | "PHOTOS_CHANGED"
  | "REMOVED_ON_BINA"
  | "DUPLICATE_FLAGGED"
  | "STATUS_CHANGED"
  | "OWNER_UPDATED";

export type EventActor =
  | "scraper"
  | "liveness_poller"
  | "web_user"
  | "telegram_user"
  | "local_worker"
  | "migration";

export type RenderTriggerReason =
  | "AUTO_INITIAL"
  | "AUTO_PRICE_DROP"
  | "MANUAL_RERENDER"
  | "SCRIPT_ANGLE"
  | "VOICE_SWITCH";

export type RenderStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SUPERSEDED";

export type PublicationChannel =
  | "INSTAGRAM_REELS"
  | "TIKTOK"
  | "YOUTUBE_SHORTS"
  | "TELEGRAM"
  | "WHATSAPP_STATUS";

export type PublicationStatus =
  | "DRAFT"
  | "DRAFT_READY"
  | "READY_TO_PUBLISH"
  | "PUBLISHED"
  | "ARCHIVED"
  | "REMOVED";

export type PreflightStatus =
  | "UNCHECKED"
  | "PENDING"
  | "CHECKING"
  | "PASSED"
  | "PRICE_CHANGED"
  | "PRICE_MISMATCH"
  | "REMOVED_ON_BINA"
  | "FAILED"
  | "ERROR";

export type ChannelNiche = "LUXURY" | "AFFORDABLE" | "GENERAL" | "TIKTOK";

export type AgencyRole = "ADMIN" | "BROKER" | "SMM";

export interface AgencyMember {
  user_id: string;
  agency_id: string;
  role: AgencyRole;
  display_name: string;
  whatsapp_phone: string | null;
  telegram_chat_id: string | null;
  commission_split_pct: number;
  is_active: boolean;
  created_at: string;
  email?: string | null;
}

export interface AgencySettings {
  agency_id: string;
  public_phone: string;
  telegram_chat_id: string | null;
  niche_rules_json: {
    luxury_min_azn: number;
    affordable_max_azn: number;
    viral_drop_pct: number;
    [key: string]: unknown;
  };
  social_api_mode: "OFFICIAL" | "TELEGRAM_FALLBACK";
  watermark_preset_json: Record<string, unknown>;
  monthly_ai_budget_usd: number;
  ai_rate_limit_rpm: number;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  conversation_id: string;
  agency_id: string;
  operator_id: string;
  sender_type: "USER" | "AGENT" | "SYSTEM";
  sender_name: string;
  content: string;
  action_payload: Record<string, unknown>;
  seq_num: number;
  created_at: string;
}

export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export type CockpitPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type CockpitStatus = "PENDING" | "EXECUTED" | "DISMISSED" | "SNOOZED";

export interface CockpitCard {
  id: string;
  agency_id?: string;
  lead_id: string | null;
  listing_id: string | null;
  channel: string;
  priority: CockpitPriority | string;
  headline: string;
  draft_text: string | null;
  reason: string | null;
  sentinel_warning: string | null;
  status: CockpitStatus | string;
  created_at: string;
  target_uri: string | null;
  strategic_rationale?: string | null;
  assigned_agent_id?: string | null;
  created_by?: string | null;
  expires_at?: string | null;
  owner_id?: string | null;
}

export type LeadTimelineActor =
  | "OPERATOR"
  | "BUYER"
  | "SELLER"
  | "AI_SENTINEL"
  | "AI_SCRIBE"
  | "AI_STRATEGIST"
  | "AI_JANITOR";

export type LeadTimelineEventType =
  | "INQUIRY"
  | "OBJECTION"
  | "CALL_LOG"
  | "OFFER"
  | "COMMISSION_AGREED"
  | "SHOWING_SCHEDULED"
  | "DEAL_CLOSED"
  | "DEAL_LOST";

export interface LeadTimelineEvent {
  id: string;
  lead_id: string | null;
  listing_id: string | null;
  actor: LeadTimelineActor | string;
  event_type: LeadTimelineEventType | string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type TelemetryStatus = "PENDING" | "ACTIVE" | "FROZEN" | "ERROR";

export type HookType = "PRICE_FIRST" | "LOCATION_FIRST" | "LUXURY_LIFESTYLE";

export type DurationBucket = "SHORT_25_30" | "LONG_40_50";

export type LeadSourceChannel =
  | "IG_DM"
  | "WHATSAPP"
  | "TIKTOK_DM"
  | "CALL"
  | "TELEGRAM"
  | "REFERRAL";

export type LeadStage =
  | "NEW_INQUIRY"
  | "QUALIFIED"
  | "VIEWING_SCHEDULED"
  | "VIEWED"
  | "NEGOTIATING"
  | "DEPOSIT"
  | "WON_CLOSED"
  | "LOST"
  | "COLD";

export type LeadListingRelation =
  | "INQUIRED"
  | "PITCHED"
  | "VIEWED"
  | "REJECTED"
  | "OFFERED";

export type FollowUpEntityType =
  | "BUYER_LEAD"
  | "OWNER_OUTREACH"
  | "DUPLICATE_REVIEW";

export type TaskPriority = "LOW" | "NORMAL" | "HIGH";
export type TaskStatus = "OPEN" | "SNOOZED" | "DONE" | "CANCELLED";

export type JobType =
  | "SCRAPE_NEW"
  | "RENDER_INITIAL"
  | "RENDER_PRICE_DROP"
  | "RERENDER"
  | "LIVENESS_CHECK"
  | "SYNC_SOCIAL_METRICS"
  | "PREFLIGHT_CHECK"
  | "TELEGRAM_DISPATCH";

export type JobTriggerSource =
  | "AUTO_SCHEDULER"
  | "WEB_UI"
  | "TELEGRAM_WEBHOOK";

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export interface Listing {
  id: string;
  bina_id: string;
  url: string;
  duplicate_of_listing_id: string | null;
  duplicate_confidence: number | null;
  duplicate_resolution: DuplicateResolution;
  photo_urls_hash: string | null;
  content_revision: number;
  last_rendered_revision: number | null;
  title: string | null;
  price: number | null;
  currency: Currency;
  price_azn_normalized: number;
  location: string | null;
  district_normalized: string | null;
  address: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors: number | null;
  has_bill_of_sale: boolean;
  is_owner: boolean;
  contact_name: string | null;
  owner_phone_raw: string | null;
  owner_phone_normalized: string | null;
  photo_urls: string[];
  description: string | null;
  archetype: Archetype;
  source_availability: SourceAvailability;
  first_seen_at: string;
  last_seen_at: string;
  last_checked_at: string | null;
  pipeline_status: PipelineStatus;
  editorial_status: EditorialStatus;
  owner_outreach_status: OwnerOutreachStatus;
  commission_type: CommissionType | null;
  commission_value: number | null;
  owner_min_price_azn: number | null;
  owner_last_contacted_at: string | null;
  owner_next_checkin_at: string | null;
  owner_notes: string | null;
  last_auto_rendered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListingEvent {
  id: string;
  listing_id: string;
  event_type: ListingEventType;
  old_value_json: Record<string, unknown> | null;
  new_value_json: Record<string, unknown> | null;
  price_delta_pct: number | null;
  triggered_job_id: string | null;
  actor: EventActor;
  created_at: string;
  listings?: Pick<Listing, "id" | "bina_id" | "title" | "price_azn_normalized" | "location"> | null;
}

export interface RenderVersion {
  id: string;
  listing_id: string;
  version_num: number;
  content_revision: number;
  trigger_reason: RenderTriggerReason;
  script_angle: string | null;
  voice_engine: string | null;
  voice_id: string | null;
  model_id: string | null;
  script_text: string | null;
  local_video_path: string | null;
  storage_object_path: string | null;
  video_cdn_url: string | null;
  duration_seconds: number | null;
  status: RenderStatus;
  hook_type: HookType | null;
  duration_bucket: DurationBucket | null;
  rendered_price?: number | null;
  rendered_currency?: string | null;
  ab_metadata?: Record<string, unknown> | null;
  telegram_message_id: string | null;
  storage_pruned_at: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Publication {
  id: string;
  listing_id: string;
  render_version_id: string | null;
  channel: PublicationChannel;
  post_url: string | null;
  caption_used: string | null;
  status: PublicationStatus;
  published_at: string | null;
  verified_at?: string | null;
  preflight_status?: PreflightStatus;
  last_preflight_error?: string | null;
  telegram_dispatched_at?: string | null;
  telegram_message_id?: string | number | null;
  target_account_handle?: string;
  channel_niche?: ChannelNiche;
  notes: string | null;
  views_count: number;
  likes_count: number;
  comments_count: number;
  shares_count: number;
  external_post_id: string | null;
  telemetry_status: TelemetryStatus;
  last_scraped_at: string | null;
  next_poll_at: string | null;
  poll_count?: number;
  scrape_error_count?: number;
  last_scrape_error?: string | null;
  created_at: string;
}

export type PreflightCheckResult =
  | "PASSED"
  | "PRICE_CHANGED"
  | "REMOVED_ON_BINA"
  | "SCRAPE_ERROR"
  | "ERROR";

export interface PreflightCheck {
  id: string;
  listing_id: string;
  bina_id: number | string;
  check_type?: string;
  result: PreflightCheckResult;
  portal_price?: number | null;
  video_price?: number | null;
  price_delta_pct?: number | null;
  response_time_ms?: number | null;
  checked_at: string;
}

export interface SocialComment {
  id: string;
  publication_id: string;
  platform_comment_id: string;
  author_handle: string;
  comment_text: string;
  like_count: number;
  is_intent_lead: boolean;
  intent_category: string | null;
  intent_confidence: number | null;
  suggested_reply: string | null;
  buyer_lead_id: string | null;
  created_at: string;
  publications?: (Pick<Publication, "id" | "listing_id" | "post_url" | "channel"> & {
    listings?: Pick<Listing, "id" | "bina_id" | "title" | "price_azn_normalized" | "location"> | null;
  }) | null;
  buyer_leads?: Pick<BuyerLead, "id" | "client_name" | "phone_normalized" | "stage"> | null;
}

export interface TelemetrySnapshot {
  id: string;
  publication_id: string;
  snapshot_phase: string;
  views_count: number;
  likes_count: number;
  comments_count: number;
  ner_score: number | null;
  captured_at: string;
}

export interface BuyerLead {
  id: string;
  client_name: string;
  phone_normalized: string | null;
  social_handle: string | null;
  source_channel: LeadSourceChannel;
  stage: LeadStage;
  budget_max_azn: number | null;
  preferred_districts: string[];
  expected_commission_azn: number | null;
  actual_commission_azn: number | null;
  lost_reason: string | null;
  notes: string | null;
  next_followup_at: string | null;
  attributed_publication_id: string | null;
  attributed_channel_niche: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadListingJoin {
  lead_id: string;
  listing_id: string;
  relation: LeadListingRelation;
  notes: string | null;
  updated_at: string;
  listings?: Pick<
    Listing,
    | "id"
    | "bina_id"
    | "title"
    | "location"
    | "price_azn_normalized"
    | "source_availability"
    | "owner_outreach_status"
    | "editorial_status"
    | "rooms"
    | "area"
  > | null;
}

export interface BuyerLeadWithListings extends BuyerLead {
  lead_listings: LeadListingJoin[];
}

export interface FollowUpTask {
  id: string;
  entity_type: FollowUpEntityType;
  lead_id: string | null;
  listing_id: string | null;
  title: string;
  due_at: string;
  priority: TaskPriority;
  status: TaskStatus;
  reminder_sent_at: string | null;
  snooze_count: number;
  completed_at: string | null;
  outcome_note: string | null;
  created_at: string;
  updated_at: string;
  listings?: Pick<Listing, "id" | "bina_id" | "title" | "price_azn_normalized"> | null;
  buyer_leads?: Pick<BuyerLead, "id" | "client_name" | "phone_normalized" | "stage"> | null;
}

export interface PipelineJob {
  id: string;
  agency_id?: string;
  idempotency_key: string;
  job_type: JobType;
  listing_id: string | null;
  trigger_source: JobTriggerSource;
  params_json: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  lease_expires_at: string | null;
  expires_at: string | null;
  cancel_requested_at?: string | null;
  error_message: string | null;
  assigned_agent_id?: string | null;
  created_by?: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  listings?: Pick<Listing, "id" | "bina_id" | "title"> | null;
}

export interface WorkerLogEntry {
  ts: string;
  level: string;
  msg: string;
}

export interface WorkerTelemetryMetadata {
  state?: "STARTING" | "IDLE" | "PROCESSING" | "RESTARTING" | "STOPPED" | string;
  pid?: number;
  started_at?: string;
  jobs_processed_session?: number;
  current_phase?: string | null;
  current_bina_id?: string | null;
  next_schedule_baku?: string | null;
  recent_logs?: WorkerLogEntry[];
  last_job_id?: string | null;
  last_job_type?: string | null;
  last_job_status?: string | null;
  last_job_error?: string | null;
  last_job_finished_at?: string | null;
  last_crash_at?: string | null;
  last_crash_exit_code?: number | null;
}

export interface WorkerStatusRow {
  worker_id: string;
  last_seen_at: string;
  current_job_id: string | null;
  current_job_type: JobType | null;
  current_job_status: JobStatus | null;
  metadata_json: WorkerTelemetryMetadata | null;
  is_online: boolean;
  seconds_since_heartbeat: number | null;
  current_job_started_at?: string | null;
  current_job_params?: Record<string, unknown> | null;
  current_listing_bina_id?: string | null;
  current_listing_title?: string | null;
}
