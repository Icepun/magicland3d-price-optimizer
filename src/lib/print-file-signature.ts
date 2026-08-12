/**
 * Basılan dosya ↔ kayıtlı model eşleştirmesi: İÇERİK İMZASI.
 *
 * Yazıcıya yüklenen dosyanın adına içerik MD5'inin ilk 10 hanesi gömülür
 * ("Darth Kol Gövde 2s1dk.gcode" + md5 8d28f87e04… → "Darth Kol Gövde 2s1dk-8d28f87e04.gcode").
 * Adı bu içerikten BİZ ürettiğimiz için imza, dosyanın hangi içerik olduğunun kanıtıdır.
 *
 * NEDEN: eşleştirme eskiden YALNIZ ada bakıyordu. Aynı adla yeniden dilimlenmiş iki dosya
 * varsa (ör. "Xbox Dual 2s11dk.gcode" güncellenip tekrar yüklendiğinde) baskı kartında SESSİZCE
 * yanlış modelin geometrisi/önizlemesi çıkıyordu — kullanıcı yanlış ürünün fotoğrafını görüyordu.
 * İmza kontrolü bedava: adda imza varsa doğrulanır, kayıttaki içerikle çelişiyorsa eşleştirme
 * REDDEDİLİR. Yanlış model göstermektense hiç gösterme.
 *
 * Geriye dönük uyum: imzasız eski dosyalar (elle yazıcıya atılmış, imza doğmadan yüklenmiş)
 * eski ad eşleşmesiyle çalışmaya devam eder — ama farklı içerikli birden çok aday varsa
 * eşleştirme yapılmaz.
 */

/** İmza uzunluğu (MD5'in ilk N hanesi). Üretici ve ayrıştırıcı AYNI sabiti kullanır. */
export const CONTENT_SIGNATURE_LENGTH = 10;

/** Dilimleyici/yazıcı uzantıları — ".gcode.3mf" gibi zincirler de geçerli. */
const EXT_CHAIN = /(\.(gcode|gco|g|3mf))+$/i;

/** "-<10 hane hex>" — uzantı(lar)dan hemen önce, adın SONUNDA. Ad zaten böyle bitiyorsa bile
 *  ileri-bakış son imzayı seçer (çift imza: "Foo-1234567890-8d28f87e04.gcode" → 8d28f87e04). */
const SIGNATURE_RE = new RegExp(
  `-([0-9a-f]{${CONTENT_SIGNATURE_LENGTH}})(?=(?:\\.(?:gcode|gco|g|3mf))*$)`,
  "i",
);

const TR_TO_ASCII: Record<string, string> = {
  "ç": "c", "Ç": "c", "ğ": "g", "Ğ": "g", "ı": "i", "İ": "i",
  "ö": "o", "Ö": "o", "ş": "s", "Ş": "s", "ü": "u", "Ü": "u",
};

/** Klasör önekini at (Moonraker "klasor/dosya.gcode", Bambu "/cache/dosya.3mf" raporlayabilir). */
export function fileBaseName(fn: string): string {
  return fn.replace(/^.*[/\\]/, "");
}

/**
 * Ada gömülü içerik imzasını çıkar (küçük harf hex) — yoksa null.
 * Yükleme adını BİZ ürettiysek imza vardır; elle atılmış eski dosyalarda yoktur.
 *
 * ⚠️ SALT RAKAMLI son ek imza SAYILMAZ. 10 haneli rakam da geçerli hex'tir; kullanıcının kendi
 * verdiği tarih/sayaç eki ("Kupa Altligi-2024010112.gcode") imza sanılıyor, hiçbir kayıt onu
 * doğrulayamadığı için ad eşleşmesi de REDDEDİLİYOR ve kartta 3B/önizleme sessizce kayboluyordu.
 * Kendi ürettiğimiz md5 ön eklerinin ~%99'u en az bir harf içerir; kalan nadir durumda dosya
 * imzasız kabul edilir ve eski (ad + tek-içerik) eşleşmesiyle bulunur.
 */
export function extractContentSignature(fn: string): string | null {
  const m = fileBaseName(fn).match(SIGNATURE_RE);
  if (!m) return null;
  const sig = m[1].toLowerCase();
  return /[a-f]/.test(sig) ? sig : null;
}

/**
 * İmzayı addan çıkar (gösterim adı üretenler için — imza son kullanıcıya gösterilmez).
 * Burada salt rakamlı son ek de atılır: `extractContentSignature`'dan farklı olmasının sebebi,
 * eşleştirme anahtarının İKİ TARAFTA da aynı biçimde sadeleşmesi gerektiğidir (kimlik kararı
 * `extractContentSignature`'a, ad normalizasyonu buraya bakar).
 */
export function stripContentSignature(fn: string): string {
  return fn.replace(SIGNATURE_RE, "");
}

/**
 * Yükleme adını üret: içerik kimliğini SON uzantıdan hemen önce, "-<10 hex>" biçiminde gömer.
 *   "Gövde.gcode"       + 8d28f87e04… → "Gövde-8d28f87e04.gcode"
 *   "Balerin.gcode.3mf" + 2f3a…       → "Balerin.gcode-2f3a1b4c5d.3mf"
 *   uzantısız "Gövde"   + 8d28f87e04… → "Gövde-8d28f87e04"
 * Biçim KARARLI: `extractContentSignature` bu adı (Bambu'nun ASCII'ye çevirdiği hâlini de)
 * geri ayrıştırabilir — Bambu `-` ve hex haneleri korur.
 */
