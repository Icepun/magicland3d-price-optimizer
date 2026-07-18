"use client";

/**
 * Liste ekranı durumu (arama / filtre / kaydırma) — sayfadan çıkıp dönünce KALDIĞIN YERDEN devam.
 *
 * Sorun: ürün detayına girip geri dönünce Ürünler sayfası sıfırdan açılıyordu; arama kutusu
 * boşalıyor, kaydırma başa dönüyordu. Aynı ürünün başka varyantına bakmak için her seferinde
 * adı yeniden yazmak gerekiyordu.
 *
 * Oturum-içi (sessionStorage): uygulama kapanınca temizlenir, cihaza kalıcı yazmaz.
 */
export interface ListState {
  search?: string;
  filterMode?: string;
  scrollTop?: number;
}

const KEY = (name: string) => `mh-list-state:${name}`;

export function loadListState(name: string): ListState {
  try {
    const raw = sessionStorage.getItem(KEY(name));
    return raw ? (JSON.parse(raw) as ListState) : {};
  } catch {
    return {};
  }
}

export function saveListState(name: string, patch: ListState): void {
  try {
    const cur = loadListState(name);
    sessionStorage.setItem(KEY(name), JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* kota/gizli mod → durum korunmaz, işlevsellik bozulmaz */
  }
}

/** Uygulamanın kaydırma kabı (layout'taki <main>). Yoksa null. */
export function scrollContainer(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector("main");
}
