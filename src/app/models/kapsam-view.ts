/**
 * MODEL KÜTÜPHANESİ — KAPSAMA TABLOSUNUN SAF MANTIĞI (React yok, ağ yok).
 *
 * Sayfanın tek sorusu: "hangi modelin dosyası var, hangisinin yok?" Cevap bir tablodur:
 * satır = model (varyantları tek satırda), sütun = yazıcı AİLESİ (iki Snapmaker U1 tek sütun —
 * aynı dosyayı basarlar), hücre = var / kısmen / yok.
 *
 * Eski sayfa bu soruyu cevaplayamıyordu: yalnız dosyası OLAN ürünleri listeliyor, her yazıcıya
 * ayrı bölme açıyor ve kart başına üç satır yer harcıyordu.
 */
import { adParcala } from "@/lib/urun-adi";
import { dedupeFiles, familyDisplayName, fileContentKey, printerFamilyKey, type AileUyesi } from "@/core/printers/printer-family";
import { foldTr, searchProduct, shortPrinter } from "./models-view";

export interface KapsamYazicisi extends AileUyesi {
  name: string;
}

export interface KapsamAilesi {
  /** Aile anahtarı — süzgeç ve React anahtarı. */
  anahtar: string;
  /** Tam ad: "Snapmaker U1". */
  ad: string;
  /** Tablo sütununda kısa ad: "U1". */
  kisaAd: string;
  /** Ailedeki yazıcılar. İLKİ temsilcidir: yeni dosya ona yüklenir, hepsi basar. */
  yazicilar: { id: string; name: string }[];
}

/** Yazıcıları ailelere topla — sıra ilk görülen yazıcıya göre korunur. */
export function kapsamAileleri(printers: readonly KapsamYazicisi[]): KapsamAilesi[] {
  const gruplar = new Map<string, KapsamYazicisi[]>();
  for (const p of printers) {
    const k = printerFamilyKey(p);
    gruplar.set(k, [...(gruplar.get(k) ?? []), p]);
  }
  const aileler = [...gruplar.entries()].map(([anahtar, uyeler]) => {
    const ad = uyeler.length > 1 ? familyDisplayName(uyeler[0]) : familyDisplayName(uyeler[0]) || uyeler[0].name;
    return { anahtar, ad, kisaAd: shortPrinter(ad), yazicilar: uyeler.map((u) => ({ id: u.id, name: u.name })) };
  });
  // Kısa adlar çakışırsa (iki ayrı aile aynı kısaltmaya düşerse) tam ada dön — sütunlar karışmasın.
  const sayac = new Map<string, number>();
  for (const a of aileler) sayac.set(a.kisaAd, (sayac.get(a.kisaAd) ?? 0) + 1);
  return aileler.map((a) => ((sayac.get(a.kisaAd) ?? 0) > 1 ? { ...a, kisaAd: a.ad } : a));
}

export interface KapsamDosyasi {
  id: string;
  printerConfigId: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  contentMd5: string | null;
}

export interface KapsamUrunu {
  productId: string;
  name: string;
  imageUrl: string | null;
  files: KapsamDosyasi[];
  totalBytes: number;
  variantGroupId?: string | null;
  variantGroupName?: string | null;
}

export type HucreDurumu = "var" | "kismi" | "yok";

export interface KapsamHucresi {
  durum: HucreDurumu;
  /** Bu ailede dosyası olan varyant sayısı / satırdaki toplam varyant. */
  varyantVar: number;
  varyantToplam: number;
  /** Parça sayısı — varyantlar arasında farklıysa en büyüğü. */
  parca: number;
  /**
   * Dosyası olan varyantların HEPSİ aynı dosyaları mı taşıyor? (renk varyantları: evet;
   * PS5 / Xbox gibi farklı gövdeler: hayır). Hayırsa "parçaları gör" tek bir varyanta
   * indirgenemez — hangisi olduğunu kullanıcı seçmeli.
   */
  ayniDosyalar: boolean;
}

export type SatirDurumu = "tam" | "eksik" | "yok";

export interface ModelSatiri<T extends KapsamUrunu = KapsamUrunu> {
  anahtar: string;
  /** Satır başlığı: grubun adı ya da ürünün adı. */
  ad: string;
  /** Varyantlar (en az bir ürün). Tek ürünlü satırda tek eleman. */
  urunler: T[];
  /** Aile sırasıyla hücreler (satırın tamamı için). */
  hucreler: KapsamHucresi[];
  /** Varyant başına hücreler — açılan alt satırlar. `urunler` ile aynı sırada. */
  varyantHucreleri: KapsamHucresi[][];
  durum: SatirDurumu;
  /** Satırdaki benzersiz parça sayısı (varyantlar aynı dosyayı paylaşıyorsa bir kez). */
  parca: number;
  /** Benzersiz dosyaların toplam boyutu. */
  boyut: number;
  gorsel: string | null;
}

