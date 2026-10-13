"use client";

import { useEffect } from "react";

/**
 * Bir bırakma kutusunun DIŞINA düşen dosyayı yut.
 *
 * Pencere, üzerine bırakılan dosyayı açmaya çalışır: uygulamanın ekranı kaybolur ve dosyanın
 * kendisi görünür. Sürükle-bırak sunan her ekran bu kancayı çağırmalı. Kutular kendi bırakmasını
 * zaten karşılıyor (olay onlara önce ulaşır); burada yalnız sahipsiz kalan bırakma engellenir.
 */
export function useDisariBirakmayiYut(): void {
  useEffect(() => {
    const yut = (e: DragEvent) => {
      if (e.defaultPrevented) return; // bir kutu sahiplendi
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", yut);
    window.addEventListener("drop", yut);
    return () => {
      window.removeEventListener("dragover", yut);
      window.removeEventListener("drop", yut);
    };
  }, []);
}
