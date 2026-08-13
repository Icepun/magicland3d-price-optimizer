/**
 * Modeller sayfasının saf görünüm mantığı — React'siz test edilebilsin diye ayrı.
 *
 * ⚠️ Buradaki gramaj `ProductModelFile.gramaj`: dilimlenmiş DOSYANIN gramajı, yalnız
 * yazıcılar arası karşılaştırma için. Ürün maliyetiyle ilgisi YOKTUR
 * (gerekçe ve koruma: `src/lib/model-gramaj.ts`, `src/lib/model-gramaj.test.ts`).
 */

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
  printerId?: string | null
): boolean {
  const hedefler = printerId ? [printerId] : printerIds;
  if (!hedefler.length) return false;
  return hedefler.some((id) => !product.files.some((f) => f.printerConfigId === id));
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