export function buildSignedUploadName(originalName: string, md5: string): string {
  const h = md5.slice(0, CONTENT_SIGNATURE_LENGTH).toLowerCase();
  const m = originalName.match(/^(.*?)(\.[^.]+)$/);
  return m ? `${m[1]}-${h}${m[2]}` : `${originalName}-${h}`;
}

/**
 * Eşleştirme anahtarı: yol / imza / uzantı(lar) / plaka eki atılır, Türkçe ASCII'ye çevrilir,
 * harf-rakam dışındaki her şey silinir.
 *
 * Kritik: Bambu adı ASCII'ye çevirip boşluk/özel karakteri "_" yapıyor (Standı — Siyah →
 * Standi_Siyah). Yalnız küçük harfe çeviren eski normalize "standı" ≠ "standi" yüzünden
 * Bambu'yu HİÇ eşleyemiyordu (kartta 3D görünmüyordu).
 */
export function normalizeModelFileName(fn: string): string {
  let x = fileBaseName(fn);
  x = x.replace(SIGNATURE_RE, "");                      // içerik imzası
  x = x.replace(EXT_CHAIN, "");                         // uzantı(lar) (.gcode.3mf dahil)
  x = x.replace(/_plate_\d+$/i, "");                    // dilimleyici plaka eki
  x = x.replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_TO_ASCII[c] ?? c);
  return x.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Eşleştirmeye giren en küçük model kaydı (rota `select` ile yalnız bunları çeker). */
export interface ModelFileCandidate {
  id: string;
  originalName: string;
  contentMd5: string | null;
  /** Aynı fiziksel dosya varyantlara kopyalandığında satırlar farklı, içerik AYNIdır. */
  r2Key?: string | null;
  storedPath?: string | null;
}

export type MatchReason =
  | "signature"          // ada gömülü içerik imzası kayıtla birebir tuttu (KESİN)
  | "name"               // imzasız eski dosya — ad eşleşmesi
  | "empty"              // ad boş/anlamsız
  | "signature-mismatch" // imza var ama hiçbir kayıt doğrulamıyor → REDDET
  | "ambiguous"          // farklı içerikli birden çok aday → REDDET
  | "no-candidate";      // aday yok

export interface ModelMatch<T> {
  hit: T | null;
  reason: MatchReason;
}

/** İçerik kimliği: aynı dosyanın varyantlara kopyalanmış satırlarını TEK sayar. */
function contentIdentity(c: ModelFileCandidate): string {
  return c.contentMd5 || c.r2Key || c.storedPath || `row:${c.id}`;
}

/** Birden çok aday → hepsi AYNI içerikse hangisi gelirse gelsin aynı model; değilse belirsiz. */
function pickSingleContent<T extends ModelFileCandidate>(rows: readonly T[], target: string): T | null {
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return null;
  if (new Set(rows.map(contentIdentity)).size === 1) return rows[0];
  // Farklı içerikler var: adı birebir tutan tek bir içerik kaldıysa onu al, yoksa vazgeç.
  const byName = rows.filter((r) => normalizeModelFileName(r.originalName) === target);
  if (byName.length && new Set(byName.map(contentIdentity)).size === 1) return byName[0];
  return null;
}

/**
 * Yazıcının bildirdiği dosya adını model kayıtlarıyla eşle.
 *
 * Sıra:
 *  1. İMZA — adda imza varsa ve bir kaydın contentMd5'i o imzayla başlıyorsa eşleşme KESİN
 *     (ad tutmasa bile: içerik aynı dosyadır).
 *  2. İmza var ama hiçbir kayıt doğrulamıyorsa: md5'i BİLİNEN adaylar çürütülmüştür, elenir.
 *     Geriye md5'i hiç yazılmamış (dolayısıyla çürütülemeyen) aday kalırsa ad eşleşmesi sürer.
 *  3. İmza yoksa (eski dosyalar) düz ad eşleşmesi.
 * Her durumda farklı içerikli birden çok aday kalırsa eşleştirme YAPILMAZ.
 */
export function matchPrintedModel<T extends ModelFileCandidate>(
  reportedFilename: string,
  candidates: readonly T[],
): ModelMatch<T> {
  const target = normalizeModelFileName(reportedFilename);
  if (!target) return { hit: null, reason: "empty" };

  const sig = extractContentSignature(reportedFilename);
  if (sig) {
    const verified = candidates.filter((c) => (c.contentMd5 ?? "").toLowerCase().startsWith(sig));
    if (verified.length) {
      const hit = pickSingleContent(verified, target);
      return { hit, reason: hit ? "signature" : "ambiguous" };
    }
  }

  let named = candidates.filter((c) => normalizeModelFileName(c.originalName) === target);
  if (!named.length) return { hit: null, reason: sig ? "signature-mismatch" : "no-candidate" };
  if (sig) {
    named = named.filter((c) => !c.contentMd5);
    if (!named.length) return { hit: null, reason: "signature-mismatch" };
  }

  const hit = pickSingleContent(named, target);
  return { hit, reason: hit ? "name" : "ambiguous" };
}
