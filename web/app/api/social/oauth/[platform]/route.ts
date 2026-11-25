import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";

export const runtime = "nodejs";

type SocialOAuthPlatform = "instagram" | "tiktok";

const OAUTH_STATE_COOKIE = "bakuestate_social_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "pages_show_list",
].join(",");

const TIKTOK_SCOPES = ["video.publish", "video.list"].join(",");

interface OAuthStatePayload {
  agencyId: string;
  userId: string;
  nonce: string;
  platform: SocialOAuthPlatform;
  iat: number;
  exp: number;
}

function normalizePlatform(raw: string): SocialOAuthPlatform | null {
  const lower = raw.trim().toLowerCase();
  if (lower === "instagram" || lower === "tiktok") {
    return lower;
  }
  return null;
}

function getOAuthStateSecret(): string | null {
  const secret =
    process.env.SOCIAL_OAUTH_STATE_SECRET ||
    process.env.META_APP_SECRET ||
    process.env.TIKTOK_CLIENT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";
  return secret.trim() || null;
}

function signStatePayload(payload: OAuthStatePayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded, "utf8").digest("hex");
  return `${encoded}.${sig}`;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignedStateCookie(
  rawCookie: string | null,
  secret: string
): OAuthStatePayload | null {
  if (!rawCookie) return null;
  const dotIdx = rawCookie.lastIndexOf(".");
  if (dotIdx <= 0) return null;

  const encoded = rawCookie.slice(0, dotIdx);
  const providedSig = rawCookie.slice(dotIdx + 1);
  if (!encoded || !providedSig) return null;

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(encoded, "utf8")
    .digest("hex");

  if (!timingSafeEqualStrings(providedSig, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<OAuthStatePayload>;

    if (
      !parsed ||
      typeof parsed.agencyId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.nonce !== "string" ||
      (parsed.platform !== "instagram" && parsed.platform !== "tiktok") ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    if (Date.now() > parsed.exp) {
      return null;
    }

    return parsed as OAuthStatePayload;
  } catch {
    return null;
  }
}

function readCookieFromRequest(request: Request, cookieName: string): string | null {
  const maybeNextReq = request as Request & {
    cookies?: { get?: (name: string) => { value?: string } | undefined };
  };
  if (maybeNextReq.cookies && typeof maybeNextReq.cookies.get === "function") {
    const val = maybeNextReq.cookies.get(cookieName)?.value;
    if (val) return val;
  }

  const cookieHeader = request.headers.get("cookie") || "";
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === cookieName) {
      const val = part.slice(eqIdx + 1).trim();
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return null;
}

function clearStateCookie(response: NextResponse) {
  response.cookies.set(OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function normalizeHandle(raw: string | undefined | null, fallback: string): string {
  const cleaned = (raw || "").trim();
  if (!cleaned) return fallback;
  return cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
}

async function exchangeInstagramCode(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  externalAccountId: string;
  accountHandle: string;
}> {
  const appId = (process.env.META_APP_ID ?? "").trim();
  const appSecret = (process.env.META_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    throw new OAuthConfigError("META_APP_ID və META_APP_SECRET konfiqurasiya edilməyib.");
  }

  const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl.toString(), { method: "GET" });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new OAuthExchangeError(
      tokenJson.error?.message || "Meta OAuth token mübadiləsi uğursuz oldu."
    );
  }

  let accessToken = tokenJson.access_token;
  let expiresInSeconds = Number(tokenJson.expires_in) || 5_184_000; // 60 days

  // Exchange for 60-day long-lived user/page token when possible
  try {
    const longUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", accessToken);

    const longRes = await fetch(longUrl.toString(), { method: "GET" });
    if (longRes.ok) {
      const longJson = (await longRes.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (longJson.access_token) {
        accessToken = longJson.access_token;
        if (longJson.expires_in) {
          expiresInSeconds = Number(longJson.expires_in) || expiresInSeconds;
        }
      }
    }
  } catch {
    // Keep short-lived token if long-lived exchange fails transiently
  }

  let externalAccountId = "ig_pending";
  let accountHandle = "@bakuestate.official";

  try {
    const accountsUrl = new URL("https://graph.facebook.com/v21.0/me/accounts");
    accountsUrl.searchParams.set(
      "fields",
      "id,name,instagram_business_account{id,username}"
    );
    accountsUrl.searchParams.set("access_token", accessToken);

    const accRes = await fetch(accountsUrl.toString(), { method: "GET" });
    if (accRes.ok) {
      const accJson = (await accRes.json()) as {
        data?: Array<{
          id?: string;
          name?: string;
          instagram_business_account?: { id?: string; username?: string };
        }>;
      };
      const igPage = accJson.data?.find((p) => p.instagram_business_account?.id);
      if (igPage?.instagram_business_account?.id) {
        externalAccountId = igPage.instagram_business_account.id;
        accountHandle = normalizeHandle(
          igPage.instagram_business_account.username,
          `@ig_${externalAccountId}`
        );
      } else if (accJson.data?.[0]?.id) {
        externalAccountId = accJson.data[0].id;
        accountHandle = normalizeHandle(accJson.data[0].name, `@fb_${externalAccountId}`);
      }
    }
  } catch {
    // Fallback identity above
  }

  return {
    accessToken,
    refreshToken: null,
    expiresInSeconds,
    externalAccountId,
    accountHandle,
  };
}

async function exchangeTikTokCode(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  externalAccountId: string;
  accountHandle: string;
}> {
  const clientKey = (process.env.TIKTOK_CLIENT_KEY ?? "").trim();
  const clientSecret = (process.env.TIKTOK_CLIENT_SECRET ?? "").trim();
  if (!clientKey || !clientSecret) {
    throw new OAuthConfigError(
      "TIKTOK_CLIENT_KEY və TIKTOK_CLIENT_SECRET konfiqurasiya edilməyib."
    );
  }

  const form = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    error_description?: string;
    message?: string;
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new OAuthExchangeError(
      tokenJson.error_description ||
        tokenJson.message ||
        "TikTok OAuth token mübadiləsi uğursuz oldu."
    );
  }

  const externalAccountId = tokenJson.open_id || `tt_${crypto.randomUUID().slice(0, 8)}`;
  let accountHandle = `@baku_emlak_ai_${externalAccountId.slice(0, 6)}`;

  try {
    const userRes = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      }
    );
    if (userRes.ok) {
      const userJson = (await userRes.json()) as {
        data?: { user?: { username?: string; display_name?: string } };
      };
      const username =
        userJson.data?.user?.username || userJson.data?.user?.display_name;
      if (username) {
        accountHandle = normalizeHandle(username, accountHandle);
      }
    }
  } catch {
    // Keep fallback handle
  }

  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresInSeconds: Number(tokenJson.expires_in) || 86_400, // 24 hours
    externalAccountId,
    accountHandle,
  };
}

