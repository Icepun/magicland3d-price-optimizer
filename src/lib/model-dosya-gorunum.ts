/**
 * BASKI DOSYASI SATIRININ SAF GÖRÜNÜM MANTIĞI — React yok, ağ yok.
 *
 * Ürünün "Baskı Dosyaları" kartı ile onu besleyen uç aynı kuralları kullanır: hangi ad
 * gösterilecek, süre/gramaj nasıl yazılacak, renkler nereden çıkacak, toplam nasıl okunacak.
 *
 * ⚠️ Buradaki süre ve gramaj DOSYANIN kendi değerleridir, yalnız gösterim içindir; ürün
 * maliyetine girmez (gerekçe: `src/lib/model-gramaj.ts`).
 */

/** Dakikayı "2sa 18dk" biçiminde yaz. Bilinmiyorsa "—" (BİLİNMEYEN ≠ SIFIR). */
export function fmtSure(dk: number | null | undefined): string {
  if (dk == null || !Number.isFinite(dk) || dk <= 0) return "—";
  const sa = Math.floor(dk / 60);
  const kalan = Math.round(dk % 60);
  if (sa > 0) return kalan > 0 ? `${sa}sa ${kalan}dk` : `${sa}sa`;
  return `${kalan}dk`;
}

const GRAM_BICIMI = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Gramı "61,4 gr" / "240 gr" biçiminde yaz (100 gr üstünde küsurat gösterilmez). */
export function fmtGram(g: number | null | undefined): string {
  if (g == null || !Number.isFinite(g) || g <= 0) return "—";
  return `${GRAM_BICIMI.format(g >= 100 ? Math.round(g) : g)} gr`;
}

/** Dosya adından uzantıyı at ("PS5 Dual Color.gcode.3mf" → "PS5 Dual Color"). */
export function uzantisizAd(dosyaAdi: string): string {
  const ad = (dosyaAdi ?? "").trim();
  const kisa = ad.replace(/(\.gcode)?\.(3mf|gcode|gco|g)$/i, "");
  return kisa || ad;
}

/** Satırın başlığı: verilen ad, yoksa dosya adı (uzantısız). */
export function gorunenAd(p: { label: string | null; originalName: string }): string {
  const ad = (p.label ?? "").trim();
  return ad || uzantisizAd(p.originalName);
}

/** Tür rozeti: "3MF" / "GCODE". */
export function turEtiketi(fileType: string): string {
  return /3mf/i.test(fileType) ? "3MF" : "GCODE";
}

/**
 * Kayıtlı renk bilgisinden çizilecek renkleri çıkar.
 *
 * Proje dosyası AMS'teki BÜTÜN filamentleri listeleyebilir; hangisinin harcandığı biliniyorsa
 * yalnız onlar gösterilir (4 renk yazıp 2'sini kullanan dosya "4 renkli" görünmesin).
 */
export function renkleriCoz(colorsJson: string | null | undefined, sinir = 8): string[] {
  if (!colorsJson) return [];
  let liste: { hex?: unknown; grams?: unknown }[] = [];
  try {
    const j = JSON.parse(colorsJson) as { colors?: unknown };
    if (Array.isArray(j?.colors)) liste = j.colors as typeof liste;
  } catch {
    return [];
  }
  const gecerli = liste.filter((c) => typeof c?.hex === "string" && /^#[0-9a-f]{6}$/i.test(c.hex as string));
  const harcanan = gecerli.filter((c) => typeof c.grams === "number" && (c.grams as number) > 0);
  const secilen = harcanan.length > 0 ? harcanan : gecerli;
  return secilen.slice(0, sinir).map((c) => (c.hex as string).toUpperCase());
}

export interface OlculenDosya {
  gramaj: number | null;
  estPrintMin?: number | null;
  hasThumbnail?: boolean;
}

/** Dosyadan okunabilecek bir bilgisi eksik mi (süre, gramaj ya da önizleme)? */
export function bilgiEksik(p: OlculenDosya): boolean {
  return p.gramaj == null || p.estPrintMin == null || !p.hasThumbnail;
}

export interface GrupOzeti {
  /** Bilinen sürelerin toplamı (dk) — hiçbiri bilinmiyorsa null. */
  sureDk: number | null;
  /** Bilinen gramajların toplamı — hiçbiri bilinmiyorsa null. */
  gram: number | null;
  /** Bazı parçaların süresi/gramajı bilinmiyor → toplam bir ALT SINIRDIR. */
  sureEksik: boolean;
  gramEksik: boolean;
}

/** Bir yazıcıdaki parçaların toplam süresi ve gramajı ("bu ürünü basmak ne kadar sürer"). */
export function grupOzeti(parcalar: readonly OlculenDosya[]): GrupOzeti {
  const pozitif = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const sureler = parcalar.map((p) => p.estPrintMin).filter(pozitif);
  const gramlar = parcalar.map((p) => p.gramaj).filter(pozitif);
  return {
    sureDk: sureler.length ? sureler.reduce((a, b) => a + b, 0) : null,
    gram: gramlar.length ? Math.round(gramlar.reduce((a, b) => a + b, 0) * 10) / 10 : null,
    sureEksik: sureler.length < parcalar.length,
    gramEksik: gramlar.length < parcalar.length,
  };
}

/** Toplamı yaz; eksik parça varsa sonuna "+" koy (alt sınır). Hiç bilinmiyorsa null. */
export function ozetMetni(o: GrupOzeti): string | null {
  const parcalar: string[] = [];
  if (o.sureDk != null) parcalar.push(`${fmtSure(o.sureDk)}${o.sureEksik ? "+" : ""}`);
  if (o.gram != null) parcalar.push(`${fmtGram(o.gram)}${o.gramEksik ? "+" : ""}`);
  return parcalar.length ? parcalar.join(" · ") : null;
}

/** Kartın kabul ettiği baskı dosyası mı? (sürükle-bırak için) */
export function baskiDosyasiMi(ad: string): boolean {
  return /\.(gcode|gco|g|3mf)$/i.test(ad ?? "");
}
