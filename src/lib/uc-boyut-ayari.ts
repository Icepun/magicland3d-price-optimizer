"use client";

import { useSyncExternalStore } from "react";

/**
 * YAZICI KARTLARINDA CANLI 3B — aç/kapa (bu cihazda hatırlanır).
 *
 * Kartlardaki canlı 3B çizimler sürekli çalışıyor; ölçüldü (29 Eyl 2026): yazıcılar sayfası
 * açıkken arayüz + ekran kartı süreci işlemcinin ~%75'ini (bir çekirdek) kullanıyordu. Kullanıcı
 * işlemciye ihtiyaç duyduğu zamanlarda kapatmak istedi. Kapalıyken kart plaka görselini gösterir,
 * paket hiç indirilmez.
 */

const ANAHTAR = "mlhub-yazici-3b";
const OLAY = "mlhub-yazici-3b-degisti";

function oku(): boolean {
  try {
    return window.localStorage.getItem(ANAHTAR) !== "kapali";
  } catch {
    return true;
  }
}

function abone(bildir: () => void): () => void {
  const f = (e: Event) => {
    if (e instanceof StorageEvent && e.key !== ANAHTAR) return;
    bildir();
  };
  window.addEventListener(OLAY, f);
  window.addEventListener("storage", f);
  return () => {
    window.removeEventListener(OLAY, f);
    window.removeEventListener("storage", f);
  };
}

export function ucBoyutAyarla(acik: boolean): void {
  try {
    window.localStorage.setItem(ANAHTAR, acik ? "acik" : "kapali");
  } catch { /* depolama yoksa yalnız bu oturum */ }
  window.dispatchEvent(new Event(OLAY));
}

/** Kartlarda canlı 3B açık mı? Varsayılan AÇIK. */
export function useUcBoyutAcik(): boolean {
  return useSyncExternalStore(abone, oku, () => true);
}
