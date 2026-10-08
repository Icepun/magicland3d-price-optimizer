"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * BU CİHAZDA HATIRLANAN SEÇİM — sıralama, süzgeç, görünüm yoğunluğu gibi kişisel tercihler.
 *
 * Örnek: Üretim'de sıralama ve "satmayanları gizle" her açılışta sıfırlanıyordu (hedef ve mod
 * veritabanında saklanırken). Bunlar cihaza özgü alışkanlık; localStorage yeter. Depolama yoksa
 * (gizli pencere vb.) seçim yalnız o oturumda yaşar, sayfa bozulmaz.
 */
const OLAY = "mlhub-kalici-secim";
/** localStorage açılamazsa seçim en azından bu oturumda yaşasın. */
const bellek = new Map<string, string>();

function oku<T extends string>(anahtar: string, varsayilan: T, gecerli: readonly T[]): T {
  let v: string | null | undefined;
  try {
    v = window.localStorage.getItem(anahtar);
  } catch {
    v = undefined;
  }
  v ??= bellek.get(anahtar);
  return v != null && (gecerli as readonly string[]).includes(v) ? (v as T) : varsayilan;
}

function abone(anahtar: string, bildir: () => void): () => void {
  const f = (e: Event) => {
    if (e instanceof StorageEvent && e.key !== anahtar) return;
    if (e instanceof CustomEvent && e.detail !== anahtar) return;
    bildir();
  };
  window.addEventListener(OLAY, f);
  window.addEventListener("storage", f);
  return () => {
    window.removeEventListener(OLAY, f);
    window.removeEventListener("storage", f);
  };
}

export function useKaliciSecim<T extends string>(
  anahtar: string,
  varsayilan: T,
  gecerli: readonly T[]
): [T, (yeni: T) => void] {
  const aboneOl = useCallback((bildir: () => void) => abone(anahtar, bildir), [anahtar]);
  const deger = useSyncExternalStore(
    aboneOl,
    () => oku(anahtar, varsayilan, gecerli),
    () => varsayilan
  );
  const ayarla = useCallback(
    (yeni: T) => {
      bellek.set(anahtar, yeni);
      try {
        window.localStorage.setItem(anahtar, yeni);
      } catch {
        /* depolama yoksa yalnız bu oturum */
      }
      window.dispatchEvent(new CustomEvent(OLAY, { detail: anahtar }));
    },
    [anahtar]
  );
  return [deger, ayarla];
}
