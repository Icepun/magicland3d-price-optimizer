/**
 * REKLAM PAYI — günlük reklam bütçesini ürün/sipariş maliyetine yediren hesap.
 *
 * SORUN: reklam bir DÖNEM gideridir (günde X TL), birim maliyet değil. Ürün başına düşen payı
 * bulmak bir DAĞITIM kararıdır.
 *
 * NEDEN CİROYA ORANTILI: "günlük tutarı o günün siparişlerine böl" ölçüldüğünde kullanılamaz
 * çıktı — 31 günlük gerçek veride en sakin gün 1 sipariş (sipariş başı 800 ₺), en yoğun gün
 * 15 sipariş (53 ₺): aynı ürün güne göre 15 KAT farklı pay taşıyordu. Ürünün kârı, o gün kaç
 * sipariş geldiğine bağlı olmamalı.
 *
 * "Adet başına sabit" de çarpıtır: 73 ₺'lik pay, 200 ₺'lik üründe %37, 2.000 ₺'lik üründe %3,7
 * yük demektir — ucuz ürünler haksız yere zarar eder görünür.
 *
 * Bu yüzden bütçe bir ORANA çevrilir (reklamın ciroya oranı — sektörde ACoS):
 *
 *     oran = (günlük bütçe × penceredeki gün sayısı) / penceredeki ciro
 *
 * ve her satır kendi cirosunun o kadarını taşır. Pahalı ürün çok, ucuz ürün az yüklenir;
 * gün içi dalgalanmadan etkilenmez.
 *
 * Oran PLATFORM BAŞINA hesaplanır: her platformun kendi bütçesi kendi cirosuna oranlanır
 * (kullanıcı kararı — Trendyol reklamı Shopify satışına yüklenmemeli).
 */

/** Oranın hesaplandığı pencere. Kısa pencere oynak, uzun pencere geç tepki verir. */
export const REKLAM_PENCERE_GUN = 30;

export interface ReklamOraniGirdi {
  /** Platformun günlük reklam bütçesi (TL). */
  gunlukTutar: number;
  /** Pencerede kaç gün var. */
  gunSayisi: number;
  /** Aynı platformun aynı penceredeki cirosu (TL, iptaller hariç). */
  pencereCirosu: number;
}

export interface ReklamOrani {
  /** Ciroya oran (0.1871 = %18,71). Ciro yoksa 0. */
  oran: number;
  /** Pencerede harcanan toplam reklam (TL). */
  toplamHarcama: number;
  /** Oran güvenilir mi — ciro yoksa ya da pencere çok kısaysa false. */
  guvenilir: boolean;
  /** true = reklam harcaması ciroyu aşıyor (oran > 1). Arayüz uyarmalı. */
  cirodanBuyuk: boolean;
}

/**
 * Bütçeyi ciroya oranlar.
 *
 * ⚠️ Ciro 0 ise oran 0 döner — sonsuz/NaN üretmez. "Bilinmeyen sıfır değildir" kuralı burada
 * ters işlemez: ciro gerçekten yoksa dağıtılacak bir taban da yoktur; `guvenilir: false` ile
 * çağırana durum bildirilir ve arayüz "oran hesaplanamadı" der.
 */
export function reklamOrani(girdi: ReklamOraniGirdi): ReklamOrani {
  const gun = Number.isFinite(girdi.gunSayisi) ? Math.max(0, girdi.gunSayisi) : 0;
  const tutar = Number.isFinite(girdi.gunlukTutar) ? Math.max(0, girdi.gunlukTutar) : 0;
  const ciro = Number.isFinite(girdi.pencereCirosu) ? Math.max(0, girdi.pencereCirosu) : 0;
  const toplamHarcama = tutar * gun;

  if (toplamHarcama <= 0 || ciro <= 0 || gun <= 0) {
    return { oran: 0, toplamHarcama, guvenilir: toplamHarcama <= 0, cirodanBuyuk: false };
  }
  const oran = toplamHarcama / ciro;
  return { oran, toplamHarcama, guvenilir: true, cirodanBuyuk: oran > 1 };
}

/**
 * Bir satırın/ürünün taşıyacağı reklam payı (TL, brüt).
 * `ciro` = o satırın satış tutarı (adet × birim fiyat) ya da ürün ekranında satış fiyatı.
 */
