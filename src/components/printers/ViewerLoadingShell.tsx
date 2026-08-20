"use client";

import { Loader2 } from "lucide-react";

/**
 * 3B görünüm parçası inerken açılan kabuk — "ölü bekleme" olmasın.
 *
 * three.js parçası ölçülen 560 KB (izleyici zinciriyle 631 KB) ve ancak düğmeye basınca
 * inmeye başlıyor. Dört çağrı yerinden yalnız biri bu kabuğu veriyordu; kalan üçünde
 * `{ ssr: false }` dışında hiçbir şey yoktu, yani kullanıcı tıklıyor ve parça inene kadar
 * ekranda HİÇBİR ŞEY olmuyordu — iletişim kutusu bile açılmıyordu.
 *
 * Belirsiz çubuk bilerek: indirme ilerlemesini ölçemiyoruz, uydurma yüzde göstermek yerine
 * "çalışıyor" demek dürüst olanı.
 */
export function ViewerLoadingShell() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in duration-200">
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-8 py-7 shadow-xl">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm font-medium">3B görünüm hazırlanıyor…</p>
        <div className="relative h-1.5 w-44 overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 h-full w-1/3 rounded-full bg-primary"
            style={{ animation: "indeterminate-bar 1.4s ease-in-out infinite" }}
          />
        </div>
      </div>
    </div>
  );
}
