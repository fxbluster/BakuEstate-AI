import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, isSupabaseConfigured } from "@/lib/supabase/env";

const PUBLIC_EXACT_PATHS = new Set(["/login", "/favicon.ico"]);
const PUBLIC_PREFIX_PATHS = [
  "/login/",
  "/_next/",
  "/api/social/webhooks/",
  "/api/social/oauth/",
];

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (
    PUBLIC_EXACT_PATHS.has(pathname) ||
    PUBLIC_PREFIX_PATHS.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }

  // Protected API routes pass through to enforce JSON 401/403 via requireOperator()
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", `${pathname}${search}`);
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.redirect(loginUrl, 307);
  }

  let response = NextResponse.next({ request });
  const { url, anonKey } = getSupabaseEnv();

  try {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options: CookieOptions;
          }>
        ) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return NextResponse.redirect(loginUrl, 307);
    }

    return response;
  } catch {
    return NextResponse.redirect(loginUrl, 307);
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and images
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
