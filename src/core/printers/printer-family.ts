/**
 * YAZICI AİLESİ — aynı dilimlenmiş dosyayı basabilen yazıcılar.
 *
 * SORUN (23 Eyl 2026): model dosyaları TEK bir yazıcıya bağlıydı (`ProductModelFile.printerConfigId`).
 * İkinci bir Snapmaker U1 eklenince ürünlerin dosyaları ona hiç görünmedi; kullanıcı ikinci
 * yazıcıda basmak için aynı dosyaları "özel baskı" diye tekrar tekrar yükledi (canlı veride
 * 59 dosya; kopyalar 834 MB bulut alanı). Oysa aynı marka + modeldeki iki yazıcı AYNI makinedir
 * ve aynı gcode'u basar.
 *
 * Aile = bağlantı türü + marka + model. Model girilmemiş yazıcı kendi başına bir ailedir —
 * uyumluluğu bilinmeyen iki yazıcıyı eşleştirmek yanlış dosyayı yanlış makineye gönderebilir.
 */

export interface AileUyesi {
  id: string;
  type: string | null;
  brand: string | null;
  model: string | null;
}

function sade(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Ailenin anahtarı. Modeli bilinmeyen yazıcı yalnız kendisiyle eşleşir. */
export function printerFamilyKey(p: AileUyesi): string {
  const model = sade(p.model);
  if (!model) return `tek:${p.id}`;
  return `${sade(p.type)}|${sade(p.brand)}|${model}`;
}

/** İki yazıcı aynı dosyayı basabilir mi? */
export function sameFamily(a: AileUyesi, b: AileUyesi): boolean {
  return a.id === b.id || printerFamilyKey(a) === printerFamilyKey(b);
}

/** `printerId` ile aynı ailedeki yazıcıların kimlikleri (kendisi DAHİL, ilk sırada). */
export function familyMemberIds(tumu: AileUyesi[], printerId: string): string[] {
  const hedef = tumu.find((p) => p.id === printerId);
  if (!hedef) return [printerId];
  const anahtar = printerFamilyKey(hedef);
  return [printerId, ...tumu.filter((p) => p.id !== printerId && printerFamilyKey(p) === anahtar).map((p) => p.id)];
}

/**
 * Aynı içeriğin tekrarlarını ayıklamak için kimlik: içerik özeti (md5) varsa o, yoksa ad + boyut.
 * Bulut anahtarı kullanılmaz — aynı dosyanın her yüklemesi AYRI bir anahtar alıyor.
 * (Aynı dosya iki yazıcıya ayrı ayrı yüklendiyse iki satır vardır; listede bir kez görünmeli.)
 */
export function fileContentKey(f: IcerikBilgisi): string {
  if (f.contentMd5) return `md5:${f.contentMd5}`;
  return adBoyutAnahtari(f);
}

interface IcerikBilgisi {
  contentMd5?: string | null;
  r2Key?: string | null;
  originalName: string;
  sizeBytes?: number | null;
}

function adBoyutAnahtari(f: IcerikBilgisi): string {
  return `ad:${f.originalName.trim().toLowerCase()}|${f.sizeBytes ?? 0}`;
}

/**
 * Tekrarları ayıklarken bakılacak TÜM anahtarlar. Aynı dosyanın bir kopyasında içerik özeti
 * var, diğerinde henüz yok olabiliyor (özet ilk baskıda hesaplanıyor) — ikisinin de aynı dosya
 * sayılması için hem özet hem ad + boyut anahtarı verilir.
 */
export function fileContentKeys(f: IcerikBilgisi): string[] {
  return f.contentMd5 ? [`md5:${f.contentMd5}`, adBoyutAnahtari(f)] : [adBoyutAnahtari(f)];
}

/** Listeden tekrarları ayıkla — İLK görülen kalır (çağıran tercih sırasına göre dizmeli). */
export function dedupeFiles<T extends IcerikBilgisi>(dosyalar: T[]): T[] {
  const gorulen = new Set<string>();
  const out: T[] = [];
  for (const d of dosyalar) {
    const anahtarlar = fileContentKeys(d);
    if (anahtarlar.some((k) => gorulen.has(k))) continue;
    for (const k of anahtarlar) gorulen.add(k);
    out.push(d);
  }
  return out;
}

export interface KopyaAdayi extends IcerikBilgisi {
  id: string;
  productId: string;
  printerConfigId: string;
  label?: string | null;
  meshR2Key?: string | null;
  createdAt: Date | string;
}

/**
 * Aynı aile + aynı ürün (+ aynı parça adı) içinde AYNI İÇERİĞİ taşıyan fazladan satırları bulur.
 *
 * Neden var: aile kavramı gelmeden önce ikinci yazıcıda basmak için aynı dosya tekrar tekrar
 * yüklendi (canlı veride 22 kopya, 834 MB). Hangisi SAKLANIR: kaynak 3B modeli bağlı olan >
 * içerik özeti hesaplanmış olan > en yeni. Farklı ürünlerdeki aynı dosya (varyantlar arası
 * paylaşım) kopya SAYILMAZ; parça adı farklıysa da sayılmaz (kullanıcı bilerek iki parça yapmış
 * olabilir).
 */
export function findDuplicateFiles<T extends KopyaAdayi>(
  satirlar: T[],
  yazicilar: AileUyesi[],
): { tutulan: T[]; fazla: T[] } {
  const yaziciById = new Map(yazicilar.map((y) => [y.id, y]));
  const aileOf = (printerConfigId: string) => {
    const y = yaziciById.get(printerConfigId);
    return y ? printerFamilyKey(y) : `tek:${printerConfigId}`;
  };
  const zaman = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(v)) || 0;
  const sirali = [...satirlar].sort(
    (a, b) =>
      Number(!!b.meshR2Key) - Number(!!a.meshR2Key) ||
      Number(!!b.contentMd5) - Number(!!a.contentMd5) ||
      zaman(b.createdAt) - zaman(a.createdAt),
  );
  const gorulen = new Set<string>();
  const tutulan: T[] = [];
  const fazla: T[] = [];
  for (const s of sirali) {
    const kapsam = `${aileOf(s.printerConfigId)}|${s.productId}|${(s.label ?? "").trim().toLowerCase()}`;
    const anahtarlar = fileContentKeys(s).map((k) => `${kapsam}|${k}`);
    if (anahtarlar.some((k) => gorulen.has(k))) {
      fazla.push(s);
      continue;
    }
    for (const k of anahtarlar) gorulen.add(k);
    tutulan.push(s);
  }
  return { tutulan, fazla };
}

/** Ailenin kullanıcıya görünen adı: "Snapmaker U1". Marka/model yoksa yazıcının adı. */
export function familyDisplayName(p: AileUyesi & { name?: string | null }): string {
  const marka = (p.brand ?? "").trim();
  const model = (p.model ?? "").trim();
  if (!model) return (p.name ?? "").trim() || marka || "Yazıcı";
  const markaAdi = marka ? marka.charAt(0).toLocaleUpperCase("tr-TR") + marka.slice(1) : "";
  return markaAdi ? `${markaAdi} ${model}` : model;
}
