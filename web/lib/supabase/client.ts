"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

type BrowserClient = ReturnType<typeof createBrowserClient>;

let browserClient: BrowserClient | null = null;

export function createClient(): BrowserClient {
  if (!browserClient) {
    const { url, anonKey } = getSupabaseEnv();
    browserClient = createBrowserClient(
      url || "https://placeholder.supabase.co",
      anonKey || "placeholder-anon-key"
    );
  }
  return browserClient;
}

export function resetBrowserClientForTest(): void {
  browserClient = null;
}
