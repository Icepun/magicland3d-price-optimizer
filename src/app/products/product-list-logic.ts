/**
 * Ürünler listesinin SAF (React'sız) karar mantığı.
 *
 * NEDEN AYRI DOSYA: aşağıdaki üç karar yanlış olduğunda kullanıcı ya veriyi kaybediyor ya da
 * yanlış rakama bakıyor. Sayfa bileşeninin içinde kaldıkları sürece test edilemiyorlardı
 * (Next sayfa dosyası varsayılan dışında dışa aktarım yapamaz).
 *
 *   1) Gizle / geri getir sonrası HANGİ liste önbelleği düşer.
 *      Liste kendiliğinden tazelenmiyor (staleTime: Infinity + refetchOnMount: false) →
 *      "bayat işaretlemek" hiçbir şey yapmıyordu: gizlenen ürün Gizlenenler sekmesine hiç
 *      girmiyor, geri getirilen ürün Aktif'e dönmüyordu (ürün İKİ listede birden kayboluyordu).
 *
 *   2) Toplu işlem GERÇEKTEN hangi ürünlere dokunur.
 *      Seçim eski görünümden kalırsa "12 Seçileni Sil" ekranda görünmeyen 12 ürünü siler.
 *
 *   3) Varyant grubu satırı ne yazar.
 *      372 aktif ürünün 240'ı 60 grup başlığı altında; grup satırlarında maliyet/kâr/platform
 *      sütunlarının hepsi "—" idi → listenin çoğunda tek bir kâr rakamı bile görünmüyordu.
 *
 * ⚠️ Burada YENİ kâr hesabı YOKTUR. Grup özeti yalnız satırlarda zaten var olan değerleri
 * toplar/aralıklar. Bilinmeyen değer 0'a indirgenmez — "—" olarak kalır (BİLİNMEYEN ≠ SIFIR).
 */

export type PlatformKey = "shopify" | "trendyol" | "hepsiburada";

export const PLATFORM_KEYS: readonly PlatformKey[] = ["shopify", "trendyol", "hepsiburada"];

// ── 1) Liste önbelleği ────────────────────────────────────────────────────────────────────────

/** Ürünler ekranının sorgu anahtarı. Diğer ekranlar 2 parçalı anahtar kullanır (["products","active"]). */
export function productListKey(filterMode: string, platform: string | null) {
  return ["products", filterMode, platform] as const;
}

/**
 * Bu anahtar, gizle/geri getir sonrası DÜŞÜRÜLMESİ gereken bir liste mi?
 *
 * Ekranda duran liste iyimser güncellendiği için ona dokunulmaz (yoksa 372 ürün baştan çekilir).
 * Geri kalan sekmelerin gövdesi artık yanlış → önbellekten silinir ki o sekmeye geçildiğinde
 * TAZE çekim yapılsın. Başka ekranların ürün sorguları (Raporlar, Planlayıcı, hızlı arama,
 * varyant seçici) 2 parçalı anahtar kullanır ve bilerek KORUNUR.
 */
export function isStaleProductListKey(
  key: readonly unknown[],
  filterMode: string,
  platform: string | null
): boolean {
  if (key[0] !== "products") return false;
  // Ekrandaki liste dışındaki TÜM ürün önbellekleri düşer — yalnız 3 parçalı liste anahtarları
  // değil. Ctrl+K hızlı araması (["products","hizli-arama"]) ve varyant seçici
  // (["products","variant-picker"]) de aynı satırı taşıyor; gizle/geri-al sonrası orada
  // güncellenmezse ürün Ürünler'de görünürken aramada kaybolmuş kalıyordu
  // (QueryProvider `refetchOnMount:false` + uzun `staleTime` yüzünden kendi kendine düzelmez).
  if (key.length !== 3) return true;
  return !(key[1] === filterMode && key[2] === platform);
}

// ── 2) Toplu işlem kapsamı ───────────────────────────────────────────────────────────────────

/**
 * Toplu işlemin gerçekten dokunacağı ürünler: SADECE o an listede görünenler.
 * Filtre/arama değişince seçim zaten temizlenir; bu kesişim ikinci emniyet kemeridir.
 */
export function visibleSelection<T extends { id: string }>(
  visible: readonly T[],
  selected: ReadonlySet<string>
): T[] {
  return visible.filter((item) => selected.has(item.id));
}

/** Onay metni için kısa ürün adı listesi: ilk `limit` ad + "ve N ürün daha". */
export function selectionPreview(
  names: readonly string[],
  limit = 8
): { shown: string[]; rest: number } {
  return { shown: names.slice(0, limit), rest: Math.max(0, names.length - limit) };
}

// ── 3) Varyant grubu özeti ───────────────────────────────────────────────────────────────────

