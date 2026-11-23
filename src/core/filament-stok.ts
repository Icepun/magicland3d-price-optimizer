/**
 * Filament stok görünümünün saf mantığı — masaüstü Filament sayfası, Panel ve telefon Filament
 * ekranı AYNI kodu kullanır (çekirdekte, `npm run sync-core` ile telefona gider). Eskiden telefon
 * makara başına gram kuralıyla çalışıyor, masaüstüyle farklı "bitti/azaldı" diyordu (23 Kas 2026).
 *
 * SAYFANIN TEK İŞİ (Berke'nin sözleriyle): "amacım açık olmayan, stoğumdaki filamentleri
 * görmek ve onlar bitmeye yaklaşınca sipariş vermem gerektiğini görmek." Açık makaralar
 * yazıcılarda; burada sayılmazlar. Tüketim kaydı, makara maliyeti ve "aç" işlemi kaldırıldı.
 */
import {
  FILAMENT_COLORS, esikBul, filamentAyarlariniCoz, groupSpools, parseGroupKey, titleFromKey,
  type FilamentAyarlari, type FilamentGroup, type SpoolLike, type WatchedGroup,
} from "./filament-groups";

/**
 * Kullanıcının en çok kullandığı renkler — stok sıfır olsa bile GÖRÜNÜR.
 *
 * AİLEYE değil, RENK ANAHTARINA bakılır. Aile eşleşmesi çok geniş: "Mermer" ve "Fildişi"
 * açık tonlu oldukları için `beyaz` ailesine düşüyor ve üst bölüme sızıyorlardı. Daha
 * sinsi ikinci etkisi: elinde Mermer varken aile "dolu" sayılıp GERÇEK beyaz çipi
 * gizleniyordu — yani beyazı bittiğinde haber alamayacaktın.
 */
export const TEMEL_RENKLER = ["siyah", "gri", "beyaz"] as const;

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
  /** Tür (PLA, PETG…). */
  material?: string;
  /** Aynı renkten birden çok tür varsa çipte tür de yazılır (yoksa iki çip ayırt edilemez). */
  turuGoster?: boolean;
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
  return (TEMEL_RENKLER as readonly string[]).includes(c.colorKey);
}

/** En kritik önce: bitenler, sonra azalanlar, sonra sayıya göre artan. */
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
 * Rengin göz tarafından algılanan açıklığı (0 = siyah, 1 = beyaz).
 *
 * Ham RGB ortalaması YETMEZ: göz yeşili kırmızıdan çok daha parlak görür, ortalamayla
 * sıralarsan sarı ile mavi yan yana düşer ve "açıktan koyuya" hissi bozulur. Bu yüzden
 * sRGB doğrusallaştırması + göz duyarlılık ağırlıkları kullanılıyor.
 */
