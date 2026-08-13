/**
 * ÜRETİM HEDEFİ — bir üründen kaç adet stokta tutulmalı? SAF kural, tek kaynak.
 *
 * NEDEN VAR: hedef herkese sabitti (5). Ayda bir satan ürüne de haftada on satana da aynı 5
 * hedefleniyordu. 13 Ağu 2026'da canlı veriyle ölçüldü:
 *
 *   sabit 5          → 129 ürün / 492 baskı / 69 kg filament / ~2400 saat
 *   30 günlük talep  →  51 ürün / 167 baskı / 24 kg filament
 *
 * Elde 34 kg filament ve 4 yazıcı var; sabit hedefli plan iki katı filament ve 25 GÜN
 * kesintisiz baskı istiyordu — yani hiç uygulanamaz bir liste. Üstelik plandaki 129 ürünün
 * 67'si ölçülebilen dönemde HİÇ satmamıştı.
 *
 * BURADA PARA HESABI YOKTUR. Yalnız adet ve gün. Maliyet/kâr alanlarına dokunulmaz.
 */

export type HedefModu = "sabit" | "talep";

/** Sabit modun ve talep modundaki tavanın varsayılanı. */
export const VARSAYILAN_HEDEF = 5;
/** Talep modunda kaç günlük satışı stokta tutalım. */
export const VARSAYILAN_KAPSAM_GUN = 30;
/** Arayüzdeki hazır seçenekler. */
export const KAPSAM_SECENEKLERI = [14, 30, 60] as const;

export interface HedefAyari {
  mod: HedefModu;
  /** Sabit modda hedefin kendisi; talep modunda ÜST SINIR ("en fazla bu kadar tut"). */
  tavan: number;
  /** Talep modunda kaç günlük satışı karşılayalım. */
  kapsamGun: number;
}

/** Ayar metni bozuksa sabit moda düş — plan boş kalmasın. */
export function parseHedefModu(raw: string | null | undefined): HedefModu {
  return String(raw ?? "").trim() === "talep" ? "talep" : "sabit";
}

export function parseKapsamGun(raw: string | null | undefined): number {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 1) return VARSAYILAN_KAPSAM_GUN;
  return Math.min(365, Math.floor(n));
}

export function parseTavan(raw: string | null | undefined, varsayilan = VARSAYILAN_HEDEF): number {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 1) return varsayilan;
  return Math.min(999, Math.floor(n));
}

/**
 * Günlük satış adedi.
 *
 * ⚠️ Bölen ÖLÇÜLEN gün olmalı, pencere değil: 21 günlük geçmişi 90'a bölersen her ürün
 * "neredeyse hiç satmıyor" çıkar ve talep hedefi tabana yapışır.
 */
export function gunlukSatis(satilanAdet: number, olculenGun: number): number {
  if (!Number.isFinite(satilanAdet) || satilanAdet <= 0) return 0;
  if (!Number.isFinite(olculenGun) || olculenGun <= 0) return 0;
  return satilanAdet / olculenGun;
}

/**
 * Bu ürün için hedef stok.
 *
 * Talep modunda SATMAYAN ÜRÜN 0 döner — yani plana hiç girmez. Kasıtlı: makine saati ve
 * filament sınırlıyken satmayanı basmak, satanı stoksuz bırakmak demek. Satan her ürün
 * en az 1 alır (aylık bir satan ürün bile stoksuz kalmasın), tavan da üst sınırı korur.
 */
export function hedefStok(ayar: HedefAyari, gunluk: number | null | undefined): number {
  const tavan = Math.max(1, Math.floor(ayar.tavan));
  if (ayar.mod === "sabit") return tavan;

  const hiz = Number(gunluk);
  if (!Number.isFinite(hiz) || hiz <= 0) return 0;
  const kapsam = Math.max(1, Math.floor(ayar.kapsamGun));
  return Math.min(tavan, Math.max(1, Math.ceil(hiz * kapsam)));
}

/** Kaç adet basılmalı — hedefin altındaki fark. Hedef 0 ise iş yok. */
export function basilacakAdet(hedef: number, stok: number): number {
  return Math.max(0, Math.floor(hedef) - Math.floor(stok));
}
