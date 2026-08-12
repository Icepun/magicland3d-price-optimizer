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
 *   4) Bir istek düşünce ekranda ne yazar.
 *      "Ürünler yüklenemedi" tek başına sebebi saklıyordu; kullanıcı neyi düzelteceğini
 *      bilemeden yalnız sayfayı yenilemeyi deniyordu.
 *
 * ⚠️ Burada YENİ kâr hesabı YOKTUR. Grup özeti yalnız satırlarda zaten var olan değerleri
 * toplar/aralıklar. Bilinmeyen değer 0'a indirgenmez — "—" olarak kalır (BİLİNMEYEN ≠ SIFIR).
 */

export type PlatformKey = "shopify" | "trendyol" | "hepsiburada";

export const PLATFORM_KEYS: readonly PlatformKey[] = ["shopify", "trendyol", "hepsiburada"];

/** Platform adlarının ekranda yazılan hâli — tek kaynak (kısaltma/İngilizce yazım yok). */
export const PLATFORM_LABEL: Record<PlatformKey, string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

export function isPlatformKey(value: unknown): value is PlatformKey {
  return value === "shopify" || value === "trendyol" || value === "hepsiburada";
}

// ── 1) Liste önbelleği ────────────────────────────────────────────────────────────────────────

/**
 * Sunucuda karşılığı OLMAYAN görünümler: istemcide süzülür/sıralanır, sunucudan "active" listesi
 * istenir. Anahtar hesabı buna bağlıdır — üçü de AYNI isteği yaptığı için aynı gövdeyi paylaşır.
 */
export const CLIENT_ONLY_FILTERS: readonly string[] = ["most-profitable", "near-threshold"];

/** Bu görünüm sunucudan hangi listeyi ister? */
export function serverFilterOf(filterMode: string): string {
  return CLIENT_ONLY_FILTERS.includes(filterMode) ? "active" : filterMode;
}

/** Ürünler ekranının sorgu anahtarı. Diğer ekranlar 2 parçalı anahtar kullanır (["products","active"]). */
export function productListKey(filterMode: string, platform: string | null) {
  return ["products", filterMode, platform] as const;
}

/**
 * Listenin GERÇEKTEN kullandığı sorgu anahtarı.
 *
 * NEDEN AYRI: Ürünler `["products","active",null]`, Planlayıcı/Raporlar/Makaralar ise
 * `["products","active"]` diyordu. İkisi de `/api/products?filter=active` çekiyor — yani aynı
 * ~450 KB'lık gövde iki ayrı önbellek girdisine, iki ayrı indirmeyle giriyordu. Platform
 * daraltması yokken 2 parçalı anahtara düşerek tek gövdeyi paylaşırlar.
 *
 * "En Kârlı" / "Eşiğe Yakın" de aynı isteği yaptığı için aynı anahtara düşer → sekmeler arası
 * geçiş artık hiç indirme yapmaz.
 */
export function sharedProductListKey(filterMode: string, platform: string | null): unknown[] {
  const server = serverFilterOf(filterMode);
  return platform ? ["products", server, platform] : ["products", server];
}

