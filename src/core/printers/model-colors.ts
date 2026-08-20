/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Model dosyasından (gcode / 3mf) baskının kullandığı filament RENKLERİNİ okur.
 *
 * Amaç: çok renkli baskıda kullanıcıya Bambu Studio tarzı "şu rengi hangi slota"
 * seçtirmek — renk sayısını/renkleri ELLE değil, DOSYADAN almak.
 *
 * Kaynaklar:
 *  - .gcode (Bambu/Orca/Prusa/Klipper) başlık/altbilgi yorumları:
 *      "; filament_colour = #RRGGBB;#RRGGBB"   → renk listesi
 *      "; filament used [g] = a,b"             → kullanılan (0 olmayanlar)
 *      "; filament_type = PLA;PETG"
 *  - .3mf (zip):
 *      1) Metadata/slice_info.config (XML) → SADECE kullanılan filamentler:
 *         <filament id="1" type="PLA" color="#RRGGBB" used_g="12.3"/>
 *      2) Metadata/project_settings.config (JSON) → filament_colour[], filament_type[]
 *      3) Metadata/plate_*.gcode başlığı (yukarıdaki gcode mantığı)
 */
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { zipDizini, zipGirdiVerisi, type AralikOkuyucu } from "@/lib/slicer-preview";

export interface ModelColor {
  index: number; // dilimleyicideki 0-tabanlı filament sırası (T-index)
  hex: string; // #RRGGBB
  type: string; // PLA, PETG... ("" bilinmiyorsa)
  grams: number | null;
}
export type ColorSource = "gcode" | "3mf-sliceinfo" | "3mf-settings" | "3mf-gcode" | "none";
export interface ModelColorInfo {
  colors: ModelColor[];
  source: ColorSource;
  fileKind: "gcode" | "3mf" | "other";
}

function normHex(s: unknown): string | null {
  if (typeof s !== "string") return null;
  let h = s.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return `#${h.slice(0, 6).toUpperCase()}`; // RRGGBB[AA]
  return null;
}

function splitList(v: string): string[] {
  return v.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function headerValue(text: string, key: string): string | null {
  // "; key = value"  (boşluk toleranslı, satır bazlı, büyük/küçük harf duyarsız)
  const re = new RegExp(`^\\s*;\\s*${key}\\s*=\\s*(.+?)\\s*$`, "im");
  const m = text.match(re);
  return m ? m[1] : null;
}

/** Bir gcode metninden (başlık/altbilgi) kullanılan filament renklerini çıkar. */
export function parseGcodeText(text: string): ModelColor[] {
  const colourRaw =
    headerValue(text, "filament_colour") ||
    headerValue(text, "filament_color") ||
    headerValue(text, "extruder_colour") ||
    headerValue(text, "extruder_color");
  if (!colourRaw) return [];
  const hexes = splitList(colourRaw).map(normHex);

  const typeRaw = headerValue(text, "filament_type");
  const types = typeRaw ? splitList(typeRaw) : [];

  // [g] varsa GRAM olarak gösterilir; [mm]/[cm3] YALNIZ "kullanılmış mı" filtresi içindir —
  // eski hali mm/cm³ değerini grams alanına koyup UI'da "3241.7g" gösterebiliyordu.
  const usedG = headerValue(text, "filament used \\[g\\]");
  const usedRaw =
    usedG ||
    headerValue(text, "filament used \\[mm\\]") ||
    headerValue(text, "filament used \\[cm3\\]");
  const isGrams = !!usedG;
  const used = usedRaw ? splitList(usedRaw).map((x) => parseFloat(x.replace(/[^0-9.\-]/g, ""))) : [];
  const haveUsed = used.length > 0;

  const out: ModelColor[] = [];
  hexes.forEach((hex, i) => {
    if (!hex) return;
    const g = haveUsed ? (Number.isFinite(used[i]) ? used[i] : 0) : null;
    if (haveUsed && (g ?? 0) <= 0) return; // dilimde tanımlı ama basılmayan filamenti atla
    out.push({ index: i, hex, type: types[i] || "", grams: isGrams && g != null ? Math.round(g * 10) / 10 : null });
  });
  // Hiçbiri "used" filtresini geçemediyse (ör. tek renk, used=0 yazılmış) → ham listeyi döndür
  if (out.length === 0 && hexes.some(Boolean)) {
    hexes.forEach((hex, i) => { if (hex) out.push({ index: i, hex, type: types[i] || "", grams: null }); });
  }
  return out;
}


/**
 * 3MF'i açar ama GCODE'U AÇMAZ.
 *
 * Eski filtre yorumunda "dev plate gcode'unu açma" yazıyordu, oysa regex tam tersini yapıyor
 * ve 1,6 MB'lık bir zip'ten 7,5 MB gcode şişiriyordu — hem de dosya başına üç kez. Oysa gcode
 * yalnız SON ÇARE: renk/gramaj `.config` dosyalarından çıkmazsa bakılıyor. Artık `gcodeMetni()`
 * çağrılırsa açılır; tipik Bambu/Orca dosyasında hiç çağrılmaz.
 *
 * `adlar` her girdinin adını taşır (filtre her girdi için çağrılır) — plaka numarasını bulmak
 * ve "dilimlenmiş mi" sorusunu yanıtlamak için içeriğe gerek yok, isim yeter.
 */
interface Acilmis {
  files: Record<string, Uint8Array>;
  adlar: string[];
  gcodeMetni: () => string | null;
}

function ac3mf(buf: Buffer): Acilmis {
  const adlar: string[] = [];
  let files: Record<string, Uint8Array> = {};
  try {
    files = unzipSync(new Uint8Array(buf), {
      filter: (f) => {
        adlar.push(f.name);
        return /\.config$/i.test(f.name) || /Metadata\/.*\.png$/i.test(f.name);
      },
    });
  } catch { /* bozuk zip → boş küme, çağıranlar null döner */ }

  let gcodeCozuldu = false;
  let gcodeMetin: string | null = null;
  const gcodeMetni = (): string | null => {
    if (gcodeCozuldu) return gcodeMetin;
    gcodeCozuldu = true;
    const gad =
      adlar.find((k) => /Metadata\/.*plate.*\.gcode$/i.test(k)) ||
      adlar.find((k) => /\.gcode$/i.test(k));
    if (!gad) return null;
    try {
      const g = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === gad });
      // Başlık ve altbilgi yeter; tamamını metne çevirmek büyük dosyada boşuna yük.
      if (g[gad]) gcodeMetin = strFromU8(g[gad]).slice(0, 400_000);
    } catch { /* açılamadı → null */ }
    return gcodeMetin;
  };

  return { files, adlar, gcodeMetni };
}

