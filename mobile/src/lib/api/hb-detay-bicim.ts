/**
 * HB DETAY ÖNBELLEĞİNİN DOSYA BİÇİMİ — saf (react-native/dosya sistemi yok), kökten test edilir.
 *
 * ⚠️ JSON-GÜVENLİ: `Map` diske yazılmaz (`{}` olur, geri yüklenince çöker — bkz. offline-cache
 * tuzağı); [anahtar, kayıt] dizisi yazılır, okurken her kayıt tek tek doğrulanır. Bozuk kayıt
 * atlanır, tanınmayan biçim tamamen yok sayılır.
 */

// ⚠️ Kökteki test bu dosyayı DOĞRUDAN içe aktarıyor: `@/` orada masaüstünün src'si demek ve
// react-native tipleri kök tsc'yi bozuyor (bkz. feedback: kök test RN tip tuzağı). Bu yüzden
// hiçbir içe aktarma yok; tipler burada tanımlı, `OrderItem` ile yapısal olarak uyumlu.

/** Diskteki kalem — `OrderItem` ile aynı alanlar (ürün kimliği/görsel HB detayında yok). */
export interface HbKalem {
  name: string;
  quantity: number;
  unitPrice: number;
  matchKeys: string[];
  barcodes?: string[];
  externalIds?: string[];
  skus?: string[];
  /** Siparişte kesilen komisyon oranı (kesir); HB bildirmediyse null. */
  commissionRate?: number | null;
  saleVatRate?: number | null;
  paymentFee?: number | null;
  stoppage?: number | null;
  dispatchDays?: number | null;
}

export interface HbDetayKaydi {
  lines: HbKalem[];
  customer: string | null;
  date: number | null;
}

/**
 * Biçim değişince artır — eski dosya okunmaz.
 * 2: kaleme `commissionRate` eklendi. Eski dosyadaki kalemlerde oran yok; okunsaydı o siparişlerin
 * kârı telefonda varsayılan oranla, masaüstünde siparişin kendi oranıyla hesaplanır ve iki cihaz
 * ayrışırdı. Dosya bir kez yeniden indirilir.
 * 3: birim fiyat artık satıcının geliri (HB indirimi dahil), oran KDV dahil; kaleme satış KDV'si,
 * tahsilat, stopaj ve kargoya verme süresi eklendi. Eski kayıtlar eski anlamı taşır → okunmaz.
 */
export const HB_DETAY_BICIMI = 3;

const metinDizisi = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function kalemMi(v: unknown): v is HbKalem {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.name === "string" &&
    typeof k.quantity === "number" &&
    Number.isFinite(k.quantity) &&
    typeof k.unitPrice === "number" &&
    Number.isFinite(k.unitPrice) &&
    metinDizisi(k.matchKeys) &&
    (k.barcodes === undefined || metinDizisi(k.barcodes)) &&
    (k.externalIds === undefined || metinDizisi(k.externalIds)) &&
    (k.skus === undefined || metinDizisi(k.skus)) &&
    [k.commissionRate, k.saleVatRate, k.paymentFee, k.stoppage, k.dispatchDays].every(
      (alan) => alan === undefined || alan === null || (typeof alan === "number" && Number.isFinite(alan))
    )
  );
}

/**
 * Dosya içeriğini `hedef`e ekle (bellekte zaten olan ezilmez). Biçim tanınmıyorsa `false` döner
 * (çağıran dosyayı siler); bozuk tek tek kayıtlar sessizce atlanır.
 */
export function hbDetayGovdesiniOku(json: string, hedef: Map<string, HbDetayKaydi>): boolean {
  const govde = JSON.parse(json) as { bicim?: unknown; kayitlar?: unknown };
  if (!govde || govde.bicim !== HB_DETAY_BICIMI || !Array.isArray(govde.kayitlar)) return false;
  for (const g of govde.kayitlar) {
    if (!Array.isArray(g) || typeof g[0] !== "string" || !g[0]) continue;
    const k = g[1] as Record<string, unknown> | null;
    if (!k || typeof k !== "object" || !Array.isArray(k.lines) || k.lines.length === 0) continue;
    if (!k.lines.every(kalemMi)) continue;
    if (hedef.has(g[0])) continue;
    hedef.set(g[0], {
      lines: k.lines,
      customer: typeof k.customer === "string" ? k.customer : null,
      date: typeof k.date === "number" && Number.isFinite(k.date) ? k.date : null,
    });
  }
  return true;
}

/** Diske yazılacak metin — en yeni `enCok` kayıt (Map ekleme sırası = eskiden yeniye). */
export function hbDetayGovdesiYaz(kaynak: Map<string, HbDetayKaydi>, enCok: number, simdi: number): string {
  const kayitlar = [...kaynak.entries()].slice(-Math.max(0, enCok));
  return JSON.stringify({ bicim: HB_DETAY_BICIMI, yazilma: simdi, kayitlar });
}