/** İki sorgu anahtarı aynı gövdeyi mi gösteriyor? (sığ karşılaştırma) */
export function sameQueryKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/**
 * Bu anahtar, gizle/geri getir sonrası DÜŞÜRÜLMESİ gereken bir liste mi?
 *
 * Ekranda duran liste iyimser güncellendiği için ona dokunulmaz (yoksa 372 ürün baştan çekilir).
 * Geri kalan sekmelerin gövdesi artık yanlış → önbellekten silinir ki o sekmeye geçildiğinde
 * TAZE çekim yapılsın. Başka ekranların ürün sorguları (Raporlar, Planlayıcı, hızlı arama,
 * varyant seçici) 2 parçalı anahtar kullanır ve bilerek KORUNUR.
 *
 * ⚠️ Ekrandaki liste artık Planlayıcı/Raporlar ile aynı 2 parçalı anahtarı paylaşabiliyor
 * (`sharedProductListKey`). Bu fonksiyon o anahtara "düşer" der — çünkü tek başına baktığında
 * başka bir ekranın gövdesinden ayırt edemez. Çağrı yeri, ekranda duran anahtarı
 * `sameQueryKey` ile ayıklayıp korur; iyimser güncelleme o gövdeyi zaten düzeltmiştir.
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
  /** Sunucunun kararı: ÜRETİM maliyeti biliniyor mu? Ürün satırı da bunu kullanır. */
  hasCost: boolean;
  resolvedTotalCost: number | null;
  cost: { totalCost: number | null; manualCost: number | null } | null;
  profitPerHour: number | null;
  profitPerGram: number | null;
  /** Kâr/saat ve kâr/gram HANGİ platformun fiyatından geldi (yalnız kaynak bilgisi). */
  profitBasisPlatform?: string | null;
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

/**
 * Satırda gösterilen maliyet — ürün satırıyla AYNI kaynak sırası (yeni hesap yok).
 *
 * `hasCost` kapısı ŞART: paketleme her ürüne otomatik eklendiği için `resolvedTotalCost` maliyeti
 * girilmemiş varyantta bile dolu geliyor. Kapı olmadan grup satırı "₺8 – ₺240" gibi bir aralık
 * yazarken, açılan varyantın kendi satırı "—" diyordu — aynı ekranda iki farklı gerçek.
 */
export function memberCost(member: GroupMember): number | null {
  if (!member.hasCost) return null;
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
  /** Maliyeti girilmemiş varyant sayısı — özete girmezler, satırda ayrıca yazılır. */
  maliyetiEksik: number;
  karSaat: ValueRange | null;
  karGram: ValueRange | null;
  /**
   * Kâr/saat ve kâr/gram rakamlarının geldiği platform — yalnız tüm varyantlar AYNI platformdan
   * hesaplandıysa doludur. Karışıksa null kalır; uydurma tek bir kaynak yazmaktansa hiç yazma.
   */
  karKaynagi: PlatformKey | null;
  platformlar: Record<PlatformKey, GroupPlatformSummary | null>;
}

/**
 * Grup başlığı satırının özeti — SADECE kendisine verilen üyelerden hesaplanır.
 * Sayfa bu fonksiyona filtrelenmiş üyeleri verdiği için grup satırı her zaman ekranda
 * görünenle tutarlıdır (8 varyantlı grubun 5'i görünüyorsa satır o 5'i anlatır).
 */
export function summarizeGroup(members: readonly GroupMember[]): GroupSummary {
  const stokTutanUyeler = members.filter((member) => !member.madeToOrder);
  const maliyetler = members.map(memberCost);

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
    maliyet: toRange(maliyetler),
    maliyetiEksik: maliyetler.filter((tutar) => tutar == null).length,
    karSaat: toRange(members.map((m) => m.profitPerHour)),
    karGram: toRange(members.map((m) => m.profitPerGram)),
    karKaynagi: ortakKarKaynagi(members),
    platformlar,
  };
}

/**
 * Grubun kâr/saat · kâr/gram rakamları tek bir platformdan mı geliyor?
 *
 * Yalnız rakamı OLAN varyantlara bakılır: kârı hesaplanmamış bir varyantın kaynağı yoktur ve
 * rozeti "karışık" göstermemelidir. Kaynaklar ayrışıyorsa null → rozet yazılmaz.
 */
function ortakKarKaynagi(members: readonly GroupMember[]): PlatformKey | null {
  let ortak: PlatformKey | null = null;
  for (const member of members) {
    if (member.profitPerHour == null && member.profitPerGram == null) continue;
    const kaynak = isPlatformKey(member.profitBasisPlatform) ? member.profitBasisPlatform : null;
    if (kaynak == null) return null;
    if (ortak == null) ortak = kaynak;
    else if (ortak !== kaynak) return null;
  }
  return ortak;
}