/** Zip içinde gcode var mı? (içerik açılmaz) */
function acikDilimli(a: Acilmis): boolean {
  return a.adlar.some((k) => /Metadata\/.*plate.*\.gcode$/i.test(k) || /\.gcode$/i.test(k));
}

function parse3mfAcik(a: Acilmis): { colors: ModelColor[]; source: ColorSource } {
  const files = a.files;
  const readByRx = (rx: RegExp): string | null => {
    const key = Object.keys(files).find((k) => rx.test(k));
    return key ? strFromU8(files[key]) : null;
  };

  // 1) slice_info.config — yalnızca KULLANILAN filamentler (en güvenilir)
  const sliceInfo = readByRx(/slice_info\.config$/i);
  if (sliceInfo) {
    const colors: ModelColor[] = [];
    const re = /<filament\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sliceInfo))) {
      const tag = m[0];
      const id = /\bid\s*=\s*"(\d+)"/i.exec(tag)?.[1];
      const hex = normHex(/\bcolou?r\s*=\s*"([^"]+)"/i.exec(tag)?.[1]);
      const type = /\btype\s*=\s*"([^"]+)"/i.exec(tag)?.[1] || "";
      const g = parseFloat(/\bused_g\s*=\s*"([^"]+)"/i.exec(tag)?.[1] || "");
      if (hex) {
        colors.push({
          index: id ? Math.max(0, parseInt(id, 10) - 1) : colors.length,
          hex, type, grams: Number.isFinite(g) ? Math.round(g * 10) / 10 : null,
        });
      }
    }
    if (colors.length) return { colors, source: "3mf-sliceinfo" };
  }

  // 2) project_settings.config — JSON filament_colour[] (tüm tanımlı filamentler)
  const proj = readByRx(/project_settings\.config$/i);
  if (proj) {
    try {
      const j: any = JSON.parse(proj);
      const cols: unknown[] = Array.isArray(j.filament_colour) ? j.filament_colour : [];
      const types: unknown[] = Array.isArray(j.filament_type) ? j.filament_type : [];
      const colors: ModelColor[] = [];
      cols.forEach((c, i) => {
        const h = normHex(c);
        if (h) colors.push({ index: i, hex: h, type: typeof types[i] === "string" ? (types[i] as string) : "", grams: null });
      });
      if (colors.length) return { colors, source: "3mf-settings" };
    } catch { /* yoksay */ }
  }

  // 3) gömülü plate gcode başlığı — BURADA açılır, daha önce değil
  const gmetin = a.gcodeMetni();
  if (gmetin) {
    const colors = parseGcodeText(gmetin);
    if (colors.length) return { colors, source: "3mf-gcode" };
  }

  return { colors: [], source: "none" };
}

