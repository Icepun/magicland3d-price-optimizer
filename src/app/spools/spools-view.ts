/**
 * Filament sayfasının saf görünüm mantığı — React'siz test edilebilsin diye ayrı.
 *
 * SAYFANIN TEK İŞİ (Berke'nin sözleriyle): "amacım açık olmayan, stoğumdaki filamentleri
 * görmek ve onlar bitmeye yaklaşınca sipariş vermem gerektiğini görmek." Açık makaralar
 * yazıcılarda; burada sayılmazlar. Tüketim kaydı, makara maliyeti ve "aç" işlemi kaldırıldı.
 */
import {
  FILAMENT_COLORS, parseGroupKey, titleFromKey,
  type FilamentGroup, type WatchedGroup,
} from "@/core/filament-groups";

/** Kullanıcının en çok kullandığı renkler — stok sıfır olsa bile GÖRÜNÜR. */
export const TEMEL_AILELER = ["siyah", "gri", "beyaz"] as const;

export type StokFiltre = "hepsi" | "azalan" | "biten";

export interface RenkCip {
  key: string;
  colorName: string;
  /** Sipariş listesinde kullanılan tam ad: "Koyu Yeşil PLA". */
  label: string;
  colorHex: string;
  colorKey: string;
  colorFamily: string;
  /** Stoktaki KAPALI makara sayısı. */
  sealed: number;
  /** Bu renk için geçerli eşik. */
  esik: number;
  durum: "biten" | "azalan" | "yeterli";
  /** Kaydı olan grup; renk hiç alınmamışsa null (temel renklerde olur). */
  group: FilamentGroup | null;
}

export interface RenkBolumu {
  baslik: string;
  aciklama?: string;
  cipler: RenkCip[];
}

function durumOf(sealed: number, esik: number): RenkCip["durum"] {
  if (sealed <= 0) return "biten";
  return sealed <= esik ? "azalan" : "yeterli";
}

function temelMi(c: RenkCip): boolean {
  return (TEMEL_AILELER as readonly string[]).includes(c.colorFamily);
}

/** En kritik önce: bitenler, sonra azalanlar, sonra sayıya göre artan. Tek sıralama kuralı. */
function sirali(cipler: RenkCip[]): RenkCip[] {
  const oncelik = { biten: 0, azalan: 1, yeterli: 2 } as const;
  return [...cipler].sort(
    (a, b) =>
      oncelik[a.durum] - oncelik[b.durum] ||
      a.sealed - b.sealed ||
      a.colorName.localeCompare(b.colorName, "tr-TR")
  );
}

/**
 * Grupları çiplere çevir ve TEMEL renkleri stok yokken bile ekle.
 *
 * ⚠️ ASIL SORUN BUYDU: bir renk bitince kaydı silindiği için sayfadan TAMAMEN kayboluyordu.
 * Siyah/gri/beyaz en çok kullanılanlar, yani en sık sıfıra düşenler — tam da görülmesi
 * gerekenler görünmez oluyordu. Ölçüldü (13 Ağu): 34 makara / 19 renk içinde siyah ve gri
 * HİÇ YOK; sayfa bunu hiçbir şekilde söyleyemiyordu.
 */
export function renkCipleri(
  groups: FilamentGroup[],
  esikOf: (g: { key: string }) => number,
  varsayilanEsik: number,
  temelRenkler: Array<{ key: string; name: string; hex: string; family: string }>,
  izlenenler: WatchedGroup[] = [],
  varsayilanMalzeme = "PLA"
): RenkCip[] {
  const cipler: RenkCip[] = groups.map((g) => {
    const esik = esikOf(g);
    return {
      key: g.key,
      colorName: g.colorName,
      label: g.label,
      colorHex: g.colorHex,
      colorKey: g.colorKey,
      colorFamily: g.colorFamily,
      sealed: g.sealedCount,
      esik,
      durum: durumOf(g.sealedCount, esik),
      group: g,
    };
  });

  // Temel ailelerden hiç kaydı olmayanları "0" olarak ekle.
  const varOlanAileler = new Set(cipler.map((c) => c.colorFamily));
  for (const renk of temelRenkler) {
    if (varOlanAileler.has(renk.family)) continue;
    // Aynı aileden ikinci bir ton gelirse tekrar eklenmesin ("Gri", "Koyu Gri", "Gümüş" hepsi
    // "gri" ailesindendir; stok yokken üç ayrı boş çip çizilirdi).
    varOlanAileler.add(renk.family);
    cipler.push({
      key: `yok:${renk.key}`,
      colorName: renk.name,
      label: `${renk.name} ${varsayilanMalzeme}`,
      colorHex: renk.hex,
      colorKey: renk.key,
      colorFamily: renk.family,
      sealed: 0,
      esik: varsayilanEsik,
      durum: "biten",
      group: null,
    });
  }

  // İZLENEN ama stoğu tükenmiş renkler de "0" olarak kalır — zil "Kırmızı PLA bitti" derken
  // sayfada o rengin izi olmaması, kullanıcıyı listesinde bulamadığı bir renkle alışverişe
  // yollar. Temel renkler zaten yukarıda eklendi; burada tekrar edilmez.
  const varOlanAnahtarlar = new Set(cipler.map((c) => c.key));
  const varOlanRenkler = new Set(cipler.map((c) => c.colorKey));
  for (const izlenen of izlenenler) {
    if (!izlenen?.key || varOlanAnahtarlar.has(izlenen.key)) continue;
    const { material, colorKey } = parseGroupKey(izlenen.key);
    if (varOlanRenkler.has(colorKey)) continue;
    const bilinen = FILAMENT_COLORS.find((c) => c.key === colorKey);
    const ad = bilinen?.name ?? titleFromKey(colorKey);
    cipler.push({
      key: izlenen.key,
      colorName: ad,
      label: (izlenen.label ?? "").trim() || `${ad} ${material || varsayilanMalzeme}`.trim(),
      colorHex: bilinen?.hex ?? "#6b7280",
      colorKey,
      colorFamily: bilinen?.family ?? "diger",
      sealed: 0,
      esik: esikOf({ key: izlenen.key }),
      durum: "biten",
      group: null,
    });
  }
  return cipler;
}

