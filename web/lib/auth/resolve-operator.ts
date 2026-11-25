import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AgencyRole } from "@/lib/types";

export interface ResolvedOperator {
  operatorId: string;
  email?: string;
  agencyId: string;
  role: AgencyRole;
  displayName: string;
}

type OperatorResolutionResult =
  | { status: "ok"; operator: ResolvedOperator }
  | { status: "unauthenticated"; error: string }
  | { status: "forbidden"; error: string };

function isThreePartJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

async function resolveOperatorInternal(
  request: Request,
  allowedRoles?: AgencyRole[]
): Promise<OperatorResolutionResult> {
  let userId: string | null = null;
  let userEmail: string | undefined;

  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim() || "";
    if (!token || !isThreePartJwt(token)) {
      return {
        status: "unauthenticated",
        error: "İstifadəçi autentifikasiyadan keçməyib (Unauthorized).",
      };
    }

    try {
      const supabaseAdmin = createAdminClient();
      const {
        data: { user },
        error,
      } = await supabaseAdmin.auth.getUser(token);
      if (error || !user?.id) {
        return {
          status: "unauthenticated",
          error: "İstifadəçi autentifikasiyadan keçməyib (Unauthorized).",
        };
      }
      userId = user.id;
      userEmail = user.email ?? undefined;
    } catch {
      return {
        status: "unauthenticated",
        error: "İstifadəçi autentifikasiyadan keçməyib (Unauthorized).",
      };
    }
  } else {
    try {
      const supabaseServer = await createClient();
      const {
        data: { user },
        error,
      } = await supabaseServer.auth.getUser();
      if (!error && user?.id) {
        userId = user.id;
        userEmail = user.email ?? undefined;
      }
    } catch {
      // Cookie session unavailable
    }
  }

  if (!userId) {
    return {
      status: "unauthenticated",
      error: "İstifadəçi autentifikasiyadan keçməyib (Unauthorized).",
    };
  }

  const supabaseAdmin = createAdminClient();
  const { data: member, error: memberError } = await supabaseAdmin
    .from("agency_members")
    .select("user_id, agency_id, role, display_name, is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError || !member) {
    return {
      status: "forbidden",
      error: "Agentlik üzvlüyü tapılmadı (Forbidden).",
    };
  }

  if (member.is_active !== true) {
    return {
      status: "forbidden",
      error: "İstifadəçi hesabı deaktiv edilib (Forbidden).",
    };
  }

  const role = member.role as AgencyRole;
  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    return {
      status: "forbidden",
      error: "Bu əməliyyat üçün rol icazəniz yoxdur (Forbidden).",
    };
  }

  return {
    status: "ok",
    operator: {
      operatorId: userId,
      email: userEmail,
      agencyId: member.agency_id as string,
      role,
      displayName: (member.display_name as string) || userEmail || "Operator",
    },
  };
}

export async function resolveOperator(
  request: Request
): Promise<ResolvedOperator | null> {
  const res = await resolveOperatorInternal(request);
  return res.status === "ok" ? res.operator : null;
}

export async function requireOperator(
  request: Request,
  allowedRoles?: AgencyRole[]
): Promise<
  | { ok: true; operator: ResolvedOperator }
  | { ok: false; response: NextResponse }
> {
  const res = await resolveOperatorInternal(request, allowedRoles);
  if (res.status === "ok") {
    return { ok: true, operator: res.operator };
  }

  if (res.status === "unauthenticated") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          success: false,
          code: "UNAUTHORIZED",
          error: res.error,
        },
        { status: 401 }
      ),
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      {
        ok: false,
        success: false,
        code: "FORBIDDEN",
        error: res.error,
      },
      { status: 403 }
    ),
  };
}