/** Dosyanın baş ve son N baytını birleştirip metin döndürür (büyük gcode'u tümüyle yüklemeden). */
function readHeadTail(filePath: string, n: number): string {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  try {
    if (size <= n * 2) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("latin1");
    }
    const head = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    const tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    return `${head.toString("latin1")}\n${tail.toString("latin1")}`;
  } finally {
    fs.closeSync(fd);
  }
}

/** Bir model dosyasının (gcode/3mf) kullandığı filament renklerini oku. */
/**
 * TEK OKUMA, TEK AÇMA — yükleme yolunda aynı dosya ÜÇ KEZ okunup ÜÇ KEZ açılıyordu.
 *
 * Ölçüldü (20 Ağu 2026): 1,9 MB'ta 104 ms, 25 MB'ta 1030 ms — ve bu süre boyunca Next
 * sunucusunun olay döngüsü tamamen duruyor, yani o an akan yazıcı yoklaması da yükleme
 * ilerlemesi de donuyor. Üç iş de aynı tampondan çözülebiliyor.
 */
export function readModelBundle(filePath: string): {
  colors: ModelColorInfo;
  meta: ModelMeta;
  sliced: boolean | null;
} {
  const lower = filePath.toLowerCase();
  const is3mf = lower.endsWith(".3mf");
  if (!is3mf) {
    // gcode yolunda zaten yalnız baş/kuyruk okunuyor — dosya belleğe alınmıyor.
    return { colors: readModelColors(filePath), meta: readModelMeta(filePath), sliced: true };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return {
      colors: { colors: [], source: "none", fileKind: "3mf" },
      meta: { grams: null, estPrintMin: null, thumbnail: null },
      sliced: null,
    };
  }
  const a = ac3mf(buf); // TEK açma — üç sonuç da bundan çıkar
  let colors: ModelColorInfo;
  try {
    const r = parse3mfAcik(a);
    colors = { colors: r.colors, source: r.source, fileKind: "3mf" };
  } catch {
    colors = { colors: [], source: "none", fileKind: "3mf" };
  }
  let meta: ModelMeta;
  try {
    meta = meta3mfAcik(a);
  } catch {
    meta = { grams: null, estPrintMin: null, thumbnail: null };
  }
  let sliced: boolean | null = null;
  try { sliced = acikDilimli(a); } catch { /* bilinmiyor → null, çağıran tembel yola düşer */ }
  return { colors, meta, sliced };
}

/**
 * ARALIKLI OKUMA — dosyayı İNDİRMEDEN meta/renk çıkarır.
 *
 * Özel baskıda tarayıcı dosyayı doğrudan buluta yüklüyor, sonra sunucu aynı dosyanın TAMAMINI
 * geri indirip sadece gramaj/süre/renk okuyordu. 25-140 MB'lık bir gcode'da bu, kullanıcının
 * "başlıyor…" ekranında beklediği onlarca saniyenin ta kendisiydi.
 *
 * Gerçekte gereken: gcode'un ilk/son birkaç yüz KB'ı, ya da 3MF'in dizini + iki küçük config.
 */
