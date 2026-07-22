"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsMutating } from "@tanstack/react-query";
import { useBusyState } from "@/lib/busy";
import { useIsClient } from "@/lib/client-state";

/** active true olduktan `showDelay` ms sonra göster; gösterildiyse en az `minVisible` ms tut
 *  (hızlı/optimistic işlemler katmanı YANIP SÖNDÜRMEZ, gösterilince de titremez). */
function useDelayedFlag(active: boolean, showDelay: number, minVisible: number) {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    if (active && !shown) {
      t = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, showDelay);
    } else if (!active && shown) {
      t = setTimeout(() => setShown(false), Math.max(0, minVisible - (Date.now() - shownAt.current)));
    }
    return () => clearTimeout(t);
  }, [active, shown, showDelay, minVisible]);
  return shown;
}

/**
 * Global yazma/işlem katmanı: uzun/bloklayan bir işlem sırasında ekranı kibarca karartır,
 * animasyonlu loading gösterir, ETKİLEŞİMİ BLOKLAR (kullanıcı işlem biterken başka yere gidemez).
 * OPT-IN: SADECE `meta:{blocking:true}` işaretli mutation'larda (toplu sil/gizle, varyantlara uygula
 * gibi gerçekten bekleten, yerel geri-bildirimi olmayan işlemler) + elle `runBlocking(...)` çıkar.
 * Eskiden "onMutate'i olmayan her mutation" tetikliyordu → küçük yazmalarda olur olmadık yerde
 * yanıp sönüyordu. Artık her butonun kendi "Kaydediliyor…" durumu var; katman yalnız büyük işlemlerde.
 */
export function GlobalBusyOverlay() {
  const blocking = useIsMutating({
    predicate: (m) => {
      const o = m.options as { meta?: { blocking?: boolean } };
      return Boolean(o.meta?.blocking); // yalnızca açıkça blocking işaretliler
    },
  });
  const { busy, label } = useBusyState();
  const shown = useDelayedFlag(blocking > 0 || busy, 220, 480);

  const mounted = useIsClient();
  if (!mounted || !shown) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/55 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      aria-busy="true"
      aria-live="polite"
      role="status"
    >
      <div className="flex flex-col items-center gap-4 motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200">
        <div className="relative h-16 w-16 text-primary">
          {/* Dönen konik halka (comet-tail) + parlama */}
          <div
            className="absolute inset-0 rounded-full motion-safe:animate-spin"
            style={{
              background: "conic-gradient(from 90deg, transparent 18deg, currentColor)",
              WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))",
              mask: "radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))",
              filter: "drop-shadow(0 0 7px currentColor)",
              animationDuration: "0.85s",
            }}
          />
          {/* Hafif sabit iz halkası */}
          <div className="absolute inset-0 rounded-full border-[3px] border-primary/12" />
          {/* Nabız atan merkez */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-2 w-2 rounded-full bg-primary motion-safe:animate-pulse" />
          </div>
        </div>
        <p className="text-sm font-medium text-foreground/80">{label ?? "İşleniyor…"}</p>
      </div>
    </div>,
    document.body,
  );
}