export interface VariantCountLabel {
  /** Rozette yazan metin. */
  metin: string;
  /** Grubun bir kısmı listede yok mu? */
  kismi: boolean;
  /** Rozetin ipucu cümlesi. */
  ipucu: string;
}

/**
 * Grup rozetinin metni: "8 varyant" ya da bir kısmı süzülmüşse "5 / 8 varyant".
 *
 * Görünen sayı HER ZAMAN ekrandakidir; toplam yalnız "daha var" bilgisini verir. Toplam
 * bilinmiyorsa (eski önbellekten gelen yanıt) sessizce görünen sayıya düşer — uydurma
 * bir payda yazmaktansa bilgiyi hiç vermemek daha doğru.
 *
 * Toplam görünenden küçük gelirse (iyimser silme sonrası sunucu sayısı bir an geride kalır)
 * kırpılır: "9 / 8 varyant" gibi imkânsız bir rakam yazılmaz.
 */
export function variantCountLabel(gorunen: number, toplam?: number | null): VariantCountLabel {
  const tam =
    typeof toplam === "number" && Number.isFinite(toplam) ? Math.max(Math.trunc(toplam), gorunen) : null;
  const kismi = tam != null && tam > gorunen;
  return {
    metin: kismi ? `${gorunen} / ${tam} varyant` : `${gorunen} varyant`,
    kismi,
    ipucu: kismi
      ? `Bu grubun ${tam} varyantından ${gorunen} tanesi listede — rakamlar yalnız görünenleri anlatır`
      : `Listede görünen ${gorunen} varyant`,
  };
}

/** Ekranda tek satır sığan uzunluk; sunucu mesajı bundan uzunsa kırpılır. */
const MAX_ERROR_LENGTH = 140;

/**
 * Hata sebebini ekrana yazılabilir KISA bir cümleye indirir.
 *
 * Sebep gösterilmediğinde ("Ürünler yüklenemedi") kullanıcı ağ mı, veritabanı mı, yoksa
 * girdiği bir değer mi sorun anlayamıyor; rotalar okunur mesaj döndürdüğü hâlde o mesaj
 * hiçbir yere düşmüyordu. Ağ kopması teknik metin yerine sade cümleye çevrilir.
 */
export function listErrorText(error: unknown): string {
  const ham = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (!ham) return "Bağlantı kurulamadı.";
  if (/failed to fetch|networkerror|load failed|fetch failed|econnrefused/i.test(ham)) {
    return "Sunucuya ulaşılamadı.";
  }
  // Ham teknik metin son kullanıcıya GÖSTERİLMEZ. `jsonError` genel dalda Prisma/SQL/Node
  // mesajını olduğu gibi taşıyor; onu ekrana basmak ("no such column: Product.alias…") hem
  // anlaşılmaz hem de arayüz kuralına aykırı. Teknik iz konsolda kalsın.
  if (/prisma|invocation|sql|sqlite|econn|syntaxerror|typeerror|undefined is not/i.test(ham)) {
    console.error("[ürünler] liste hatası:", ham);
    return "Ürün listesi alınamadı.";
  }
  const kisa = ham.length > MAX_ERROR_LENGTH ? `${ham.slice(0, MAX_ERROR_LENGTH).trimEnd()}…` : ham;
  return /[.!?…]$/.test(kisa) ? kisa : `${kisa}.`;
}

// ── 6) Boş liste: neden boş olduğuna göre metin ──────────────────────────────────────────────

export interface EmptyListText {
  baslik: string;
  /** Tek satırlık, uygulanabilir öneri. Yoksa yazılmaz. */
  ipucu?: string;
}

/**
 * Liste boşken ne yazacağını belirler.
 *
 * Eskiden HER durumda "Ürün bulunamadı. CSV ile içe aktar veya manuel ekle." yazıyordu:
 * "kırmızı vazo" araması sonuç vermediğinde de, Zarar Eden sekmesi boşken de. İlki yanlış yol
 * gösteriyor, ikincisi ise aslında İYİ bir haberi hata gibi sunuyordu. Sıra önemli: önce arama,
 * sonra platform daraltması, sonra sekme.
 */