/** Filtre — "sadece bitenleri gör" artık eşiği bozmadan yapılabiliyor. */
export function filtrele(cipler: RenkCip[], filtre: StokFiltre, arama: string): RenkCip[] {
  const q = arama.trim().toLocaleLowerCase("tr-TR");
  return cipler.filter((c) => {
    if (q && !c.colorName.toLocaleLowerCase("tr-TR").includes(q)) return false;
    if (filtre === "biten") return c.durum === "biten";
    if (filtre === "azalan") return c.durum === "biten" || c.durum === "azalan";
    return true;
  });
}

/**
 * Bölümlere ayır: TEMEL renkler üstte, gerisi altta. Her bölümde en kritik önce
 * (önce bitenler, sonra azalanlar, sonra sayıya göre artan).
 */
export function bolumlere(cipler: RenkCip[]): RenkBolumu[] {
  const temel = sirali(cipler.filter((c) => temelMi(c)));
  const diger = sirali(cipler.filter((c) => !temelMi(c)));

  const bolumler: RenkBolumu[] = [];
  if (temel.length) {
    bolumler.push({
      baslik: "Temel renkler",
      aciklama: "en çok kullandıkların",
      cipler: temel,
    });
  }
  if (diger.length) bolumler.push({ baslik: "Diğer renkler", cipler: diger });
  return bolumler;
}

/**
 * Sipariş listesi metni — ekranda GÖRÜNEN çiplerden üretilir.
 *
 * ⚠️ Eskiden `buildFilamentAlerts` çıktısından üretiliyordu ve bu, yeni tasarımda sessiz bir
 * boşluk açardı: uyarı üretmek için grubun canlı bir kaydı gerekir, oysa stoğu sıfırlanan
 * renklerin kaydı kalmaz. Yani listeye tam da sipariş edilmesi gereken renkler GİRMEZDİ —
 * siyah ve gri gibi. Ekranda "stokta yok" yazan her renk listede de olmalı.
 */
export function alisverisListesi(cipler: RenkCip[], susturulan: Iterable<string> = []): string {
  const muted = new Set(susturulan);
  return sirali(cipler.filter((c) => c.durum !== "yeterli" && !muted.has(c.key)))
    // Eşiğin BİR ÜSTÜNE çıkacak kadar al: eşiğe eşit almak ertesi gün yine "azaldı" demektir.
    .map((c) => `${c.label} ×${Math.max(1, c.esik - c.sealed + 1)}`)
    .join(", ");
}

/**
 * Üst şeritteki özet.
 *
 * Biten ve azalan AYRI sayılır. Tek bir "sorunlu" sayısı ikisini harmanlar ve yanıltır:
 * eşik 1'ken tek makarası kalan on renk azalan olur, gerçekten biten üç renk o yığının
 * içinde kaybolur. Acil olan bitendir; azalan yalnız not düşer.
 */
export function stokOzeti(cipler: RenkCip[]): {
  toplam: number;
  renk: number;
  biten: number;
  azalan: number;
  sorunlu: number;
} {
  const biten = cipler.filter((c) => c.durum === "biten").length;
  const azalan = cipler.filter((c) => c.durum === "azalan").length;
  return {
    toplam: cipler.reduce((n, c) => n + c.sealed, 0),
    // Hiç alınmamış temel renk "sahip olunan renk" sayılmaz.
    renk: cipler.filter((c) => c.group != null).length,
    biten,
    azalan,
    sorunlu: biten + azalan,
  };
}
