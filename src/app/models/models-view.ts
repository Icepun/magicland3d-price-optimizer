/**
 * Modeller sayfasının saf görünüm mantığı — React'siz test edilebilsin diye ayrı.
 *
 * ⚠️ Buradaki gramaj `ProductModelFile.gramaj`: dilimlenmiş DOSYANIN gramajı, yalnız
 * yazıcılar arası karşılaştırma için. Ürün maliyetiyle ilgisi YOKTUR
 * (gerekçe ve koruma: `src/lib/model-gramaj.ts`, `src/lib/model-gramaj.test.ts`).
 */
import { adParcala } from "@/lib/urun-adi";
import { dedupeFiles, familyMemberIds, type AileUyesi } from "@/core/printers/printer-family";

/**
 * Yazıcının AİLESİNDEKİ dosyalar: aynı tür + marka + modeldeki yazıcılar aynı dosyayı basar
 * (bkz. core/printers/printer-family). Aynı içerik iki yazıcıya ayrı yüklendiyse bir kez sayılır.
 *
 * NEDEN: kütüphane dosyaları yazıcıya göre sayıyordu; ikinci U1 her üründe "dosya yok"
 * görünüyordu. Oysa o dosyaları basabiliyor.
 */
export function aileDosyalari<
  F extends { printerConfigId: string; originalName: string; contentMd5?: string | null; sizeBytes?: number | null },
>(files: F[], printerId: string, printers: AileUyesi[] = []): F[] {
  const uyeler = new Set(printers.length ? familyMemberIds(printers, printerId) : [printerId]);
  return dedupeFiles(files.filter((f) => uyeler.has(f.printerConfigId)));
}

/**
 * Arama için metin katlama: Türkçe küçük harf + diakritik sadeleştirme.
 *
 * "şarap" yazan kullanıcı "Sarap"ı da bulmalı, "İSTASYON" arayan "istasyon"u da.
 * ⚠️ Türkçe'de `I→ı` ve `İ→i` — `toLowerCase()` bunu YANLIŞ yapar, `toLocaleLowerCase("tr-TR")`
 * şarttır. Diakritikler ayrıca katlanır ki klavyesinde Türkçe harf olmayan da arayabilsin.
 */
export function foldTr(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export interface SearchableFile {
  id: string;
  label: string | null;
  originalName: string;
}

export interface SearchableProduct {
  name: string;
  files: SearchableFile[];
}

export interface SearchHit {
  /** Ürün listede kalsın mı? */
  matches: boolean;
  /** Eşleşme PARÇA adından geldiyse hangileri — kullanıcı neden çıktığını görsün. */
  matchedFileIds: string[];
  /** Ürün ADI da eşleşti mi? (yalnız parça eşleşmesinde ayrıca belirtilir) */
  nameMatched: boolean;
}

/**
 * Ürün adı VE parça adları üzerinde ara.
 *
 * Eskiden yalnız ürün adına bakılıyordu; 470 parçanın adı arama dışındaydı. Oysa dosya adları
 * çoğu zaman aranan bilgiyi taşıyor ("Dark Lord PS5 19s55dk.gcode").
 */
export function searchProduct(product: SearchableProduct, query: string): SearchHit {
  const q = foldTr(query.trim());
  if (!q) return { matches: true, matchedFileIds: [], nameMatched: false };

  const nameMatched = foldTr(product.name).includes(q);
  const matchedFileIds = product.files
    .filter((f) => foldTr(f.label || f.originalName).includes(q))
    .map((f) => f.id);

  return { matches: nameMatched || matchedFileIds.length > 0, matchedFileIds, nameMatched };
}

export type SortMode = "name" | "parts" | "size" | "recent";

export interface SortableProduct {
  name: string;
  files: Array<{ id: string }>;
  totalBytes: number;
}

/** Liste sıralaması. `recent` sunucudan gelen sırayı (en son güncellenen önce) korur. */
export function sortProducts<T extends SortableProduct>(products: T[], mode: SortMode): T[] {
  const list = [...products];
  switch (mode) {
    case "parts":
      return list.sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name, "tr-TR"));
    case "size":
      return list.sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name, "tr-TR"));
    case "recent":
      return list;
    case "name":
    default:
      return list.sort((a, b) => a.name.localeCompare(b.name, "tr-TR"));
  }
}

