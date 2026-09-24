/**
 * YAZICI DURUMU — adlar, sıralama ve süre metinleri (renkler telefonda: mobile/src/lib/yazici-durum).
 *
 * NEDEN ÇEKİRDEKTE: bu mantık telefondaydı ve kökteki test onu doğrudan içe aktarıyordu. Modül
 * telefonun tema dosyasını, o da `react-native` tiplerini çekiyordu → kökteki `tsc` React
 * Native'in global `FormData` tanımını görüp masaüstü rotalarında 9 sahte hata veriyordu.
 * Saf kısım burada durur; `npm run sync-core` telefona kopyalar.
 *
 * ⚠️ PAYLAŞILIYOR — yalnız saf TS, node/react-native yok.
 */

/** Durum → kullanıcıya gösterilen ad. Anlam: yeşil = başarıyla bitti, marka rengi = basıyor. */
export const YAZICI_DURUM_ADI: Record<string, string> = {
  printing: "Yazdırıyor",
  paused: "Duraklatıldı",
  finished: "Tamamlandı",
  idle: "Hazır",
  error: "Hata",
  offline: "Çevrimdışı",
};

/** Bilinmeyen durum ve bağlantısızlık tek yerde çözülür. */
export function durumAnahtari(status: string, online: boolean | number = true): string {
  if (!online) return "offline";
  return status in YAZICI_DURUM_ADI ? status : "idle";
}

/** Listede sıra: en acil üstte — hata, duraklama, basan, biten, boştaki, bağlantısız. */
const SIRA: Record<string, number> = { error: 0, paused: 1, printing: 2, finished: 3, idle: 4, offline: 5 };

export function yazicilariSirala<T extends { status: string; online: boolean | number }>(liste: readonly T[]): T[] {
  const puan = (s: T) => SIRA[durumAnahtari(s.status, s.online)] ?? SIRA.idle;
  // Kararlı sıralama: aynı durumdakiler masaüstündeki (sortOrder) sırasını korur.
  return liste
    .map((s, i) => ({ s, i }))
    .sort((a, b) => puan(a.s) - puan(b.s) || a.i - b.i)
    .map((x) => x.s);
}

/** Süre metni: "2 sa 15 dk", "12 dk", "40 sn"; bilinmiyorsa null. */
export function kalanSure(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const sa = Math.floor(sec / 3600);
  const dk = Math.floor((sec % 3600) / 60);
  if (sa > 0) return `${sa} sa ${dk} dk`;
  if (dk > 0) return `${dk} dk`;
  return `${Math.max(1, Math.floor(sec))} sn`;
}

/** Bitiş saati ("16:42"); ertesi güne sarkıyorsa "yarın 03:10". Bilinmiyorsa null. */
export function bitisSaati(etaSec: number | null | undefined, simdi: number): string | null {
  if (etaSec == null || !Number.isFinite(etaSec) || etaSec <= 0) return null;
  const bitis = new Date(simdi + etaSec * 1000);
  const bugun = new Date(simdi);
  const saat = `${String(bitis.getHours()).padStart(2, "0")}:${String(bitis.getMinutes()).padStart(2, "0")}`;
  const gunFarki = Math.round(
    (new Date(bitis.getFullYear(), bitis.getMonth(), bitis.getDate()).getTime() -
      new Date(bugun.getFullYear(), bugun.getMonth(), bugun.getDate()).getTime()) /
      86_400_000,
  );
  if (gunFarki <= 0) return saat;
  if (gunFarki === 1) return `yarın ${saat}`;
  return `${bitis.getDate()}.${String(bitis.getMonth() + 1).padStart(2, "0")} ${saat}`;
}

/** Katman metni: "123 / 456"; toplam bilinmiyorsa "123". Bilgi yoksa null. */
export function katmanMetni(layer: number | null | undefined, total: number | null | undefined): string | null {
  if (layer == null || !Number.isFinite(layer) || layer <= 0) return null;
  const k = Math.round(layer);
  return total != null && total > 0 ? `${k} / ${Math.round(total)}` : String(k);
}