export async function readModelBundleAralikli(
  oku: AralikOkuyucu,
  toplamBoyut: number,
  fileType: string,
): Promise<{ colors: ModelColorInfo; meta: ModelMeta; sliced: boolean | null }> {
  const bos = {
    colors: { colors: [], source: "none", fileKind: "other" } as ModelColorInfo,
    meta: { grams: null, estPrintMin: null, thumbnail: null } as ModelMeta,
    sliced: null as boolean | null,
  };
  if (toplamBoyut <= 0) return bos;

  if (fileType !== "3mf") {
    // Ham gcode: başlık + altbilgi yeter (yerel `readHeadTail` ile aynı mantık).
    const N = 400_000;
    let metin: string;
    if (toplamBoyut <= N * 2) {
      metin = (await oku(0, toplamBoyut - 1)).toString("latin1");
    } else {
      const [bas, son] = await Promise.all([
        oku(0, N - 1),
        oku(toplamBoyut - N, toplamBoyut - 1),
      ]);
      metin = `${bas.toString("latin1")}\n${son.toString("latin1")}`;
    }
    const colors = parseGcodeText(metin);
    return {
      colors: { colors, source: colors.length ? "gcode" : "none", fileKind: "gcode" },
      meta: gcodeMeta(metin),
      sliced: true,
    };
  }

  const girdiler = await zipDizini(oku, toplamBoyut);
  if (!girdiler) return { ...bos, colors: { colors: [], source: "none", fileKind: "3mf" } };

  const adlar = girdiler.map((g) => g.ad);
  const files: Record<string, Uint8Array> = {};

  // Küçük config dosyaları — renk ve gramajın asıl kaynağı.
  for (const g of girdiler) {
    if (!/\.config$/i.test(g.ad)) continue;
    const v = await zipGirdiVerisi(oku, g);
    if (v) files[g.ad] = new Uint8Array(v);
  }

  // Önizleme: yalnız BASILACAK plakanın görseli indirilir, hepsi değil.
  const plakaNo = adlar.map((k) => /Metadata\/plate_(\d+)\.gcode$/i.exec(k)?.[1]).find((x): x is string => !!x);
  const pngler = girdiler.filter((g) => /Metadata\/.*\.png$/i.test(g.ad));
  const secilenPng =
    (plakaNo ? pngler.find((g) => new RegExp(`plate_${plakaNo}\.png$`, "i").test(g.ad)) : undefined) ||
    pngler.find((g) => /plate_1\.png$/i.test(g.ad)) ||
    pngler.filter((g) => !/small/i.test(g.ad)).sort((a, b) => b.sikisikBoyut - a.sikisikBoyut)[0] ||
    pngler[0];
  if (secilenPng) {
    const v = await zipGirdiVerisi(oku, secilenPng);
    if (v) files[secilenPng.ad] = new Uint8Array(v);
  }

  // Gcode SON ÇARE: config'ler yanıt vermezse, o zaman da yalnız başlığı çözülür.
  let gcodeCozuldu = false;
  let gcodeMetin: string | null = null;
  const gcodeMetni = (): string | null => {
    if (gcodeCozuldu) return gcodeMetin;
    gcodeCozuldu = true;
    const g =
      girdiler.find((x) => /Metadata\/.*plate.*\.gcode$/i.test(x.ad)) ||
      girdiler.find((x) => /\.gcode$/i.test(x.ad));
    if (!g) return null;
    /**
     * ⚠️ SENKRON DEĞİL: aralıklı okuma ağ gerektiriyor, oysa `parse3mfAcik`/`meta3mfAcik`
     * senkron bir `gcodeMetni()` bekliyor. Bu yüzden gcode aşağıda ÖNDEN çözülüyor ve burada
     * yalnız hazır metin döndürülüyor.
     */
    return gcodeMetin;
  };

  const a: Acilmis = { files, adlar, gcodeMetni };
  let sonuc = { colors: parse3mfAcik(a), meta: meta3mfAcik(a) };

  // Config'ler yetmediyse gcode başlığını da çek ve BİR KEZ daha çöz.
  const eksik =
    !sonuc.colors.colors.length || sonuc.meta.grams == null || sonuc.meta.estPrintMin == null;
  if (eksik) {
    const g =
      girdiler.find((x) => /Metadata\/.*plate.*\.gcode$/i.test(x.ad)) ||
      girdiler.find((x) => /\.gcode$/i.test(x.ad));
    if (g) {
      const v = await zipGirdiVerisi(oku, g, 400_000);
      if (v) {
        gcodeMetin = v.toString("latin1");
        gcodeCozuldu = true;
        sonuc = { colors: parse3mfAcik(a), meta: meta3mfAcik(a) };
      }
    }
  }

  return {
    colors: { colors: sonuc.colors.colors, source: sonuc.colors.source, fileKind: "3mf" },
    meta: sonuc.meta,
    sliced: adlar.some((k) => /Metadata\/.*plate.*\.gcode$/i.test(k) || /\.gcode$/i.test(k)),
  };
}