export function reklamPayi(ciro: number, oran: number): number {
  if (!Number.isFinite(ciro) || !Number.isFinite(oran)) return 0;
  if (ciro <= 0 || oran <= 0) return 0;
  return ciro * oran;
}

/**
 * Bir siparişin taşıyacağı ORAN — platformu ve KENDİ tarihi ile.
 *
 * Masaüstü ve mobil AYNI bu fonksiyonu çağırır; ayrı yazılsalardı aynı sipariş iki cihazda
 * farklı kâr gösterirdi (daha önce gerçek komisyonda yaşanan hata).
 *
 * ⚠️ ORAN DÖNEMİN KENDİSİNDEN GELİR. Önce "bugünkü oran × (dönem bütçesi / bugünkü bütçe)"
 * diye ölçekleniyordu; oran son 30 günün cirosundan türetildiği için pencere her gün kayıyor
 * ve GEÇMİŞ siparişlerin kârı da onunla kayıyordu (ölçüldü: aynı Ağustos siparişi, bugünkü
 * ciro seviyesine göre 120 ₺ ya da 300 ₺ pay — 2,5 kat). Artık her dönemin oranı KENDİ
 * dönemindeki ciroyla hesaplanıp bütçe kaydına yazılır; kapanmış dönem bir daha oynamaz.
 */
export function reklamOraniIcin(
  butceler: readonly DonemliButce[],
  platform: string,
  anMs: number
): number {
  const butce = gecerliButce(butceler, platform, anMs);
  if (!butce) return 0; // o tarihte o platformda reklam yoktu
  const oran = butce.oran;
  return Number.isFinite(oran) && oran != null && oran > 0 ? oran : 0;
}

/** Dönemin şu ana kadar kaç gün sürdüğü (en az 1) — oranın payını kurar. */
export function donemGunSayisi(
  validFrom: Date | string | number | null | undefined,
  validTo: Date | string | number | null | undefined,
  simdiMs: number
): number {
  const bas = msDeger(validFrom);
  if (bas == null) return 0; // tarihsiz dönem — gün sayısı bilinmez
  const bit = Math.min(msDeger(validTo) ?? simdiMs, simdiMs);
  const gun = (bit - bas) / (24 * 60 * 60_000);
  return gun > 0 ? Math.max(1, gun) : 0;
}

/** Bütçe kaydının en az alanı — dönem seçimi için. */
export interface DonemliButce {
  platform: string;
  dailyAmount: number;
  vatIncluded?: boolean;
  validFrom?: Date | string | number | null;
  validTo?: Date | string | number | null;
  isActive?: boolean;
  /** Bu DÖNEMİN kendi cirosundan hesaplanmış oranı — servis doldurur. */
  oran?: number;
}

function msDeger(deger: DonemliButce["validFrom"]): number | null {
  if (deger == null) return null;
  if (deger instanceof Date) return Number.isNaN(deger.getTime()) ? null : deger.getTime();
  if (typeof deger === "number") return Number.isFinite(deger) ? deger : null;
  const t = Date.parse(deger);
  return Number.isNaN(t) ? null : t;
}

/**
 * Verilen AN'da o platformda geçerli olan bütçe. Kargo kuralı seçimiyle AYNI mantık:
 * başlangıç dahil, bitiş dahil. Birden fazla eşleşirse en SON başlayan kazanır.
 *
 * ⚠️ Sipariş kârı bu fonksiyonu siparişin KENDİ tarihiyle çağırmalı; yoksa bütçe değiştiği an
 * geçmiş siparişlerin kârı da yeni bütçeye göre yeniden hesaplanır.
 */
export function gecerliButce(
  butceler: readonly DonemliButce[],
  platform: string,
  anMs: number
): DonemliButce | null {
  let secilen: DonemliButce | null = null;
  let secilenBas = -Infinity;
  for (const b of butceler) {
    if (b.isActive === false) continue;
    if (b.platform !== platform) continue;
    const bas = msDeger(b.validFrom);
    const bit = msDeger(b.validTo);
    if (bas != null && anMs < bas) continue;
    if (bit != null && anMs > bit) continue;
    const sira = bas ?? -Infinity;
    if (sira >= secilenBas) { secilen = b; secilenBas = sira; }
  }
  return secilen;
}
