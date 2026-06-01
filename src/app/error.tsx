"use client";

/**
 * Route (segment) seviyesi hata sınırı.
 * Bir SAYFA render/hydration sırasında çökerse devreye girer; layout + Sidebar
 * yerinde kalır, kullanıcı başka sayfaya geçebilir. (global-error.tsx ise
 * layout'un kendisi çökerse tüm app yerine geçer.) Stabilite için ikisi de var.
 */
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Tanılama için konsola yaz — Electron ana süreci bunu startup.log'a aktarır.
    console.error("[route-error]", error?.message, error?.digest ?? "");
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-3 text-4xl">⚠️</div>
        <h1 className="mb-2 text-lg font-bold text-foreground">Bu sayfa açılırken bir sorun oluştu</h1>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          Yeniden deneyebilir veya soldaki menüden başka bir sayfaya geçebilirsin. Sorun sürerse
          aşağıdaki mesajı ilet.
        </p>
        <pre className="mb-4 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left text-xs text-destructive">
          {error?.message || "Bilinmeyen hata"}
          {error?.digest ? `\n(digest: ${error.digest})` : ""}
        </pre>
        <button
          onClick={() => reset()}
          className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          Yeniden dene
        </button>
      </div>
    </div>
  );
}
