import { NextResponse, type NextRequest } from "next/server";

export function proxy({ nextUrl }: NextRequest) {
  const origin = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
  return NextResponse.rewrite(`${origin}${nextUrl.pathname}${nextUrl.search}`);
}

export const config = { matcher: "/api/:path*" };
