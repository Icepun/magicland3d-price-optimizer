import { bildirimTuruBul, kapaliListesi, type BildirimTuru } from "@/core/bildirim-turleri";

/**
 * TELEFONUN KENDİ BİLDİRİM TERCİHİ — saf (yalnız çekirdeğe bağlı), kökten test edilir.
 *
 * Tercih veritabanında bu telefonun push kaydında (`PushToken.kapali`) durur; masaüstü
 * Ayarlar'dan da değiştirilebilir. Kapatılan tür telefona push olarak gelmez (gönderen masaüstü
 * süzer) ve telefondaki bildirim listesinde de görünmez.
 */

export interface PushSatiri {
  token?: unknown;
  cihazId?: unknown;
  kapali?: unknown;
  updatedAt?: unknown;
}

/**
 * Bu telefonun kaydı. Önce güncel token (kayıt bitmişse kesin eşleşme), yoksa kalıcı cihaz
 * kimliği — uygulama açılırken token henüz alınmamış olabilir.
 */
export function kendiKaydim(
  satirlar: readonly PushSatiri[],
  token: string | null,
  cihazId: string | null
): PushSatiri | null {
  if (token) {
    const t = satirlar.find((s) => s.token === token);
    if (t) return t;
  }
  if (cihazId) {
    const adaylar = satirlar.filter((s) => s.cihazId === cihazId);
    if (adaylar.length > 0) {
      return [...adaylar].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    }
  }
  return null;
}

/** Kaydın kapattığı türler (kolon yoksa — masaüstü eski sürümse — hepsi açık). */
export function kapaliTurler(satir: PushSatiri | null): BildirimTuru[] {
  return typeof satir?.kapali === "string" ? kapaliListesi(satir.kapali) : [];
}

/** Bildirim bu telefonda kapatılmış bir türe mi ait? Türü bilinmeyen her zaman görünür. */
export function telefondaKapali(
  b: { id: string; type?: string | null },
  kapali: readonly BildirimTuru[]
): boolean {
  if (kapali.length === 0) return false;
  const tur = bildirimTuruBul(b);
  return tur !== null && kapali.includes(tur);
}
