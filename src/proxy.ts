import { NextResponse, type NextRequest } from "next/server";
import { yerelIstekMi } from "@/lib/yerel-istek";

/**
 * Uygulama içi API yalnız bu bilgisayardan ve uygulamanın kendi sayfalarından kullanılabilir.
 * Kural ve gerekçe: `@/lib/yerel-istek`.
 */
export function proxy(request: NextRequest) {
  const izin = yerelIstekMi({
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!izin) {
    return NextResponse.json({ error: "Bu istek bu bilgisayardan gelmiyor." }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