export function readModelColors(filePath: string): ModelColorInfo {
  const lower = filePath.toLowerCase();
  const is3mf = lower.endsWith(".3mf"); // .gcode.3mf dahil
  const isGcode = !is3mf && /\.(gcode|gco|g)$/i.test(lower);
  try {
    if (is3mf) {
      const r = parse3mfAcik(ac3mf(fs.readFileSync(filePath)));
      return { colors: r.colors, source: r.source, fileKind: "3mf" };
    }
    if (isGcode) {
      const colors = parseGcodeText(readHeadTail(filePath, 350_000));
      return { colors, source: colors.length ? "gcode" : "none", fileKind: "gcode" };
    }
  } catch { /* none döner */ }
  return { colors: [], source: "none", fileKind: is3mf ? "3mf" : isGcode ? "gcode" : "other" };
}

// ── Baskı meta verisi (süre / gramaj / önizleme) — özel baskı ekranı için ──────────────
export interface ModelMeta {
  grams: number | null; // toplam kullanılan filament (g)
  estPrintMin: number | null; // tahmini baskı süresi (dakika)
  thumbnail: string | null; // data URL (PNG önizleme)
}

function parseTimeToMin(s: string): number | null {
  let total = 0;
  let found = false;
  const h = /(\d+)\s*h/i.exec(s);
  if (h) { total += Number(h[1]) * 60; found = true; }
  const m = /(\d+)\s*m(?:in)?\b/i.exec(s);
  if (m) { total += Number(m[1]); found = true; }
  const sec = /(\d+)\s*s\b/i.exec(s);
  if (sec) { total += Number(sec[1]) / 60; found = true; }
  return found ? Math.max(1, Math.round(total)) : null;
}

/** gcode başlığındaki gömülü PNG önizlemeyi (en büyüğünü) data URL olarak çıkar. */
function gcodeThumbnail(text: string): string | null {
  const re = /;\s*thumbnail\s+begin\s+(\d+)x(\d+)\s+\d+\s*([\s\S]*?);\s*thumbnail\s+end/gi;
  let best: { area: number; b64: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const area = Number(m[1]) * Number(m[2]);
    const b64 = m[3].replace(/^\s*;/gm, "").replace(/\s+/g, "");
    if (b64 && (!best || area > best.area)) best = { area, b64 };
  }
  return best ? `data:image/png;base64,${best.b64}` : null;
}

/** Gcode başlık/altbilgi metninden meta çıkar — aralıklı okumayla beslenebilsin diye dışa açık. */
export function gcodeMeta(text: string): ModelMeta {
  let grams: number | null = null;
  const tot = headerValue(text, "total filament used \\[g\\]");
  if (tot) { const g = parseFloat(tot); if (Number.isFinite(g)) grams = Math.round(g * 10) / 10; }
  if (grams == null) {
    const used = headerValue(text, "filament used \\[g\\]");
    if (used) {
      const sum = splitList(used).map((x) => parseFloat(x)).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
      if (sum > 0) grams = Math.round(sum * 10) / 10;
    }
  }
  const t =
    headerValue(text, "estimated printing time \\(normal mode\\)") ||
    headerValue(text, "estimated printing time") ||
    headerValue(text, "model printing time") ||
    headerValue(text, "total estimated time");
  return { grams, estPrintMin: t ? parseTimeToMin(t) : null, thumbnail: gcodeThumbnail(text) };
}

function meta3mfAcik(a: Acilmis): ModelMeta {
  const files = a.files;
  let grams: number | null = null;
  let estPrintMin: number | null = null;
  let thumbnail: string | null = null;

  const sliceKey = Object.keys(files).find((k) => /slice_info\.config$/i.test(k));
  if (sliceKey) {
    const xml = strFromU8(files[sliceKey]);
    const usedG = [...xml.matchAll(/used_g\s*=\s*"([^"]+)"/gi)].map((m) => parseFloat(m[1])).filter((n) => Number.isFinite(n));
    if (usedG.length) grams = Math.round(usedG.reduce((a, b) => a + b, 0) * 10) / 10;
    const pred = /(?:prediction|time)\s*=\s*"(\d+)"/i.exec(xml) || /key\s*=\s*"prediction"\s+value\s*=\s*"(\d+)"/i.exec(xml);
    if (pred) estPrintMin = Math.max(1, Math.round(Number(pred[1]) / 60));
  }

  const pngKeys = Object.keys(files).filter((k) => /Metadata\/.*\.png$/i.test(k));
  if (pngKeys.length) {
    /**
     * Dosyada projedeki BÜTÜN plakaların görseli var, ama basılacak gcode yalnız birinden.
     * `plate_1` sabiti gerçek dosyalarda 157 baskının 21'inde başka bir parçanın resmini
     * getiriyordu. Önce gcode'un plakasını bul.
     */
    const plakaNo = a.adlar
      .map((k) => /Metadata\/plate_(\d+)\.gcode$/i.exec(k)?.[1])
      .find((x): x is string => !!x);
    const key =
      (plakaNo ? pngKeys.find((k) => new RegExp(`plate_${plakaNo}\\.png$`, "i").test(k)) : undefined) ||
      pngKeys.find((k) => /plate_1\.png$/i.test(k)) ||
      pngKeys.sort((a, b) => files[b].length - files[a].length)[0];
    thumbnail = `data:image/png;base64,${Buffer.from(files[key]).toString("base64")}`;
  }

  if (estPrintMin == null || grams == null) {
    const gmetin = a.gcodeMetni(); // ancak burada açılır
    if (gmetin) {
      const gm = gcodeMeta(gmetin);
      estPrintMin = estPrintMin ?? gm.estPrintMin;
      grams = grams ?? gm.grams;
    }
  }
  return { grams, estPrintMin, thumbnail };
}

