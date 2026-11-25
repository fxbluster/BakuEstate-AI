import type { Metadata, Viewport } from "next";
import type React from "react";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { getServerSessionMember } from "@/lib/supabase/server";
import type { AgencyMember } from "@/lib/types";

export const metadata: Metadata = {
  title: "BakuEstate-AI — 24/7 Veb CRM",
  description:
    "BakuEstate-AI daşınmaz əmlak video istehsalı, elan reyestri, müştəri follow-up və iş növbəsi idarəetmə paneli.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#090B10",
};

const AppShellWithMember = AppShell as React.ComponentType<{
  children: React.ReactNode;
  member?: AgencyMember | null;
}>;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const member = await getServerSessionMember();

  return (
    <html lang="az" className="dark">
      <body className="font-sans">
        <AppShellWithMember member={member}>{children}</AppShellWithMember>
      </body>
    </html>
  );
}
