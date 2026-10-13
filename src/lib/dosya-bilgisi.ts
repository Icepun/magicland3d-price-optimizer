"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { bilgiEksik, type OlculenDosya } from "@/lib/model-dosya-gorunum";

/** Dosyadan okunan bilgi — `POST /api/models/<id>/gramaj` yanıtı. */
export interface DosyaBilgisi {
  gramaj: number | null;
  estPrintMin: number | null;
  hasThumbnail?: boolean;
}

/**
 * Oturum boyunca dosya başına TEK okuma denemesi — bütün ekranlar için ortak. İçinde süre/gramaj
 * yazmayan bir dosya her liste açılışında yeniden okunmasın (her deneme buluttan birkaç yüz KB çeker).
 */
const okumasiDenenenler = new Set<string>();

/**
 * Eski dosyaların eksik bilgisini (süre, gramaj, önizleme) dosyadan okuyup çağırana bildirir.
 *
 * Yeni yüklenenlerde bu bilgi yüklemeyle birlikte gelir; burası yalnız geçmişi doldurur. Sırayla,
 * teker teker çalışır — ekran hiçbir zaman bunu beklemez. Sonucu NEREYE yazacağına çağıran karar
 * verir (`onBilgi`): her ekranın kendi önbelleği var.
 *
 * Dönen küme "şu an okunuyor / sırada" olan dosyaları taşır — satır o süre boyunca yer tutucu çizsin.
 */
export function useEksikBilgiyiTamamla<T extends OlculenDosya & { id: string }>(
  parcalar: readonly T[],
  etkin: boolean,
  onBilgi: (id: string, bilgi: DosyaBilgisi) => void,
): ReadonlySet<string> {
  // Her denemeden sonra artar → sıra yeniden hesaplanır (deneme kümesi tepkisel değil).
  const [tur, setTur] = useState(0);
  const sonCagri = useRef(onBilgi);
  useEffect(() => {
    sonCagri.current = onBilgi;
  }, [onBilgi]);

  const sira = useMemo(
    () => parcalar.filter((f) => bilgiEksik(f) && !okumasiDenenenler.has(f.id)).map((f) => f.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tur` bilinçli tetikleyici
    [parcalar, tur],
  );
  const siradaki = sira[0] ?? null;

  useEffect(() => {
    if (!etkin || !siradaki || okumasiDenenenler.has(siradaki)) return;
    const id = siradaki;
    okumasiDenenenler.add(id);
    void (async () => {
      try {
        const r = await fetchJson<DosyaBilgisi>(`/api/models/${id}/gramaj`, { method: "POST" });
        // Sonuç, ekran bu arada kapanmış olsa da bildirilir (geçerli veri; çağıran önbelleğe yazar).
        sonCagri.current(id, r);
      } catch {
        /* Bilgi yalnız gösterim içindir: okunamazsa satır eksik bilgiyle kalır, ekran çalışır. */
      }
      // Sıra ancak şimdi yeniden hesaplanır → okunan satır o ana dek "okunuyor" görünür.
      setTur((t) => t + 1);
    })();
  }, [etkin, siradaki]);

  return useMemo(() => new Set(etkin ? sira : []), [etkin, sira]);
}

/** Okunan bilgiyi bir satıra işle — eldeki değer korunur, yalnız eksik olan dolar. */
export function bilgiyiIsle<T extends OlculenDosya>(satir: T, b: DosyaBilgisi): T {
  return {
    ...satir,
    gramaj: b.gramaj ?? satir.gramaj,
    estPrintMin: b.estPrintMin ?? satir.estPrintMin ?? null,
    hasThumbnail: !!b.hasThumbnail || !!satir.hasThumbnail,
  };
}