/**
 * Bambu baskı için: .3mf içindeki GERÇEK plate gcode yolu + PROJEDEKİ TOPLAM filament sayısı.
 * BambuStudio ams_mapping'i TÜM proje filamentleri üzerinden (kullanılmayan = -1) ve plate
 * param'ını gerçek dosya adıyla gönderir. Biz de aynısını yapmalıyız, yoksa A1 reddeder.
 */
export function readBambuPrintMeta(filePath: string): { plateParam: string; filamentCount: number } {
  const def = { plateParam: "Metadata/plate_1.gcode", filamentCount: 0 };
  const lower = filePath.toLowerCase();
  const countFromHeader = (text: string): number => {
    const raw =
      headerValue(text, "filament_colour") || headerValue(text, "filament_color") ||
      headerValue(text, "extruder_colour") || headerValue(text, "extruder_color");
    return raw ? splitList(raw).filter((x) => normHex(x)).length : 0;
  };
  try {
    if (lower.endsWith(".3mf")) {
      const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)), {
        filter: (f) => /\.config$/i.test(f.name) || /Metadata\/.*plate.*\.gcode$/i.test(f.name),
      });
      const gkey =
        Object.keys(files).find((k) => /Metadata\/plate_\d+\.gcode$/i.test(k)) ||
        Object.keys(files).find((k) => /Metadata\/.*plate.*\.gcode$/i.test(k));
      const plateParam = gkey || def.plateParam;
      let filamentCount = 0;
      const projKey = Object.keys(files).find((k) => /project_settings\.config$/i.test(k));
      if (projKey) {
        try {
          const j = JSON.parse(strFromU8(files[projKey]));
          if (Array.isArray(j.filament_colour)) filamentCount = j.filament_colour.length;
        } catch { /* yoksay */ }
      }
      if (!filamentCount && gkey) filamentCount = countFromHeader(strFromU8(files[gkey]).slice(0, 200_000));
      return { plateParam, filamentCount };
    }
    return { plateParam: def.plateParam, filamentCount: countFromHeader(readHeadTail(filePath, 200_000)) };
  } catch {
    return def;
  }
}

/** Bir model dosyasının baskı meta verisi: toplam gramaj + süre + önizleme görseli. */
export function readModelMeta(filePath: string): ModelMeta {
  const lower = filePath.toLowerCase();
  const is3mf = lower.endsWith(".3mf");
  const isGcode = !is3mf && /\.(gcode|gco|g)$/i.test(lower);
  try {
    if (is3mf) return meta3mfAcik(ac3mf(fs.readFileSync(filePath)));
    if (isGcode) return gcodeMeta(readHeadTail(filePath, 400_000));
  } catch { /* boş döner */ }
  return { grams: null, estPrintMin: null, thumbnail: null };
}

/**
 * Dosya gerçekten DİLİMLENMİŞ bir Bambu/Orca 3MF mi? (içinde Metadata/plate_*.gcode var mı)
 * STL/OBJ veya unsliced 3MF → false. .gcode dosyaları zaten dilimli sayılır (true).
 */
export function is3mfSliced(filePath: string): boolean {
  const low = filePath.toLowerCase();
  if (/\.(gcode|gco|g)$/.test(low) && !low.endsWith(".3mf")) return true; // ham gcode = dilimli
  if (!low.endsWith(".3mf")) return false; // .stl/.obj vb. dilimli değil
  try {
    // Yalnız "içinde gcode VAR MI" sorusu — içerik açılmaz.
    return acikDilimli(ac3mf(fs.readFileSync(filePath)));
  } catch {
    return false;
  }
}