/** Bir ürünün, bir ailedeki (tekrarsız) parçaları. */
function ailedekiParcalar(urun: KapsamUrunu, aile: KapsamAilesi): KapsamDosyasi[] {
  const idler = new Set(aile.yazicilar.map((y) => y.id));
  return dedupeFiles(urun.files.filter((f) => idler.has(f.printerConfigId)));
}

/** Dosya kümesinin içerik imzası — sıra önemsiz. */
const imza = (dosyalar: KapsamDosyasi[]) => dosyalar.map(fileContentKey).sort().join("|");

function hucre(varyantlar: KapsamDosyasi[][]): KapsamHucresi {
  const dolu = varyantlar.filter((d) => d.length > 0);
  const imzalar = new Set(dolu.map(imza));
  return {
    durum: dolu.length === 0 ? "yok" : dolu.length === varyantlar.length ? "var" : "kismi",
    varyantVar: dolu.length,
    varyantToplam: varyantlar.length,
    parca: dolu.length ? Math.max(...dolu.map((d) => d.length)) : 0,
    ayniDosyalar: imzalar.size <= 1,
  };
}

function satirDurumu(hucreler: KapsamHucresi[]): SatirDurumu {
  if (hucreler.length === 0 || hucreler.every((h) => h.durum === "yok")) return "yok";
  return hucreler.every((h) => h.durum === "var") ? "tam" : "eksik";
}

/** Varyantların ortak taban adı ("Alev Temalı Kol Standı — PS5 / Altın" → "Alev Temalı Kol Standı"). */
function ortakAd(urunler: readonly KapsamUrunu[]): string {
  const tabanlar = urunler.map((u) => adParcala(u.name).taban);
  return tabanlar.every((t) => t === tabanlar[0]) ? tabanlar[0] : "";
}

/**
 * Ürünleri tablo satırlarına çevir. Aynı varyant grubundaki ürünler TEK satırdır; grupsuz ürün
 * kendi satırıdır. Sıra: ilk görülen (çağıran sonradan sıralar).
 */
export function modelSatirlari<T extends KapsamUrunu>(urunler: readonly T[], aileler: readonly KapsamAilesi[]): ModelSatiri<T>[] {
  const gruplar = new Map<string, T[]>();
  for (const u of urunler) {
    const anahtar = u.variantGroupId ? `g:${u.variantGroupId}` : `u:${u.productId}`;
    const g = gruplar.get(anahtar);
    if (g) g.push(u);
    else gruplar.set(anahtar, [u]);
  }
  return [...gruplar.entries()].map(([anahtar, liste]) => {
    const sirali = liste.length > 1 ? [...liste].sort((a, b) => a.name.localeCompare(b.name, "tr-TR")) : liste;
    const varyantHucreleri = sirali.map((u) => aileler.map((a) => hucre([ailedekiParcalar(u, a)])));
    const hucreler = aileler.map((a) => hucre(sirali.map((u) => ailedekiParcalar(u, a))));
    const benzersiz = dedupeFiles(sirali.flatMap((u) => u.files));
    const ad = sirali.length > 1 ? ortakAd(sirali) || sirali[0].variantGroupName || sirali[0].name : sirali[0].name;
    return {
      anahtar,
      ad,
      urunler: sirali,
      hucreler,
      varyantHucreleri,
      durum: satirDurumu(hucreler),
      parca: benzersiz.length,
      boyut: benzersiz.reduce((s, f) => s + (f.sizeBytes ?? 0), 0),
      gorsel: sirali.find((u) => u.imageUrl)?.imageUrl ?? null,
    };
  });
}

/** Alt satırın adı: yalnız varyant kısmı ("PS5 / Altın"); ayrılamıyorsa tam ad. */
export function varyantAdi(urun: KapsamUrunu, satirAdi: string): string {
  const { taban, varyant } = adParcala(urun.name);
  return varyant && taban === satirAdi ? varyant : urun.name;
}

// ── Süzme ──────────────────────────────────────────────────────────────────────────────

