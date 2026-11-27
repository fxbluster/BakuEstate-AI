import { cache } from "react";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv, isSupabaseConfigured } from "./env";
import type { AgencyMember } from "@/lib/types";

type CookieToSet = {
  name: string;
  value: string;
  options: CookieOptions;
};

export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(
    url || "https://placeholder.supabase.co",
    anonKey || "placeholder-anon-key",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // setAll called from a Server Component — middleware handles session refresh.
          }
        },
      },
    }
  );
}

export const createServerSupabaseClient = createClient;

export const getServerSessionMember = cache(
  async (): Promise<AgencyMember | null> => {
    if (!isSupabaseConfigured()) {
      return null;
    }

    try {
      const supabase = await createClient();
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (error || !user?.id) {
        return null;
      }

      const { data: member, error: memberError } = await supabase
        .from("agency_members")
        .select(
          "user_id, agency_id, role, display_name, whatsapp_phone, telegram_chat_id, commission_split_pct, is_active, created_at"
        )
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();

      if (memberError || !member || member.is_active !== true) {
        return null;
      }

      return {
        ...(member as AgencyMember),
        email: user.email ?? null,
      };
    } catch {
      return null;
    }
  }
);
