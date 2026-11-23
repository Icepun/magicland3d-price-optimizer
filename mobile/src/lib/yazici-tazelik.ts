import { parseDbDate } from "@core/sqlite-date";

/**
 * Masaüstü aktarıcısı satırı en geç 30 sn'de bir tazeler; bundan eski satır "Canlı değil" sayılır
 * (masaüstü kapalı / uyuyor). Atölye, Yazıcılar ve yazıcı ekranı AYNI eşiği ve AYNI tarih okuyucuyu
 * kullanır — bir tur Atölye satırın yaşına hiç bakmıyordu ve 1,5 saat önceki "%45 basıyor"u
 * "az önce" diye gösteriyordu (denetim, 23 Kas 2026).
 */
export const YAZICI_BAYAT_MS = 90_000;

/** Satırın yaşı (ms); tarihi okunamazsa null. */
export function satirYasiMs(updatedAt: string | null | undefined, simdi: number): number | null {
  const t = parseDbDate(updatedAt)?.getTime();
  return t == null || !Number.isFinite(t) ? null : Math.max(0, simdi - t);
}

export function satirBayatMi(updatedAt: string | null | undefined, simdi: number): boolean {
  const yas = satirYasiMs(updatedAt, simdi);
  return yas != null && yas > YAZICI_BAYAT_MS;
}
