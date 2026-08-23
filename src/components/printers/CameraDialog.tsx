"use client";

import { useEffect, useState } from "react";
import { Camera, Loader2, Maximize2, Minimize2, WifiOff, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * CANLI KAMERA PENCERESİ.
 *
 * Görüntü MJPEG olarak geliyor ve doğrudan `<img>` içinde oynuyor — video kod çözücü, ek
 * kütüphane ya da yeniden bağlanma döngüsü yok. Pencere kapanınca `<img>` DOM'dan çıkıyor,
 * tarayıcı bağlantıyı düşürüyor ve sunucu da yazıcıyla olan bağlantıyı bırakıyor.
 *
 * ⚠️ `key` ile zorla yeniden kurulum: aynı adrese ikinci kez `src` vermek Chromium'da bazen
 * eski (donmuş) akışı geri getiriyor. Her açılışta taze bir istek gitmeli.
 */
export function CameraDialog({
  printerId,
  printerName,
  onClose,
}: {
  printerId: string;
  printerName: string;
  onClose: () => void;
}) {
  const [durum, setDurum] = useState<"yukleniyor" | "canli" | "hata">("yukleniyor");
  const [buyuk, setBuyuk] = useState(false);
  // Her açılışta benzersiz adres — tarayıcı önbellekten donmuş kare göstermesin.
  const [anahtar] = useState(() => Date.now());

  // ESC ile kapatma dışında, büyütmeyi de klavyeden yapabilelim.
  useEffect(() => {
    const tus = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") setBuyuk((b) => !b);
    };
    window.addEventListener("keydown", tus);
    return () => window.removeEventListener("keydown", tus);
  }, []);

  return (
    <Dialog open onOpenChange={(a) => { if (!a) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-hidden border-0 bg-black p-0 transition-[max-width] duration-300",
          buyuk ? "max-w-[95vw]" : "max-w-2xl",
        )}
      >
        {/* Başlık şeridi görüntünün üstünde yüzüyor: kare mümkün olduğunca büyük kalsın. */}
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent px-4 py-3">
          <Camera className="h-4 w-4 text-white/80" />
          <span className="text-sm font-medium text-white">{printerName}</span>
          {durum === "canli" && (
            <span className="ml-1 flex items-center gap-1.5 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-300">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400 motion-safe:animate-pulse" />
              CANLI
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setBuyuk((b) => !b)}
              className="h-8 w-8 text-white/80 hover:bg-white/10 hover:text-white"
              title={buyuk ? "Küçült (F)" : "Büyüt (F)"}
            >
              {buyuk ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={onClose}
              className="h-8 w-8 text-white/80 hover:bg-white/10 hover:text-white"
              title="Kapat (Esc)"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className={cn("relative w-full bg-black transition-[aspect-ratio] duration-300", buyuk ? "aspect-video" : "aspect-[4/3]")}>
          {/* Görüntü gelene kadar ölü ekran yok. */}
          {durum === "yukleniyor" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <Loader2 className="h-7 w-7 animate-spin text-white/60" />
              <p className="text-sm text-white/60">Kamera açılıyor…</p>
            </div>
          )}

          {durum === "hata" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <WifiOff className="h-8 w-8 text-white/30" />
              <p className="text-sm font-medium text-white/80">Görüntü alınamadı</p>
              <p className="max-w-sm text-xs text-white/50">
                Yazıcının kamerası kapalı olabilir ya da başka bir uygulama kullanıyor olabilir.
              </p>
            </div>
          )}

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={anahtar}
            src={`/api/printers/${printerId}/camera?t=${anahtar}`}
            alt=""
            onLoad={() => setDurum("canli")}
            onError={() => setDurum("hata")}
            className={cn(
              "h-full w-full object-contain transition-opacity duration-500",
              durum === "canli" ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
