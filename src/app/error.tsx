"use client";

/**
 * Route (segment) seviyesi hata sınırı.
 * Bir SAYFA render/hydration sırasında çökerse devreye girer; layout + Sidebar
 * yerinde kalır, kullanıcı başka sayfaya geçebilir. (global-error.tsx ise
 * layout'un kendisi çökerse tüm app yerine geçer.) Stabilite için ikisi de var.
 *
 * TASARIM NOTU: teknik ayrıntı artık VARSAYILAN OLARAK GİZLİ. Eskiden ham hata
 * mesajı ve Next'in iç "digest" kodu doğrudan ekrana basılıyordu; Simay için
 * anlamsız, üstelik ürkütücü. Ayrıntı tek tıkla kopyalanabiliyor — Berke'ye
 * göndermek için yeterli.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    // Tanılama için konsola yaz — Electron ana süreci bunu startup.log'a aktarır.
    console.error("[route-error]", error?.message, error?.digest ?? "");
  }, [error]);

  const detail = [error?.message || "Bilinmeyen hata", error?.digest ? `#${error.digest}` : ""]
    .filter(Boolean)
    .join(" ");

  async function copyDetail() {
    try {
      await navigator.clipboard.writeText(detail);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Pano erişimi yoksa ayrıntıyı görünür yap ki elle seçilebilsin.
      setShowDetail(true);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-500 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/12">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
        </div>
        <h1 className="mb-2 text-lg font-bold text-foreground">
          Bu sayfa açılamadı
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
          Yeniden deneyebilir ya da soldaki menüden başka bir sayfaya geçebilirsin.
        </p>

        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => reset()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98]"
          >
            <RotateCcw className="h-4 w-4" />
            Yeniden dene
          </button>
          <button
            onClick={copyDetail}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition-all hover:bg-muted/60 hover:text-foreground active:scale-[0.98]"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-emerald-500" />
                Kopyalandı
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Ayrıntıyı kopyala
              </>
            )}
          </button>
        </div>

        {showDetail && (
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
            {detail}
          </pre>
        )}
      </div>
    </div>
  );
}