class OAuthConfigError extends Error {}
class OAuthExchangeError extends Error {}

export async function GET(
  request: Request,
  context: { params: Promise<{ platform: string }> }
) {
  const { platform: rawPlatform } = await context.params;
  const platform = normalizePlatform(rawPlatform || "");
  if (!platform) {
    return NextResponse.json(
      { ok: false, error: "Dəstəklənməyən sosial platforma. Yalnız instagram və ya tiktok." },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const desc = url.searchParams.get("error_description") || oauthError;
    const errResp = NextResponse.json(
      { ok: false, code: "OAUTH_PROVIDER_ERROR", error: desc },
      { status: 400 }
    );
    clearStateCookie(errResp);
    return errResp;
  }

  const code = url.searchParams.get("code")?.trim() || "";
  const stateSecret = getOAuthStateSecret();

  // 1. OAuth Start Flow (no ?code=) -> requires ADMIN or SMM operator
  if (!code) {
    const auth = await requireOperator(request, ["ADMIN", "SMM"]);
    if (!auth.ok) {
      return auth.response;
    }

    if (!stateSecret) {
      return NextResponse.json(
        { ok: false, error: "OAuth state imzalama açarı konfiqurasiya edilməyib." },
        { status: 503 }
      );
    }

    const nonce = crypto.randomUUID();
    const statePayload: OAuthStatePayload = {
      agencyId: auth.operator.agencyId,
      userId: auth.operator.operatorId,
      nonce,
      platform,
      iat: Date.now(),
      exp: Date.now() + STATE_TTL_MS,
    };
    const signedCookie = signStatePayload(statePayload, stateSecret);

    let redirectTarget: URL;
    if (platform === "instagram") {
      const appId = (process.env.META_APP_ID ?? "").trim();
      if (!appId) {
        return NextResponse.json(
          { ok: false, error: "META_APP_ID konfiqurasiya edilməyib." },
          { status: 503 }
        );
      }
      const redirectUri =
        (process.env.META_OAUTH_REDIRECT_URI ?? "").trim() ||
        `${url.origin}/api/social/oauth/instagram`;
      redirectTarget = new URL("https://www.facebook.com/v21.0/dialog/oauth");
      redirectTarget.searchParams.set("client_id", appId);
      redirectTarget.searchParams.set("redirect_uri", redirectUri);
      redirectTarget.searchParams.set("state", nonce);
      redirectTarget.searchParams.set("response_type", "code");
      redirectTarget.searchParams.set("scope", INSTAGRAM_SCOPES);
    } else {
      const clientKey = (process.env.TIKTOK_CLIENT_KEY ?? "").trim();
      if (!clientKey) {
        return NextResponse.json(
          { ok: false, error: "TIKTOK_CLIENT_KEY konfiqurasiya edilməyib." },
          { status: 503 }
        );
      }
      const redirectUri =
        (process.env.TIKTOK_OAUTH_REDIRECT_URI ?? "").trim() ||
        `${url.origin}/api/social/oauth/tiktok`;
      redirectTarget = new URL("https://www.tiktok.com/v2/auth/authorize/");
      redirectTarget.searchParams.set("client_key", clientKey);
      redirectTarget.searchParams.set("redirect_uri", redirectUri);
      redirectTarget.searchParams.set("state", nonce);
      redirectTarget.searchParams.set("response_type", "code");
      redirectTarget.searchParams.set("scope", TIKTOK_SCOPES);
    }

    const res = NextResponse.redirect(redirectTarget.toString(), { status: 302 });
    res.cookies.set(OAUTH_STATE_COOKIE, signedCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: Math.floor(STATE_TTL_MS / 1000),
    });
    return res;
  }

  // 2. OAuth Callback Flow (?code=&state=) -> verify signed HTTP-only CSRF state cookie
  if (!stateSecret) {
    return NextResponse.json(
      { ok: false, error: "OAuth state imzalama açarı konfiqurasiya edilməyib." },
      { status: 503 }
    );
  }

  const stateParam = url.searchParams.get("state")?.trim() || "";
  const rawCookie = readCookieFromRequest(request, OAUTH_STATE_COOKIE);
  const verifiedState = verifySignedStateCookie(rawCookie, stateSecret);

  if (
    !stateParam ||
    !verifiedState ||
    verifiedState.platform !== platform ||
    !timingSafeEqualStrings(stateParam, verifiedState.nonce)
  ) {
    const mismatchResp = NextResponse.json(
      {
        ok: false,
        code: "CSRF_STATE_MISMATCH",
        error: "OAuth CSRF state doğrulaması uğursuz oldu.",
      },
      { status: 403 }
    );
    clearStateCookie(mismatchResp);
    return mismatchResp;
  }

  const redirectUri =
    platform === "instagram"
      ? (process.env.META_OAUTH_REDIRECT_URI ?? "").trim() ||
        `${url.origin}/api/social/oauth/instagram`
      : (process.env.TIKTOK_OAUTH_REDIRECT_URI ?? "").trim() ||
        `${url.origin}/api/social/oauth/tiktok`;

  let exchanged: Awaited<ReturnType<typeof exchangeInstagramCode>>;
  try {
    exchanged =
      platform === "instagram"
        ? await exchangeInstagramCode(code, redirectUri)
        : await exchangeTikTokCode(code, redirectUri);
  } catch (err) {
    const status = err instanceof OAuthConfigError ? 503 : 502;
    const message = err instanceof Error ? err.message : "OAuth token mübadiləsi xətası.";
    const failResp = NextResponse.json({ ok: false, error: message }, { status });
    clearStateCookie(failResp);
    return failResp;
  }

  const supabase = createAdminClient();
  const dbPlatform = platform === "instagram" ? "INSTAGRAM" : "TIKTOK";
  const secretBaseName = `social_${verifiedState.agencyId}_${platform}_${exchanged.externalAccountId}`;

  const { data: vaultSecretId, error: vaultErr } = await supabase.rpc(
    "store_social_secret",
    {
      p_name: `${secretBaseName}_access`,
      p_secret: exchanged.accessToken,
    }
  );

  if (vaultErr || !vaultSecretId) {
    const vaultFailResp = NextResponse.json(
      {
        ok: false,
        error: vaultErr?.message || "Sosial token Vault-a yazıla bilmədi.",
      },
      { status: 500 }
    );
    clearStateCookie(vaultFailResp);
    return vaultFailResp;
  }

  let refreshVaultSecretId: string | null = null;
  if (exchanged.refreshToken) {
    const { data: refreshId, error: refreshErr } = await supabase.rpc(
      "store_social_secret",
      {
        p_name: `${secretBaseName}_refresh`,
        p_secret: exchanged.refreshToken,
      }
    );
    if (refreshErr || !refreshId) {
      const refreshFailResp = NextResponse.json(
        {
          ok: false,
          error: refreshErr?.message || "Refresh token Vault-a yazıla bilmədi.",
        },
        { status: 500 }
      );
      clearStateCookie(refreshFailResp);
      return refreshFailResp;
    }
    refreshVaultSecretId = String(refreshId);
  }

  const tokenExpiresAt = new Date(
    Date.now() + Math.max(60, exchanged.expiresInSeconds) * 1000
  ).toISOString();

  const { data: socialAccount, error: upsertErr } = await supabase
    .from("social_accounts")
    .upsert(
      {
        agency_id: verifiedState.agencyId,
        platform: dbPlatform,
        account_handle: exchanged.accountHandle,
        external_account_id: exchanged.externalAccountId,
        vault_secret_id: String(vaultSecretId),
        refresh_vault_secret_id: refreshVaultSecretId,
        token_expires_at: tokenExpiresAt,
        is_active: true,
        status: "ACTIVE",
      },
      { onConflict: "agency_id,platform,account_handle" }
    )
    .select(
      "id, agency_id, platform, account_handle, external_account_id, token_expires_at, status"
    )
    .single();

  if (upsertErr || !socialAccount) {
    const upsertFailResp = NextResponse.json(
      {
        ok: false,
        error: upsertErr?.message || "Sosial hesab qeydiyyatı saxlanıla bilmədi.",
      },
      { status: 500 }
    );
    clearStateCookie(upsertFailResp);
    return upsertFailResp;
  }

  const okResp = NextResponse.json({
    ok: true,
    platform: dbPlatform,
    account: socialAccount,
  });
  clearStateCookie(okResp);
  return okResp;
}
