"use client";

/**
 * Hazırlık listesinin MASAÜSTÜNE ÖZGÜ kısmı (tarayıcı deposu).
 *
 * Gruplama mantığı ORTAK ÇEKİRDEĞE taşındı (`src/core/prep-list.ts`) çünkü telefon da aynı
 * listeyi üretiyor; iki kopya olsaydı adetler cihazlar arasında sessizce ayrışırdı.
 */
export {
  PREP_STATUSES,
  buildPrepItems,
  type PrepStatusKind,
  type PrepSourceItem,
  type PrepSourceOrder,
  type PrepItem,
} from "@/core/prep-list";

/**
 * İşaretler artık VERİTABANINDA (`PrepDone`, şema v46) — telefonla ORTAK.
 *
 * ⚠️ Eskiden `sessionStorage`taydı: masaüstünde işaretlenen ürün telefonda işaretsiz
 * görünüyor, sekme kapanınca da kayboluyordu. Kullanıcı paketlemeye masada başlayıp
 * atölyede telefonda bitirdiği için bu tek cihazlık depo yanlış listeye yol açıyordu.
 *
 * Ağ hatasında liste ÇALIŞMAYA DEVAM EDER (işaretsiz): paketleme durmasın.
 */
export const PREP_DONE_KEY = "mh-list-state:orders-hazirlik";

/**
 * Kayıtlı işaretler. `null` = OKUNAMADI (boş liste değil): çağıran elindekini ezmemeli —
 * eskiden hata boş liste dönüyordu ve yüklenirken atılan işaretler siliniyordu (denetim, 23 Kas 2026).
 */
export async function loadPrepDone(): Promise<string[] | null> {
  try {
    const res = await fetch("/api/prep-done", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { keys?: unknown };
    return Array.isArray(data.keys)
      ? data.keys.filter((key): key is string => typeof key === "string")
      : null;
  } catch {
    return null;
  }
}

/**
 * Tek satırın işaretini değiştir. Ekran beklemez (iyimser); dönen değer kaydın tuttuğunu söyler —
 * tutmadıysa çağıran işareti geri alır. Eskiden yanıta bakılmıyordu: kayıt düşse de kutu dolu
 * kalıyor, telefonda işaretsiz görünüyordu.
 */
export async function savePrepDone(key: string, done: boolean): Promise<boolean> {
  try {
    const res = await fetch("/api/prep-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, done }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearPrepDone(): Promise<boolean> {
  try {
    const res = await fetch("/api/prep-done", { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}
