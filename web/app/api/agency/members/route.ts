import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import type { AgencyRole } from "@/lib/types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ROLES = new Set<AgencyRole>(["ADMIN", "BROKER", "SMM"]);

export async function GET(request: Request) {
  const auth = await requireOperator(request, ["ADMIN"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  const supabase = createAdminClient();
  const { data: members, error } = await supabase
    .from("agency_members")
    .select(
      "user_id, agency_id, role, display_name, whatsapp_phone, telegram_chat_id, commission_split_pct, is_active, created_at"
    )
    .eq("agency_id", operator.agencyId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message || "Komanda üzvləri oxuna bilmədi." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    members: members ?? [],
  });
}

export async function PATCH(request: Request) {
  const auth = await requireOperator(request, ["ADMIN"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Sorğu gövdəsi etibarlı JSON deyil." },
      { status: 400 }
    );
  }

  const targetUserId =
    typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!UUID_REGEX.test(targetUserId)) {
    return NextResponse.json(
      { ok: false, error: "user_id etibarlı UUID olmalıdır." },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.role !== undefined) {
    if (
      typeof body.role !== "string" ||
      !VALID_ROLES.has(body.role as AgencyRole)
    ) {
      return NextResponse.json(
        { ok: false, error: "role yalnız ADMIN, BROKER və ya SMM ola bilər." },
        { status: 400 }
      );
    }
    if (targetUserId === operator.operatorId && body.role !== "ADMIN") {
      return NextResponse.json(
        { ok: false, error: "Öz ADMIN rolunuzu aşağı sala bilməzsiniz." },
        { status: 400 }
      );
    }
    patch.role = body.role;
  }

  if (body.commission_split_pct !== undefined) {
    const split = Number(body.commission_split_pct);
    if (!Number.isFinite(split) || split < 0 || split > 100) {
      return NextResponse.json(
        {
          ok: false,
          error: "commission_split_pct 0 ilə 100 arasında olmalıdır.",
        },
        { status: 400 }
      );
    }
    patch.commission_split_pct = Number(split.toFixed(2));
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "is_active boolean (true/false) olmalıdır." },
        { status: 400 }
      );
    }
    if (targetUserId === operator.operatorId && body.is_active === false) {
      return NextResponse.json(
        { ok: false, error: "Öz hesabınızı deaktiv edə bilməzsiniz." },
        { status: 400 }
      );
    }
    patch.is_active = body.is_active;
  }

  if (body.display_name !== undefined) {
    if (typeof body.display_name !== "string" || !body.display_name.trim()) {
      return NextResponse.json(
        { ok: false, error: "display_name boş ola bilməz." },
        { status: 400 }
      );
    }
    patch.display_name = body.display_name.trim();
  }

  if (body.whatsapp_phone !== undefined) {
    if (body.whatsapp_phone !== null && typeof body.whatsapp_phone !== "string") {
      return NextResponse.json(
        { ok: false, error: "whatsapp_phone mətn və ya null olmalıdır." },
        { status: 400 }
      );
    }
    patch.whatsapp_phone =
      typeof body.whatsapp_phone === "string"
        ? body.whatsapp_phone.trim() || null
        : null;
  }

  if (body.telegram_chat_id !== undefined) {
    if (
      body.telegram_chat_id !== null &&
      typeof body.telegram_chat_id !== "string"
    ) {
      return NextResponse.json(
        { ok: false, error: "telegram_chat_id mətn və ya null olmalıdır." },
        { status: 400 }
      );
    }
    patch.telegram_chat_id =
      typeof body.telegram_chat_id === "string"
        ? body.telegram_chat_id.trim() || null
        : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, error: "Yenilənməli sahə göndərilməyib." },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const { data: updatedMember, error } = await supabase
    .from("agency_members")
    .update(patch)
    .eq("user_id", targetUserId)
    .eq("agency_id", operator.agencyId)
    .select(
      "user_id, agency_id, role, display_name, whatsapp_phone, telegram_chat_id, commission_split_pct, is_active, created_at"
    )
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message || "Üzv məlumatı yenilənə bilmədi." },
      { status: 500 }
    );
  }

  if (!updatedMember) {
    return NextResponse.json(
      { ok: false, error: "İstifadəçi bu agentlikdə tapılmadı." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    member: updatedMember,
  });
}