export function emptyListText(input: {
  filterMode: string;
  search: string;
  platformLabel?: string | null;
}): EmptyListText {
  const arama = input.search.trim();
  if (arama) {
    return {
      baslik: `“${arama}” için sonuç yok`,
      ipucu: "Ürün adı, barkod veya stok kodunun bir parçasını yazmayı dene.",
    };
  }
  if (input.platformLabel) {
    return {
      baslik: `Bu listede ${input.platformLabel} ürünü yok`,
      ipucu: `${input.platformLabel} daraltmasını kaldırınca tüm ürünler görünür.`,
    };
  }
  switch (input.filterMode) {
    case "inactive":
      return { baslik: "Satışa kapalı ürün yok" };
    case "hidden":
      return { baslik: "Gizlenen ürün yok", ipucu: "Gizlediğin ürünler burada birikir." };
    case "out-of-stock":
      return { baslik: "Stoğu biten ürün yok", ipucu: "Takip ettiğin ürünlerin hepsinde stok var." };
    case "negative-profit":
      return { baslik: "Zarar eden ürün yok", ipucu: "Bilinen maliyetlerle her ürün kâra geçiyor." };
    case "missing-cost":
      return { baslik: "Maliyeti eksik ürün yok", ipucu: "Tüm ürünlerin üretim maliyeti girilmiş." };
    case "missing-desi":
      return { baslik: "Desisi eksik ürün yok", ipucu: "Kargo hesabı tüm ürünlerde doğru çalışıyor." };
    case "near-threshold":
      return {
        baslik: "Küçük zamla kârı artacak ürün yok",
        ipucu: "Fiyatlar şu an bantların içinde kalıyor.",
      };
    default:
      return {
        baslik: "Henüz ürün yok",
        ipucu: "“Ürün Ekle” ile başla ya da pazaryerinden içeri aktar.",
      };
  }
}

// ── 7) Sekme rozetleri: kaç ürün var ─────────────────────────────────────────────────────────

export interface CountableProduct {
  stock: number;
  madeToOrder: boolean;
  hasCost: boolean;
  missingDesi: boolean;
  currentNetProfit: number | null;
  priceThreshold: unknown;
  platforms: ReadonlyArray<{ netProfit: number | null }>;
}

/** Aktif listeden sayılabilen sekmeler. Gizlenenler/İnaktif/Tümü başka listedir → burada YOK. */
export interface ListCounts {
  active: number;
  "out-of-stock": number;
  "negative-profit": number;
  "missing-cost": number;
  "missing-desi": number;
  "near-threshold": number;
}

/**
 * Sekme rozetlerinin sayıları — EKRANDAKİ aktif listeden hesaplanır, ek istek yapılmaz.
 *
 * Kurallar sunucudaki süzgeçlerle birebir aynı tutulur; farklı olsalardı rozet bir sayı yazıp
 * sekme başka bir sayı gösterirdi.
 */
export function countActiveList(products: readonly CountableProduct[]): ListCounts {
  const counts: ListCounts = {
    active: products.length,
    "out-of-stock": 0,
    "negative-profit": 0,
    "missing-cost": 0,
    "missing-desi": 0,
    "near-threshold": 0,
  };
  for (const product of products) {
    if (product.stock === 0 && !product.madeToOrder) counts["out-of-stock"] += 1;
    if (!product.hasCost) counts["missing-cost"] += 1;
    if (product.missingDesi) counts["missing-desi"] += 1;
    if (product.priceThreshold != null) counts["near-threshold"] += 1;
    const zarar =
      product.platforms.length > 0
        ? product.platforms.some((row) => row.netProfit !== null && row.netProfit < 0)
        : product.currentNetProfit !== null && product.currentNetProfit < 0;
    if (zarar) counts["negative-profit"] += 1;
  }
  return counts;
}
