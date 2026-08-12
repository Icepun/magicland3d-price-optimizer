/**
 * Baskı kartında GÖSTERİLECEK ad — dilimleyici artıklarından arındırılmış.
 *
 * Sahadan gerçek adlar (dört yazıcıdan canlı okundu):
 *   "EN4Plus 0.4 PS5+Dummy+Controller+Display Generic PLA 0.2 3h36m-65b2a0d971.gcode"
 *   "Darth Kol Gövde 2s1dk-8d28f87e04.gcode"
 *   "Dark Lord PS5 19s55dk-4c655543a7.gcode"
 *   "PISTON_CUP_P1S_plate_1.gcode-90b29c4d56.3mf"
 * Kullanıcı bunların hiçbirini okumak zorunda değil; kartta ürünün adı olmalı.
 *
 * ⚠️ Bu YALNIZ GÖSTERİM adıdır. Dosya kimliği (içerik imzası) ve eşleştirme anahtarı
 * (`fileMatchKey` / `normalizeModelFileName`) HAM addan üretilir ve buradan etkilenmez.
 */
import { fileBaseName, stripContentSignature } from "./print-file-signature";

/** Uzantı zinciri — ".gcode.3mf" gibi zincirler dahil, tek tek soyulur. */
const EXT_ONE = /\.(gcode|gco|g|3mf|bgcode)$/i;

/**
 * Dilimleyicinin süre eki: "3h36m", "19s55dk", "2s1dk", "45dk", "1d2h30m".
 *
 * TEK HARFLİ birim (d/h/m/s) YALNIZ birden çok grup art arda geldiğinde süre sayılır:
 * "3D", "2D", "5S", "1M" gibi ürün adı parçaları tek başına süre kalıbına uyuyor ve eleniyordu
 * ("3D Kalemlik" → "Kalemlik"). Tek gruplu süre yalnız tanıdık uzun ekle kabul edilir ("45dk").
 * Bunun bedeli "2h" gibi tek gruplu kısa eklerin adda kalması — yanlış eleme, kalan artıktan kötüdür.
 */
const TIME_UNIT = String.raw`(?:dk|sn|sa|saat|dakika|hr|min|[dhms])`;
const TIME_LONG_UNIT = String.raw`(?:dk|sn|sa|saat|dakika|hr|min)`;
const TIME_TOKEN = new RegExp(
  `^(?:(?:\\d+${TIME_UNIT}){2,}|\\d+${TIME_LONG_UNIT})$`,
  "i",
);

/** Ondalık sayı (nozzle çapı 0.4, katman yüksekliği 0.2) — dilimleyici artığı, HER ZAMAN elenir. */
const DECIMAL_TOKEN = /^\d+[.,]\d+$/;

/**
 * Tam sayı. Ürün adının parçası OLABİLİR ("Ejderha 2", "Kupa 350") — bu yüzden yalnız plaka
 * ekinin hemen ardından gelirse elenir ("… plate 1"). Koşulsuz elemek varyantları ayırt
 * edilemez hâle getiriyordu.
 */
const INTEGER_TOKEN = /^\d+$/;

/** Malzeme adı ve dilimleyici satıcı yer tutucuları. */
const MATERIAL_TOKEN =
  /^(?:generic|basic|matte|silk|tough|hyper|high\s*speed|pla|petg|pet|abs|asa|tpu|pva|hips|nylon|paht|pahtcf|pctpu)(?:[-+](?:cf|gf|gk|hf|st))?\+?$/i;

/** Plaka eki: "plate", "plate_1", "plaka2". */
const PLATE_TOKEN = /^(?:plate|plaka)_?\d*$/i;

/**
 * Yazıcı/profil kısaltmaları — ürün adında geçmesi pratikte imkânsız olanlar; nerede olursa
 * olsun elenir.
 */
const MODEL_TOKEN_SAFE =
  /^(?:en4(?:pro|plus|max)?|n4(?:pro|plus|max)?|neptune4?(?:pro|plus|max)?|elegoo|snapmaker|bambu|orca|prusa|cura|mk\d+s?|ender\d*)$/i;

/**
 * KISA yazıcı kodları ("A1", "U1", "P1S", "K2"…). Bunlar ürün adının parçası da olabilir
 * ("Robot A1", "Masa Standı U1") — koşulsuz elenince kullanıcı varyantı ayırt edemiyordu.
 * Yalnız yazıcı kodu olduğu YAPIDAN belli olduğunda elenir: adın başındaysa ya da hemen
 * ardından plaka eki geliyorsa (dilimleyici kalıbı: "<ad>_<yazıcı>_plate_1").
 */
const MODEL_TOKEN_SHORT = /^(?:a1m?|p1[sp]|x1[ce]?|h2d|u1|k1c?|k2)$/i;

/** Anlamsız kalıntı: "copy", "gcode". ("v2" ELENMEZ — ürün adındaki sürüm eki olabilir.) */
const JUNK_TOKEN = /^(?:copy|kopya|gcode|gco|3mf)$/i;

function stripExtensions(name: string): string {
  let s = name;
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(EXT_ONE, "");
    s = stripContentSignature(s);
    if (s === before) break;
  }
  return s;
}

/** Komşularıyla birlikte bakılır: bazı parçalar yalnız BULUNDUĞU YERDE artıktır. */
function isNoise(token: string, prev: string | undefined, next: string | undefined, index: number): boolean {
  if (TIME_TOKEN.test(token)) return true;
  if (DECIMAL_TOKEN.test(token)) return true;
  if (INTEGER_TOKEN.test(token)) return !!prev && PLATE_TOKEN.test(prev);
  if (MATERIAL_TOKEN.test(token)) return true;
  if (PLATE_TOKEN.test(token)) return true;
  if (MODEL_TOKEN_SAFE.test(token)) return true;
  if (MODEL_TOKEN_SHORT.test(token)) return index === 0 || (!!next && PLATE_TOKEN.test(next));
  return JUNK_TOKEN.test(token);
}

/**
 * Ham dosya adından okunabilir baskı adı üret.
 * Her şey elenirse ham ada geri düşülür — boş başlık göstermektense kirli ad daha iyidir.
 */
export function printJobDisplayName(rawFilename: string): string {
  if (!rawFilename || !rawFilename.trim()) return "";
  const base = stripExtensions(fileBaseName(rawFilename.trim()));

  // Ayırıcılar boşluğa: alt çizgi, artı, tire-boşluk. Nokta KORUNUR (0.4 tek parça kalsın).
  const tokens = base
    .replace(/[_+]+/g, " ")
    .replace(/\s*-\s*/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return base.trim();

  const kept = tokens.filter((t, i) => !isNoise(t, tokens[i - 1], tokens[i + 1], i));
  const out = (kept.length ? kept : tokens).join(" ").replace(/\s{2,}/g, " ").trim();
  return out || base.trim();
}