/**
 * Bu üründe SEÇİLEN yazıcının dosyası eksik mi?
 *
 * `printerId` verilmezse eski davranış: yazıcılardan HERHANGİ birinde eksikse eşleşir.
 * ⚠️ Bu genel filtre pratikte işe yaramıyordu — kapsama oranları (95/89/75/70 / 110) yüzünden
 * neredeyse her ürün takılıyordu. Yazıcı seçilince filtre anlamlı hale gelir.
 */
export function missingFiles(
  product: { files: Array<{ printerConfigId: string }> },
  printerIds: string[],
  printerId?: string | null,
  /** Verilirse aile hesaba katılır: kardeş yazıcının dosyası bu yazıcıda da "var" sayılır. */
  printers?: AileUyesi[],
): boolean {
  const hedefler = printerId ? [printerId] : printerIds;
  if (!hedefler.length) return false;
  return hedefler.some((id) => {
    const uyeler = printers?.length ? familyMemberIds(printers, id) : [id];
    return !product.files.some((f) => uyeler.includes(f.printerConfigId));
  });
}

export interface GramajFile {
  printerConfigId: string;
  gramaj: number | null;
}

export interface PrinterGramaj {
  printerConfigId: string;
  /** Bu yazıcının dosyalarının toplam gramajı — hiçbiri okunmadıysa null. */
  grams: number | null;
  /** Gramajı okunmuş parça sayısı. */
  known: number;
  /** Bu yazıcıdaki toplam parça sayısı. */
  total: number;
  /** En az filament harcayan yazıcı mı? (yalnız TAM okunmuş adaylar arasında) */
  lowest: boolean;
}

/**
 * Ürünün yazıcı başına filament tüketimi.
 *
 * ⚠️ "EN AZ" YALNIZ TAM OKUNMUŞ ADAYLAR ARASINDA SEÇİLİR. Yarısı okunmuş bir yazıcının
 * toplamı doğal olarak küçük çıkar; onu "en az harcayan" ilan etmek kullanıcıyı yanlış
 * makineye yönlendirirdi — tam da bu özelliğin engellemek istediği hata.
 *
 * Tek aday varsa kıyas yoktur: `lowest` işareti verilmez (karşılaştırma iki makine ister).
 */
export function gramajByPrinter(
  files: GramajFile[],
  printerIds: string[]
): PrinterGramaj[] {
  const rows: PrinterGramaj[] = printerIds.map((printerConfigId) => {
    const mine = files.filter((f) => f.printerConfigId === printerConfigId);
    const bilinen = mine.filter((f) => typeof f.gramaj === "number" && f.gramaj! > 0);
    return {
      printerConfigId,
      // BİLİNMEYEN ≠ SIFIR: hiç okunmamışsa 0 değil null.
      grams: bilinen.length ? Math.round(bilinen.reduce((s, f) => s + (f.gramaj ?? 0), 0) * 10) / 10 : null,
      known: bilinen.length,
      total: mine.length,
      lowest: false,
    };
  }).filter((r) => r.total > 0);

  const tamOkunmus = rows.filter((r) => r.grams != null && r.known === r.total);
  if (tamOkunmus.length >= 2) {
    const min = Math.min(...tamOkunmus.map((r) => r.grams!));
    for (const r of tamOkunmus) if (r.grams === min) r.lowest = true;
  }
  return rows;
}

/**
 * Karşılaştırma cümlesi — kaç makinenin ölçüldüğü ve farkın ne olduğu.
 * Kıyas kurulamıyorsa `null` (uydurma bir sonuç yazmaktansa susmak).
 */
export function gramajCompareText(rows: PrinterGramaj[]): string | null {
  const tam = rows.filter((r) => r.grams != null && r.known === r.total);
  if (tam.length < 2) return null;
  const sirali = [...tam].sort((a, b) => a.grams! - b.grams!);
  const az = sirali[0].grams!;
  const cok = sirali[sirali.length - 1].grams!;
  const fark = Math.round((cok - az) * 10) / 10;
  if (fark <= 0) return "Ölçülen makineler aynı miktarda filament harcıyor.";
  const yuzde = Math.round((fark / cok) * 100);
  return `En az harcayan makine ${fark} gr (%${yuzde}) tasarruf ediyor.`;
}

/** Gramajı henüz okunmamış parçalar — doldurma düğmesi bunları işler. */
export function missingGramajFiles<T extends { id: string; gramaj: number | null }>(
  files: T[]
): T[] {
  return files.filter((f) => f.gramaj == null);
}

