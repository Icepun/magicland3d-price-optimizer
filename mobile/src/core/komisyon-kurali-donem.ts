/**
 * KOMİSYON KURALI DÖNEMLERİ — kargo tarifeleri gibi (Berke'nin onayı, 23 Kas 2026).
 *
 * Eskiden kural yerinde düzenleniyor ya da siliniyordu: "Yeniden hesapla" geçmiş ayları BUGÜNKÜ
 * kuralla yeniden yazıyor, Siparişler'deki satır kârları da anında değişiyordu.
 *
 * KESİM = BU AYIN 1'i (Türkiye takvimi). Berke'nin kargo kararıyla aynı: "tüm kasıma etki etsin,
 * öncesine değil". Böylece:
 *   • Bu aydan önce başlamış kuralın hesabı (oran, bant, kategori, öncelik, pazaryeri) değişince
 *     eski kural ayın 1'inden hemen önce kapanır, yeni hâli ayın 1'inden başlar. Geçmiş aylar
 *     eski kuralla kalır.
 *   • Bu ay içinde eklenmiş kural yerinde düzenlenir / gerçekten silinir (geçmiş ayda izi yok —
 *     yanlış eklenip hemen silinen kural ayın başından bugüne uygulanmış olarak kalmaz).
 *   • Silme ve "kapat" bu aydan önce başlamış kuralı silmez, ayın 1'inden itibaren kapatır.
 *
 * Masaüstü uçları ve telefon AYNI planı uygular (çekirdek → telefona `sync-core`).
 */
import { ayBasi } from "./siparis-listesi";

export interface KomisyonKuraliKaydi {
  id: string;
  name: string;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number;
  fixedCommission: number;
  priority: number;
  isActive: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  platform: string | null;
}

export type KomisyonKuraliDegisikligi = Partial<
  Pick<
    KomisyonKuraliKaydi,
    "name" | "categoryName" | "minPrice" | "maxPrice" | "commissionRate" | "fixedCommission" | "priority" | "platform"
  >
>;

/** Değişince geçmişi etkileyen alanlar (ad etkilemez). */
const HESAP_ALANLARI = [
  "categoryName",
  "minPrice",
  "maxPrice",
  "commissionRate",
  "fixedCommission",
  "priority",
  "platform",
] as const;

const ms = (d: Date | null | undefined): number | null => {
  if (!d) return null;
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
};

/** Değişikliğin geçerli olduğu an: bu ayın 1'i (Türkiye takvimi). */
export function komisyonKesimi(an: Date): Date {
  return new Date(ayBasi(an.getTime()));
}

/** Kural `an`da yürürlükte mi (listede "geçerli" bölümünde gösterilir). */
export function kuralYururlukte(r: Pick<KomisyonKuraliKaydi, "isActive" | "validFrom" | "validTo">, an: Date): boolean {
  if (!r.isActive) return false;
  const t = an.getTime();
  const bas = ms(r.validFrom);
  const bit = ms(r.validTo);
  return (bas == null || bas <= t) && (bit == null || bit >= t);
}

/** Kural kesimden ÖNCE başlamış mı (yani geçmiş aylardaki siparişlere uygulanmış olabilir mi)? */
function kesimdenOnceBasladi(r: Pick<KomisyonKuraliKaydi, "validFrom">, kesim: Date): boolean {
  const bas = ms(r.validFrom);
  return bas == null || bas < kesim.getTime();
}

function ayni(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-12;
  return (a ?? null) === (b ?? null);
}

export type KomisyonGuncellemePlani =
  | { tur: "yerinde"; veri: KomisyonKuraliDegisikligi }
  | { tur: "donem"; kapat: { id: string; validTo: Date }; yeni: Omit<KomisyonKuraliKaydi, "id"> };

export function komisyonKuraliGuncellemePlani(
  eski: KomisyonKuraliKaydi,
  degisiklik: KomisyonKuraliDegisikligi,
  an: Date
): KomisyonGuncellemePlani {
  const kesim = komisyonKesimi(an);
  const hesapDegisti = HESAP_ALANLARI.some(
    (k) => degisiklik[k] !== undefined && !ayni(degisiklik[k], eski[k])
  );
  if (!hesapDegisti || !kesimdenOnceBasladi(eski, kesim) || !kuralYururlukte(eski, an)) {
    return { tur: "yerinde", veri: degisiklik };
  }
  const bitis = ms(eski.validTo);
  const { id: _id, ...kalan } = eski;
  void _id;
  return {
    tur: "donem",
    // Kesimden 1 ms önce: eşleşme iki ucu da kapsar, her an tek kurala düşer (tarife sınırıyla aynı).
    kapat: { id: eski.id, validTo: new Date(kesim.getTime() - 1) },
    yeni: {
      ...kalan,
      ...degisiklik,
      validFrom: kesim,
      validTo: bitis != null && bitis > an.getTime() ? eski.validTo : null,
      isActive: true,
    },
  };
}

export type KomisyonSilmePlani = { tur: "sil" } | { tur: "kapat"; validTo: Date };

/**
 * Silme / "kapat": bu aydan önce başlamış kural ayın 1'inden itibaren kapanır (geçmiş aylar onu
 * kullanmaya devam eder); bu ay eklenmiş kural gerçekten silinir. `tamamen` = kullanıcı
 * geçmişten de kaldırmayı açıkça seçti.
 */
export function komisyonKuraliSilmePlani(
  eski: Pick<KomisyonKuraliKaydi, "validFrom" | "validTo" | "isActive">,
  an: Date,
  tamamen = false
): KomisyonSilmePlani {
  const kesim = komisyonKesimi(an);
  if (tamamen || !kesimdenOnceBasladi(eski, kesim)) return { tur: "sil" };
  const bitis = ms(eski.validTo);
  // Zaten kesimden önce kapanmış kural: dokunma (kapanış tarihi korunur).
  if (bitis != null && bitis < kesim.getTime()) return { tur: "kapat", validTo: eski.validTo as Date };
  return { tur: "kapat", validTo: new Date(kesim.getTime() - 1) };
}

/** Kapanmış kuralı yeniden açmak: bu ayın 1'inden başlayan kopya (önceki boşluk boş kalır). */
export function komisyonKuraliYenidenAcmaPlani(
  eski: KomisyonKuraliKaydi,
  an: Date
): Omit<KomisyonKuraliKaydi, "id"> {
  const { id: _id, ...kalan } = eski;
  void _id;
  return { ...kalan, validFrom: komisyonKesimi(an), validTo: null, isActive: true };
}
