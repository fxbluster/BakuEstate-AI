"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, Mail, ShieldCheck, Sparkles, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";
  const configMissing =
    searchParams.get("reason") === "config" || !isSupabaseConfigured();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let active = true;
    const supabase = createClient();

    async function hydrateRecoverySession() {
      if (typeof window === "undefined") return;
      const hashStr = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const hashParams = new URLSearchParams(hashStr);
      const urlParams = new URLSearchParams(window.location.search);

      const errDesc =
        hashParams.get("error_description") || urlParams.get("error_description");
      if (errDesc) {
        if (active) setError(`Link etibarsızdır və ya vaxtı bitib: ${errDesc}`);
        return;
      }

      const code = urlParams.get("code");
      const tokenHash = urlParams.get("token_hash");
      const typeParam = hashParams.get("type") || urlParams.get("type");
      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");

      if (typeParam === "recovery" || accessToken || code || tokenHash) {
        if (active) {
          setRecoveryMode(true);
          setError(null);
        }
      }

      try {
        if (accessToken && refreshToken) {
          const { error: sessErr } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (sessErr && active) {
            setError(`Sessiya bərpa edilə bilmədi: ${sessErr.message}`);
          }
        } else if (code) {
          const { error: codeErr } = await supabase.auth.exchangeCodeForSession(code);
          if (codeErr && active) {
            setError(`Sessiya kodu doğrulana bilmədi: ${codeErr.message}`);
          }
        } else if (tokenHash && typeParam === "recovery") {
          const { error: otpErr } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: "recovery",
          });
          if (otpErr && active) {
            setError(`Doğrulama xətası: ${otpErr.message}`);
          }
        }
      } catch {
        if (active) {
          setError("Şifrə bərpası sessiyası açılarkən xəta baş verdi. Yeni link istəyin.");
        }
      }
    }

    hydrateRecoverySession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && active) {
        setRecoveryMode(true);
        setError(null);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [searchParams]);

  async function handleForgotPassword() {
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError("Şifrə sıfırlamaq üçün əvvəlcə email ünvanınızı daxil edin.");
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const redirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/login` : undefined;
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        redirectTo ? { redirectTo } : undefined
      );
      if (resetError) {
        setError(`Sıfırlama xətası: ${resetError.message}`);
        return;
      }
      setInfo("Şifrə yeniləmə linki e-poçt ünvanınıza göndərildi.");
    } catch {
      setError("Serverlə əlaqə zamanı xəta baş verdi. Yenidən cəhd edin.");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdatePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (newPassword.length < 8) {
      setError("Yeni şifrə ən azı 8 simvol olmalıdır.");
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error: updateErr } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateErr) {
        setError(`Şifrə yenilənmədi: ${updateErr.message}`);
        return;
      }
      if (typeof window !== "undefined" && window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      setRecoveryMode(false);
      setNewPassword("");
      setInfo("Şifrə uğurla yeniləndi! İndi sistemə daxil ola bilərsiniz.");
    } catch {
      setError("Serverlə əlaqə zamanı xəta baş verdi.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!isSupabaseConfigured()) {
      setError(
        "Supabase mühit dəyişənləri (NEXT_PUBLIC_SUPABASE_URL və NEXT_PUBLIC_SUPABASE_ANON_KEY) konfiqurasiya edilməyib."
      );
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { data: authData, error: authError } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

      if (authError || !authData.user) {
        setError(
          authError?.message === "Invalid login credentials"
            ? "Email və ya şifrə yanlışdır."
            : `Giriş xətası: ${authError?.message || "Sessiya yaradıla bilmədi."}`
        );
        return;
      }

      const { data: member, error: memberError } = await supabase
        .from("agency_members")
        .select("user_id, agency_id, role, is_active")
        .eq("user_id", authData.user.id)
        .maybeSingle();

      if (memberError || !member || member.is_active !== true) {
        await supabase.auth.signOut();
        setError(
          member && member.is_active === false
            ? "Hesabınız deaktiv edilib. Agentlik rəhbəri ilə əlaqə saxlayın."
            : "Aktiv agentlik üzvlüyünüz tapılmadı. Sistemə giriş icazəsi yoxdur."
        );
        return;
      }

      const safeNext =
        nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";
      router.replace(safeNext);
      router.refresh();
    } catch {
      setError("Serverlə əlaqə zamanı xəta baş verdi. Yenidən cəhd edin.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-gold-400 to-gold-600 text-obsidian-950 shadow-lg shadow-gold-500/20">
            <Sparkles className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-50">
              BakuEstate-AI CRM
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              24/7 Operator İdarəetmə Paneli • Yalnız Səlahiyyətli Giriş
            </p>
          </div>
        </div>

        <div className="exec-card p-6 sm:p-7 space-y-5">
          {configMissing && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
              <div>
                <p className="font-semibold">Konfiqurasiya tələb olunur</p>
                <p className="mt-1 text-amber-200/80">
                  <code className="font-mono">.env.local</code> faylında{" "}
                  <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> və{" "}
                  <code className="font-mono">
                    NEXT_PUBLIC_SUPABASE_ANON_KEY
                  </code>{" "}
                  dəyişənlərini təyin edin.
                </p>
              </div>
            </div>
          )}

          {info && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
              {info}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          {recoveryMode ? (
            <form onSubmit={handleUpdatePassword} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="new-password"
                  className="block text-xs font-medium uppercase tracking-wider text-slate-400"
                >
                  Yeni Şifrə (min. 8 simvol)
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    id="new-password"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="exec-input pl-10"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="exec-btn-primary w-full py-3 mt-2"
              >
                {loading ? "Yenilənir..." : "Yeni Şifrəni Təsdiqlə"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setRecoveryMode(false);
                  setError(null);
                }}
                className="w-full text-center text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                Giriş formasına qayıt
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="email"
                  className="block text-xs font-medium uppercase tracking-wider text-slate-400"
                >
                  Operator Email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operator@bakuestate.az"
                    className="exec-input pl-10"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="password"
                    className="block text-xs font-medium uppercase tracking-wider text-slate-400"
                  >
                    Şifrə
                  </label>
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={loading}
                    className="text-xs text-gold-400 hover:text-gold-300 transition-colors"
                  >
                    Şifrəni unutdum?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="exec-input pl-10"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="exec-btn-primary w-full py-3 mt-2"
              >
                {loading ? "Daxil olunur..." : "Sistemə Daxil Ol"}
              </button>
            </form>
          )}

          <div className="flex items-center justify-center gap-2 border-t border-slate-800/80 pt-4 text-xs text-slate-500">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span>Supabase Auth + Row-Level Security (RLS) ilə qorunur</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-sm text-slate-400">
          Yüklənir...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