/**
 * Makine şeridi için kısa ad. Şerit dört eşit bölmeye ayrıldığı için tam ad sığmaz;
 * kullanıcının makineyi tanıdığı ayırt edici parçayı bırakırız ("Neptune 4 Pro" → "N4 PRO").
 */
export function shortPrinter(name: string): string {
  const n = name.trim();
  // "Neptune 4 Pro" → "N4 PRO" · "Neptune 4 Plus" → "N4 PLUS"
  const neptune = /neptune\s*(\d+)\s*(pro|plus|max)?/i.exec(n);
  if (neptune) {
    return `N${neptune[1]}${neptune[2] ? ` ${neptune[2]}` : ""}`.toLocaleUpperCase("tr-TR");
  }
  // "Bambu Lab A1 Combo" → "A1" · "Snapmaker U1" → "U1"
  const model = /(?:^|\s)([a-z]\d[a-z0-9]*)(?:\s|$)/i.exec(n);
  if (model) return model[1].toLocaleUpperCase("tr-TR");
  return n.slice(0, 7).toLocaleUpperCase("tr-TR");
}

/**
 * Tüm yazıcıların kısa adları — ÇAKIŞANLAR AYRIŞTIRILIR.
 * "Snapmaker U1 Alt" ve "Snapmaker U1 Üst" ikisi de "U1" oluyordu; şeritte hangi bölmenin
 * hangi makine olduğu anlaşılmıyordu (9 Eki 2026 denetimi). Çakışan adlara modelden sonraki
 * kelime eklenir ("U1 ALT" / "U1 ÜST"); öyle bir kelime yoksa sıra numarası.
 */
export function kisaYaziciAdlari(printers: readonly { id: string; name: string }[]): Map<string, string> {
  const taban = new Map(printers.map((p) => [p.id, shortPrinter(p.name)]));
  const sayac = new Map<string, number>();
  for (const ad of taban.values()) sayac.set(ad, (sayac.get(ad) ?? 0) + 1);
  const out = new Map<string, string>();
  const sira = new Map<string, number>();
  for (const p of printers) {
    const t = taban.get(p.id)!;
    if ((sayac.get(t) ?? 0) < 2) {
      out.set(p.id, t);
      continue;
    }
    const kelimeler = p.name.trim().split(/\s+/);
    const i = kelimeler.findIndex((k) => k.toLocaleUpperCase("tr-TR") === t);
    const ek = i >= 0 ? kelimeler.slice(i + 1).join(" ") : "";
    const n = (sira.get(t) ?? 0) + 1;
    sira.set(t, n);
    out.set(p.id, ek ? `${t} ${ek.toLocaleUpperCase("tr-TR")}` : `${t} ${n}`);
  }
  return out;
}

export { adParcala } from "@/lib/urun-adi";

export interface GruplanabilirUrun {
  productId: string;
  name: string;
  files: { printerConfigId: string; contentMd5: string | null; originalName: string; sizeBytes: number }[];
}

/**
 * DOSYALARI BİREBİR AYNI renk varyantlarını tek kartta topla.
 * Ahtapot Şarap Tutacağı'nın 3 rengi, Alev Temalı Kol Standı'nın PS5 renkleri aynı dosyaları
 * taşıyor ama her biri ayrı kart olarak ekranı dolduruyordu. Kural: aynı taban ad + aynı dosya
 * kümesi → bir kart. Dosyası farklı olan (PS5 / Xbox) ayrı kalır. Sıra korunur (ilk görülen).
 */
export function varyantlariTopla<T extends GruplanabilirUrun>(urunler: readonly T[]): { anahtar: string; urunler: T[] }[] {
  const parmakIzi = (u: T) =>
    u.files
      .map((f) => `${f.printerConfigId}:${f.contentMd5 ?? `${f.originalName}#${f.sizeBytes}`}`)
      .sort()
      .join("|");
  const gruplar = new Map<string, T[]>();
  for (const u of urunler) {
    const { taban, varyant } = adParcala(u.name);
    // Varyantsız ad ya da dosyasız ürün hiçbir şeyle birleşmez.
    const anahtar = varyant && u.files.length > 0 ? `${foldTr(taban)}\u0000${parmakIzi(u)}` : `tek\u0000${u.productId}`;
    const g = gruplar.get(anahtar);
    if (g) g.push(u);
    else gruplar.set(anahtar, [u]);
  }
  return [...gruplar.entries()].map(([anahtar, liste]) => ({ anahtar, urunler: liste }));
}
