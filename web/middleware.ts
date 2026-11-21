import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Direct frictionless operator access: if user visits /login, redirect straight to /
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl);
  }

  // All other pages (/, /listings, /leads, /jobs) are directly accessible
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and images
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
