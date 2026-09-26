/**
 * "Ürüne bağla" penceresinin ürün sıralaması: satır adına en çok benzeyen ürün en üstte.
 *
 * Saf fonksiyon (arayüzden bağımsız test edilir). Türkçe harfler sadeleştirilir: satır adı
 * "Kupası", ürün adı "Kupasi" yazılmış olsa da eşleşsin.
 */

export interface BaglanabilirUrun {
  id: string;
  name: string;
  alias?: string | null;
  variantLabel?: string | null;
  variantGroupName?: string | null;
}

/** Küçük harf + Türkçe harf sadeleştirme (ş→s, ı→i …) + noktalama yerine boşluk. */
export function sadeMetin(metin: string | null | undefined): string {
  if (!metin) return "";
  return metin
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function kelimeler(metin: string | null | undefined): string[] {
  return [...new Set(sadeMetin(metin).split(" ").filter((k) => k.length >= 2))];
}

function urunMetni(u: BaglanabilirUrun): string {
  return sadeMetin([u.name, u.alias, u.variantLabel, u.variantGroupName].filter(Boolean).join(" "));
}

/** Satır adının kelimelerinden kaçı ürünün adında geçiyor. */
export function benzerlikPuani(satirAdi: string, u: BaglanabilirUrun): number {
  const urunKelimeleri = new Set(urunMetni(u).split(" "));
  return kelimeler(satirAdi).filter((k) => urunKelimeleri.has(k)).length;
}

/** Listenin türü — başlık buna göre ("Önerilen" / "Tüm ürünler"). */
export type ListeTuru = "arama" | "oneri" | "tumu";

/**
 * Listelenecek ürünler. Arama varsa aranan kelimelerin HEPSİNİ içerenler; yoksa satır adına
 * benzeyenler (öneri); hiç benzeyen yoksa tüm ürünler — hepsi benzerlik, sonra ad sırasıyla.
 */
export function baglanacakUrunler<T extends BaglanabilirUrun>(
  satirAdi: string,
  urunler: readonly T[],
  arama: string,
  azami = 60
): { liste: { urun: T; puan: number }[]; tur: ListeTuru } {
  const aranan = kelimeler(arama);
  const puanli = urunler.map((urun) => ({ urun, puan: benzerlikPuani(satirAdi, urun) }));
  const sirala = (l: typeof puanli) =>
    l.sort((a, b) => b.puan - a.puan || a.urun.name.localeCompare(b.urun.name, "tr")).slice(0, azami);
  if (aranan.length > 0) {
    const metinli = puanli.filter(({ urun }) => {
      const metin = urunMetni(urun);
      return aranan.every((k) => metin.includes(k));
    });
    return { liste: sirala(metinli), tur: "arama" };
  }
  const oneriler = puanli.filter(({ puan }) => puan > 0);
  return oneriler.length > 0
    ? { liste: sirala(oneriler), tur: "oneri" }
    : { liste: sirala(puanli), tur: "tumu" };
}
