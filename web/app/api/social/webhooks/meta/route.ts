import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Meta Webhook Subscription Verification (GET)
 * Returns raw `hub.challenge` when `hub.mode === 'subscribe'` and
 * `hub.verify_token` matches `process.env.META_WEBHOOK_VERIFY_TOKEN`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode") ?? "";
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge");

  const expectedToken = (process.env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  if (!expectedToken) {
    return NextResponse.json(
      { ok: false, error: "META_WEBHOOK_VERIFY_TOKEN konfiqurasiya edilməyib." },
      { status: 503 }
    );
  }

  if (
    mode === "subscribe" &&
    challenge !== null &&
    timingSafeEqualStrings(token, expectedToken)
  ) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return NextResponse.json(
    { ok: false, error: "Webhook doğrulama nişanı (verify_token) uyğun gəlmir." },
    { status: 403 }
  );
}

interface MetaWebhookCommentValue {
  id?: string;
  text?: string;
  like_count?: number;
  media_id?: string;
  username?: string;
  from?: {
    id?: string;
    username?: string;
  };
  media?: {
    id?: string;
    media_product_type?: string;
  };
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{
      field?: string;
      value?: MetaWebhookCommentValue;
    }>;
  }>;
}

/**
 * Meta Webhook Event Receiver (POST)
 * Enforces `X-Hub-Signature-256` HMAC-SHA256 verification via `crypto.timingSafeEqual`
 * before looking up indexed `publications(channel, external_post_id)` or calling
 * `upsert_social_comment_returning_is_new`.
 */
export async function POST(request: Request) {
  const sigHeader = (request.headers.get("x-hub-signature-256") ?? "").trim().toLowerCase();
  if (!sigHeader.startsWith("sha256=")) {
    return NextResponse.json(
      { ok: false, code: "INVALID_SIGNATURE", error: "X-Hub-Signature-256 başlığı tələb olunur." },
      { status: 401 }
    );
  }

  const appSecret = (process.env.META_APP_SECRET ?? "").trim();
  if (!appSecret) {
    return NextResponse.json(
      { ok: false, error: "META_APP_SECRET konfiqurasiya edilməyib." },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const expectedSig =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  if (!timingSafeEqualStrings(sigHeader, expectedSig)) {
    return NextResponse.json(
      { ok: false, code: "INVALID_SIGNATURE", error: "X-Hub-Signature-256 imzası etibarsızdır." },
      { status: 401 }
    );
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Webhook gövdəsi etibarlı JSON deyil." },
      { status: 400 }
    );
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  if (entries.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, inserted: 0 });
  }

  const supabase = createAdminClient();
  let processed = 0;
  let inserted = 0;

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== "comments" && change.field !== "live_comments") {
        continue;
      }

      const val = change.value;
      if (!val || typeof val !== "object") continue;

      const externalPostId = String(val.media?.id || val.media_id || "").trim();
      const platformCommentId = String(val.id || "").trim();
      const commentText = String(val.text || "").trim();
      const authorHandle = String(
        val.from?.username || val.username || val.from?.id || "instagram_user"
      ).trim();

      if (!externalPostId || !platformCommentId || !commentText) {
        continue;
      }

      const { data: pub, error: pubErr } = await supabase
        .from("publications")
        .select("id, agency_id, listing_id")
        .eq("channel", "INSTAGRAM_REELS")
        .eq("external_post_id", externalPostId)
        .maybeSingle();

      if (pubErr || !pub?.id || !pub?.agency_id) {
        continue;
      }

      processed += 1;
      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        "upsert_social_comment_returning_is_new",
        {
          p_agency_id: pub.agency_id,
          p_publication_id: pub.id,
          p_platform_comment_id: platformCommentId,
          p_author_handle: authorHandle,
          p_comment_text: commentText,
          p_like_count: Number(val.like_count ?? 0) || 0,
          p_is_intent_lead: false,
          p_intent_category: null,
          p_intent_confidence: null,
          p_suggested_reply: null,
          p_buyer_lead_id: null,
        }
      );

      if (!rpcErr && rpcData) {
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        if (row && (row as { is_new?: boolean }).is_new === true) {
          inserted += 1;
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    inserted,
  });
}
