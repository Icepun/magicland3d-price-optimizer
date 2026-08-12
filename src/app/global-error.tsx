"use client";

/**
 * Kök hata sınırı — layout dahil HER ŞEY çökerse devreye girer.
 * Boş ekran yerine kullanıcıya anlaşılır bir hata + "Yeniden dene" gösterir.
 *
 * NEDEN SATIR İÇİ STİL: bu bileşen kök layout'un YERİNE geçer, kendi <html>'ini
 * render eder — uygulamanın tema değişkenleri ve sınıfları burada yok.
 *
 * RENKLER KOŞULSUZ KOYU: uygulamanın tek teması koyu (açık tema kaldırıldı) ve Electron
 * penceresinin arka planı da koyu. Eskiden burada sistem tercihi (@media
 * prefers-color-scheme) okunuyordu; artık okunsaydı, işletim sistemi açık temadayken
 * koyu bir uygulamanın ortasında bembeyaz bir hata ekranı çıkardı.
 *
 * Ayrıca ham hata mesajı ve Next'in iç "digest" kodu artık ekranda DEĞİL —
 * son kullanıcı için anlamsız. Tek tıkla kopyalanabiliyor.
 */
import { useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const detail = [error?.message || "Bilinmeyen hata", error?.digest ? `#${error.digest}` : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <html lang="tr">
      <body>
        <style
          dangerouslySetInnerHTML={{
            __html: `
:root { color-scheme: dark; --g-bg:#0f0d15; --g-fg:#eae7f1; --g-muted:#948da6;
        --g-line:#282334; --g-accent:#9b81ff; --g-accent-fg:#12101a; --g-warn:#e0a94a;
        --g-warn-bg:rgba(224,169,74,.14); --g-surface:#17141e; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
       background:var(--g-bg); color:var(--g-fg);
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
.g-card { max-width:360px; padding:32px; text-align:center;
          animation:g-in .45s cubic-bezier(.2,.7,.3,1) both; }
@keyframes g-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
.g-icon { width:48px; height:48px; margin:0 auto 16px; border-radius:16px; display:flex;
          align-items:center; justify-content:center; background:var(--g-warn-bg);
          color:var(--g-warn); font-size:24px; }
.g-title { font-size:19px; font-weight:700; margin:0 0 8px; letter-spacing:-.02em; }
.g-text { color:var(--g-muted); font-size:14px; margin:0 0 20px; line-height:1.55; }
.g-row { display:flex; gap:8px; justify-content:center; }
.g-btn { font:inherit; font-size:14px; font-weight:600; border-radius:10px; padding:10px 20px;
         cursor:pointer; border:1px solid transparent; transition:transform .12s ease, opacity .15s ease,
         background .15s ease; }
.g-btn:active { transform:scale(.98); }
.g-primary { background:var(--g-accent); color:var(--g-accent-fg); }
.g-primary:hover { opacity:.9; }
.g-ghost { background:transparent; color:var(--g-muted); border-color:var(--g-line); }
.g-ghost:hover { background:var(--g-surface); color:var(--g-fg); }
@media (prefers-reduced-motion: reduce) {
  .g-card { animation-duration:1ms; }
  .g-btn { transition-duration:1ms; }
}
`,
          }}
        />
        <div className="g-card">
          <div className="g-icon" aria-hidden="true">
            !
          </div>
          <h1 className="g-title">Uygulama beklenmedik bir sorunla karşılaştı</h1>
          <p className="g-text">
            Yeniden başlatmayı dene. Sorun sürerse ayrıntıyı kopyalayıp Berke&apos;ye gönder.
          </p>
          <div className="g-row">
            <button className="g-btn g-primary" onClick={() => reset()}>
              Yeniden dene
            </button>
            <button
              className="g-btn g-ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(detail);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* pano yoksa sessiz geç — kullanıcıya yapacak bir şey kalmıyor */
                }
              }}
            >
              {copied ? "Kopyalandı" : "Ayrıntıyı kopyala"}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