export type KapsamFiltresi =
  | { tur: "tumu" }
  /** En az bir yazıcı için dosyası olan modeller. */
  | { tur: "dosyali" }
  /** Hiçbir yazıcı için dosyası olmayan modeller. */
  | { tur: "dosyasiz" }
  /** Seçilen ailede dosyası TAM olanlar ("var") ya da eksik/olmayanlar ("yok"). */
  | { tur: "aile"; aile: string; durum: "var" | "yok" };

export function satirUyar(satir: ModelSatiri, aileler: readonly KapsamAilesi[], filtre: KapsamFiltresi): boolean {
  switch (filtre.tur) {
    case "dosyali":
      return satir.durum !== "yok";
    case "dosyasiz":
      return satir.durum === "yok";
    case "aile": {
      const i = aileler.findIndex((a) => a.anahtar === filtre.aile);
      if (i < 0) return true; // aile artık yok (yazıcı silindi) → süzgeç etkisiz
      const tam = satir.hucreler[i]?.durum === "var";
      // Kısmen dolu satır "eksik" sayılır: bazı varyantların hâlâ dosyası yok.
      return filtre.durum === "var" ? tam : !tam;
    }
    default:
      return true;
  }
}

export interface KapsamOzeti {
  toplam: number;
  dosyali: number;
  dosyasiz: number;
  /** Aile sırasıyla: dosyası tam olan model sayısı. */
  aileVar: number[];
}

export function kapsamOzeti(satirlar: readonly ModelSatiri[], aileler: readonly KapsamAilesi[]): KapsamOzeti {
  const dosyasiz = satirlar.filter((s) => s.durum === "yok").length;
  return {
    toplam: satirlar.length,
    dosyali: satirlar.length - dosyasiz,
    dosyasiz,
    aileVar: aileler.map((_, i) => satirlar.filter((s) => s.hucreler[i]?.durum === "var").length),
  };
}

// ── Arama ──────────────────────────────────────────────────────────────────────────────

export interface SatirAramasi {
  eslesti: boolean;
  /** Eşleşme yalnız PARÇA adından geldiyse kaç parça — kullanıcı satırın neden çıktığını görsün. */
  eslesenParca: number;
}

/** Satır adı, varyant adları ve parça adları üzerinde ara. */
export function satirAra(satir: ModelSatiri, sorgu: string): SatirAramasi {
  const q = sorgu.trim();
  if (!q) return { eslesti: true, eslesenParca: 0 };
  if (foldTr(satir.ad).includes(foldTr(q))) return { eslesti: true, eslesenParca: 0 };
  let adEslesti = false;
  const parcalar = new Set<string>();
  for (const u of satir.urunler) {
    const sonuc = searchProduct(u, q);
    if (sonuc.nameMatched) adEslesti = true;
    for (const id of sonuc.matchedFileIds) parcalar.add(id);
  }
  return { eslesti: adEslesti || parcalar.size > 0, eslesenParca: adEslesti ? 0 : parcalar.size };
}

// ── Sıralama ───────────────────────────────────────────────────────────────────────────

export type KapsamSirasi = "ad" | "eksik" | "parca" | "boyut";

const DURUM_SIRASI: Record<SatirDurumu, number> = { yok: 0, eksik: 1, tam: 2 };

/** Girdi dizisini DEĞİŞTİRMEZ. */
export function satirSirala<T extends ModelSatiri>(satirlar: readonly T[], sira: KapsamSirasi): T[] {
  const ada = (a: T, b: T) => a.ad.localeCompare(b.ad, "tr-TR");
  const liste = [...satirlar];
  switch (sira) {
    case "eksik":
      // Önce hiç dosyası olmayanlar, sonra kısmen eksikler — doldurulacak iş listesi.
      return liste.sort((a, b) => DURUM_SIRASI[a.durum] - DURUM_SIRASI[b.durum] || ada(a, b));
    case "parca":
      return liste.sort((a, b) => b.parca - a.parca || ada(a, b));
    case "boyut":
      return liste.sort((a, b) => b.boyut - a.boyut || ada(a, b));
    default:
      return liste.sort(ada);
  }
}

/** Hücrenin açıklaması — ekran okuyucu ve ipucu için. */
export function hucreAciklamasi(h: KapsamHucresi, aileAdi: string): string {
  if (h.durum === "yok") return `${aileAdi}: dosya yok`;
  if (h.durum === "kismi") return `${aileAdi}: ${h.varyantToplam} varyantın ${h.varyantVar} tanesinde var`;
  return `${aileAdi}: ${h.parca} parça`;
}
