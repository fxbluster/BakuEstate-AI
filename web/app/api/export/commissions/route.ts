import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";

const MAX_EXPORT_DAYS = 365;
const MAX_EXPORT_ROWS = 10_000;
const FORMULA_PREFIX_REGEX = /^[=+\-@\t\r]/;
const EXPORT_STAGES = ["NEGOTIATING", "DEPOSIT", "WON_CLOSED"];
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  let text = String(value);
  if (FORMULA_PREFIX_REGEX.test(text)) {
    text = `'${text}`;
  }
  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseDateParam(raw: string | null, isEnd: boolean): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = DATE_ONLY_REGEX.test(trimmed)
    ? `${trimmed}T${isEnd ? "23:59:59.999" : "00:00:00.000"}Z`
    : trimmed;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: Request) {
  const auth = await requireOperator(request, ["ADMIN", "BROKER"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const now = new Date();
  const toDate = toParam ? parseDateParam(toParam, true) : now;
  const fromDate = fromParam
    ? parseDateParam(fromParam, false)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (!fromDate || !toDate) {
    return NextResponse.json(
      { ok: false, error: "from və to tarix parametrləri etibarlı ISO/YYYY-MM-DD olmalıdır." },
      { status: 400 }
    );
  }

  if (fromDate.getTime() > toDate.getTime()) {
    return NextResponse.json(
      { ok: false, error: "Başlanğıc tarixi (from) son tarixdən (to) böyük ola bilməz." },
      { status: 400 }
    );
  }

  const maxAllowedMs =
    MAX_EXPORT_DAYS * 24 * 60 * 60 * 1000 +
    (toParam && DATE_ONLY_REGEX.test(toParam.trim())
      ? 24 * 60 * 60 * 1000 - 1
      : 0);
  if (toDate.getTime() - fromDate.getTime() > maxAllowedMs) {
    return NextResponse.json(
      {
        ok: false,
        error: `İxrac aralığı maksimum ${MAX_EXPORT_DAYS} gün ola bilər.`,
      },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  let leadsQuery = supabase
    .from("buyer_leads")
    .select(
      "id, client_name, phone_normalized, stage, assigned_agent_id, budget_max_azn, expected_commission_azn, actual_commission_azn, updated_at"
    )
    .eq("agency_id", operator.agencyId)
    .in("stage", EXPORT_STAGES)
    .gte("updated_at", fromDate.toISOString())
    .lte("updated_at", toDate.toISOString());

  if (operator.role === "BROKER") {
    leadsQuery = leadsQuery.eq("assigned_agent_id", operator.operatorId);
  }

  const [{ data: leads, error: leadsErr }, { data: members, error: membersErr }] =
    await Promise.all([
      leadsQuery.order("updated_at", { ascending: false }).limit(MAX_EXPORT_ROWS),
      supabase
        .from("agency_members")
        .select("user_id, display_name, commission_split_pct")
        .eq("agency_id", operator.agencyId),
    ]);

  if (leadsErr || membersErr) {
    return NextResponse.json(
      {
        ok: false,
        error:
          leadsErr?.message ||
          membersErr?.message ||
          "Komissiya məlumatları oxuna bilmədi.",
      },
      { status: 500 }
    );
  }

  const memberMap = new Map<
    string,
    { displayName: string; splitPct: number }
  >();
  for (const m of members ?? []) {
    memberMap.set(String(m.user_id), {
      displayName: String(m.display_name || "Broker"),
      splitPct: Number(m.commission_split_pct ?? 50),
    });
  }

  const header = [
    "lead_id",
    "client_name",
    "phone_normalized",
    "stage",
    "agent_name",
    "commission_pct",
    "commission_split_pct",
    "expected_broker_azn",
    "expected_agency_azn",
    "updated_at",
  ].join(",");

  const csvRows: string[] = [header];

  for (const lead of leads ?? []) {
    const memberInfo = lead.assigned_agent_id
      ? memberMap.get(String(lead.assigned_agent_id))
      : undefined;

    const agentName = memberInfo?.displayName ?? "Təhkim olunmayıb";
    const splitPct = Number(memberInfo?.splitPct ?? 50);
    const totalCommissionAzn = Number(
      lead.actual_commission_azn ?? lead.expected_commission_azn ?? 0
    );
    const budgetMaxAzn = Number(lead.budget_max_azn ?? 0);
    const commissionPct =
      budgetMaxAzn > 0 && totalCommissionAzn > 0
        ? Number(((totalCommissionAzn / budgetMaxAzn) * 100).toFixed(2))
        : 0;
    const expectedBrokerAzn = Number(
      ((totalCommissionAzn * splitPct) / 100).toFixed(2)
    );
    const expectedAgencyAzn = Number(
      (totalCommissionAzn - expectedBrokerAzn).toFixed(2)
    );

    const row = [
      sanitizeCsvCell(lead.id),
      sanitizeCsvCell(lead.client_name),
      sanitizeCsvCell(lead.phone_normalized ?? ""),
      sanitizeCsvCell(lead.stage),
      sanitizeCsvCell(agentName),
      sanitizeCsvCell(commissionPct),
      sanitizeCsvCell(splitPct),
      sanitizeCsvCell(expectedBrokerAzn),
      sanitizeCsvCell(expectedAgencyAzn),
      sanitizeCsvCell(lead.updated_at),
    ].join(",");

    csvRows.push(row);
  }

  const fromLabel = fromDate.toISOString().slice(0, 10);
  const toLabel = toDate.toISOString().slice(0, 10);
  const encoder = new TextEncoder();
  const csvBytes = encoder.encode(`${csvRows.join("\n")}\n`);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const payload = new Uint8Array(bom.length + csvBytes.length);
  payload.set(bom, 0);
  payload.set(csvBytes, bom.length);

  return new Response(payload, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bakuestate-commissions-${fromLabel}_${toLabel}.csv"`,
      "Cache-Control": "no-store",
      "X-Row-Count": String((leads ?? []).length),
    },
  });
}