export interface GroupMemberPlatform {
  platform: PlatformKey;
  salePrice: number;
  netProfit: number | null;
  profitMargin: number | null;
  commissionMissing: boolean;
  cargoMissing?: boolean;
}

export interface GroupMember {
  id: string;
  stock: number;
  madeToOrder: boolean;
  currentSalePrice: number;
  resolvedTotalCost: number | null;
  cost: { totalCost: number | null; manualCost: number | null } | null;
  profitPerHour: number | null;
  profitPerGram: number | null;
  platforms: GroupMemberPlatform[];
}

/** Bir sütunun grup genelindeki aralığı. `bilinmeyen > 0` → bazı varyantlarda değer YOK. */
export interface ValueRange {
  min: number;
  max: number;
  bilinen: number;
  bilinmeyen: number;
}

/**
 * Değer listesini aralığa çevirir. Hiç bilinen değer yoksa `null` döner → ekranda "—".
 * null/undefined/NaN 0 SAYILMAZ; sayılsaydı "maliyeti yok" olan varyant kârı sıfıra çekerdi.
 */
export function toRange(values: ReadonlyArray<number | null | undefined>): ValueRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let bilinen = 0;
  let bilinmeyen = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      bilinen += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    } else {
      bilinmeyen += 1;
    }
  }
  return bilinen === 0 ? null : { min, max, bilinen, bilinmeyen };
}

/** Satırda gösterilen maliyet — ürün satırıyla AYNI kaynak sırası (yeni hesap yok). */
export function memberCost(member: GroupMember): number | null {
  return member.resolvedTotalCost ?? member.cost?.totalCost ?? member.cost?.manualCost ?? null;
}

export interface GroupPlatformSummary {
  /** Bu platformda ilanı olan varyant sayısı. */
  ilanli: number;
  fiyat: ValueRange | null;
  kar: ValueRange | null;
  marj: ValueRange | null;
  komisyonEksik: number;
  kargoEksik: number;
}

export interface GroupSummary {
  /** O an LİSTEDE GÖRÜNEN varyant sayısı (filtre/arama sonrası). */
  varyant: number;
  stokTutan: number;
  siparisUzerine: number;
  /** Stok tutan varyantların toplamı; hiç stok tutan yoksa null → "Sipariş üzerine". */
  stokToplam: number | null;
  fiyat: ValueRange | null;
  maliyet: ValueRange | null;
  karSaat: ValueRange | null;
  karGram: ValueRange | null;
  platformlar: Record<PlatformKey, GroupPlatformSummary | null>;
}

/**
 * Grup başlığı satırının özeti — SADECE kendisine verilen üyelerden hesaplanır.
 * Sayfa bu fonksiyona filtrelenmiş üyeleri verdiği için grup satırı her zaman ekranda
 * görünenle tutarlıdır (8 varyantlı grubun 5'i görünüyorsa satır o 5'i anlatır).
 */
export function summarizeGroup(members: readonly GroupMember[]): GroupSummary {
  const stokTutanUyeler = members.filter((member) => !member.madeToOrder);

  const platformlar = {} as Record<PlatformKey, GroupPlatformSummary | null>;
  for (const key of PLATFORM_KEYS) {
    const ilanlar = members
      .map((member) => member.platforms.find((row) => row.platform === key))
      .filter((row): row is GroupMemberPlatform => row != null);
    platformlar[key] =
      ilanlar.length === 0
        ? null
        : {
            ilanli: ilanlar.length,
            fiyat: toRange(ilanlar.map((row) => row.salePrice)),
            kar: toRange(ilanlar.map((row) => row.netProfit)),
            marj: toRange(ilanlar.map((row) => row.profitMargin)),
            komisyonEksik: ilanlar.filter((row) => row.commissionMissing).length,
            kargoEksik: ilanlar.filter((row) => row.cargoMissing).length,
          };
  }

  return {
    varyant: members.length,
    stokTutan: stokTutanUyeler.length,
    siparisUzerine: members.length - stokTutanUyeler.length,
    // Sipariş üzerine üretilen varyant stok TUTMAZ; toplama katılırsa grup "Σ 0" yazıp
    // stok bitmiş gibi görünüyordu.
    stokToplam: stokTutanUyeler.length
      ? stokTutanUyeler.reduce((toplam, member) => toplam + member.stock, 0)
      : null,
    fiyat: toRange(members.map((m) => (m.currentSalePrice > 0 ? m.currentSalePrice : null))),
    maliyet: toRange(members.map(memberCost)),
    karSaat: toRange(members.map((m) => m.profitPerHour)),
    karGram: toRange(members.map((m) => m.profitPerGram)),
    platformlar,
  };
}