export function acikligi(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return 0.5; // bilinmeyen renk ortada dursun, listeyi uçlara savurmasın
  const n = parseInt(m[1], 16);
  const kanal = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = kanal((n >> 16) & 255);
  const g = kanal((n >> 8) & 255);
  const b = kanal(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ekran sırası: AÇIKTAN KOYUYA. Göz bir gradyanı takip ettiği için renk aramak kolaylaşır. */
function tonSirali(cipler: RenkCip[]): RenkCip[] {
  return [...cipler].sort(
    (a, b) =>
      acikligi(b.colorHex) - acikligi(a.colorHex) ||
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
      material: g.material,
    };
  });

  // Temel renklerden hiç kaydı olmayanları "0" olarak ekle.
  // Karşılaştırma RENK ANAHTARIYLA: aileyle bakılırsa elindeki "Mermer" beyaz ailesini dolu
  // gösterip gerçek beyazın bittiğini gizler.
  const varOlanRenkAnahtarlari = new Set(cipler.map((c) => c.colorKey));
  for (const renk of temelRenkler) {
    if (varOlanRenkAnahtarlari.has(renk.key)) continue;
    varOlanRenkAnahtarlari.add(renk.key);
    // Anahtar GERÇEK grup anahtarıdır ("PLA__siyah"): susturma ve izleme kayıtları onunla eşleşir.
    const key = `${varsayilanMalzeme}__${renk.key}`;
    cipler.push({
      key,
      colorName: renk.name,
      label: `${renk.name} ${varsayilanMalzeme}`,
      colorHex: renk.hex,
      colorKey: renk.key,
      colorFamily: renk.family,
      sealed: 0,
      esik: esikOf({ key }) || varsayilanEsik,
      durum: "biten",
      group: null,
      material: varsayilanMalzeme,
    });
  }

  // İZLENEN ama stoğu tükenmiş renkler de "0" olarak kalır — zil "Kırmızı PLA bitti" derken
  // sayfada o rengin izi olmaması, kullanıcıyı listesinde bulamadığı bir renkle alışverişe
  // yollar. Temel renkler zaten yukarıda eklendi; burada tekrar edilmez.
  // Karşılaştırma GRUP ANAHTARIYLA: renge bakılsaydı elde Siyah PETG varken biten ve izlenen
  // Siyah PLA hiç görünmezdi — zil "Siyah PLA bitti" derken sayfa susardı (denetim, 23 Kas 2026).
  const varOlanAnahtarlar = new Set(cipler.map((c) => c.key));
  for (const izlenen of izlenenler) {
    if (!izlenen?.key || varOlanAnahtarlar.has(izlenen.key)) continue;
    varOlanAnahtarlar.add(izlenen.key);
    const { material, colorKey } = parseGroupKey(izlenen.key);
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
      material: material || varsayilanMalzeme,
    });
  }
  const renkSayisi = new Map<string, number>();
  for (const c of cipler) renkSayisi.set(c.colorKey, (renkSayisi.get(c.colorKey) ?? 0) + 1);
  for (const c of cipler) if ((renkSayisi.get(c.colorKey) ?? 0) > 1) c.turuGoster = true;
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
 * Bölümlere ayır: TEMEL renkler üstte, gerisi altta. Her bölüm AÇIKTAN KOYUYA sıralı.
 *
 * Sıralama kritikliğe göre DEĞİL: "neyim bitiyor" sorusunu zaten üst şeritteki sayaçlar,
 * Biten/Azalan filtreleri ve çipin kendi rengi cevaplıyor. Izgaranın işi bir rengi hızlı
 * bulmak, o da sabit ve tahmin edilebilir bir sırayla olur — kritiklik sırası her stok
 * değişiminde çipleri yerinden oynatıyordu.
 */
export function bolumlere(cipler: RenkCip[]): RenkBolumu[] {
  const temel = tonSirali(cipler.filter((c) => temelMi(c)));
  const diger = tonSirali(cipler.filter((c) => !temelMi(c)));

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

/**
 * Tek çağrıda stok durumu: makaralar + AppSetting → gruplar, çipler, özet. Masaüstü sayfası ve
 * telefon Filament ekranı bunu kullanır; iki ekran aynı rengi aynı sözcükle anlatır.
 */
export function filamentStokDurumu(
  spools: SpoolLike[],
  ayarlarHam: Record<string, string | null | undefined> | null | undefined
): { ayar: FilamentAyarlari; groups: FilamentGroup[]; cipler: RenkCip[]; ozet: ReturnType<typeof stokOzeti> } {
  const ayar = filamentAyarlariniCoz(ayarlarHam);
  const groups = groupSpools(spools);
  const cipler = renkCipleri(
    groups,
    (g) => esikBul(g.key, ayar),
    esikBul("", ayar),
    // Tam olarak Siyah / Gri / Beyaz — aileyle seçilseydi Mermer/Fildişi gibi tonlar da sızardı.
    FILAMENT_COLORS.filter((c) => (TEMEL_RENKLER as readonly string[]).includes(c.key)),
    ayar.watchedGroups
  );
  return { ayar, groups, cipler, ozet: stokOzeti(cipler) };
}
