/**
 * 3MF OKUMA: DOSYA BİR KEZ AÇILIR, GCODE HİÇ AÇILMAZ.
 *
 * Ölçüldü (20 Ağu 2026, özel baskı yavaşlığı): yükleme yolunda aynı dosya ÜÇ KEZ okunup
 * ÜÇ KEZ açılıyordu ve her açışta filtre — yorumunda "açma" yazmasına rağmen — plate gcode'unu
 * da çözüyordu: 1,6 MB'lık zip'ten 7,5 MB. Senkron olduğu için sunucunun olay döngüsü o süre
 * boyunca kapalıydı (25 MB'lık dosyada 1030 ms).
 *
 * TESTİN HİLESİ: gcode girdisinin sıkıştırılmış baytları BİLEREK bozuldu. Onu çözmeye kalkan
 * her kod patlar. Yani "renkler/meta/dilimli-mi doğru geldi" demek, "gcode'a hiç dokunulmadı"
 * demektir. Eski davranışa dönülürse bu dosya kırmızı yanar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8, unzipSync } from "fflate";
import { readModelBundle, readModelColors, readModelMeta, is3mfSliced } from "./model-colors";

const SLICE_INFO = `<?xml version="1.0"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="12.3"/>
    <filament id="2" type="PETG" color="#00FF00" used_g="4.7"/>
  </plate>
</config>`;

/** Küçük ama geçerli bir PNG (1x1 saydam). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let dizin = "";
let dosya = "";

/** Zip içindeki bir girdinin sıkıştırılmış gövdesini bozar (merkezi dizin sağlam kalır). */
function govdeyiBoz(zip: Uint8Array, ad: string): Uint8Array {
  const out = new Uint8Array(zip); // kopya
  const adBayt = strToU8(ad);
  for (let i = 0; i + 30 + adBayt.length < out.length; i++) {
    // Yerel başlık imzası: PK\x03\x04
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b || out[i + 2] !== 0x03 || out[i + 3] !== 0x04) continue;
    const adUz = out[i + 26] | (out[i + 27] << 8);
    const ekUz = out[i + 28] | (out[i + 29] << 8);
    if (adUz !== adBayt.length) continue;
    let esles = true;
    for (let j = 0; j < adUz; j++) if (out[i + 30 + j] !== adBayt[j]) { esles = false; break; }
    if (!esles) continue;
    const veriBas = i + 30 + adUz + ekUz;
    for (let j = 0; j < 96; j++) out[veriBas + 8 + j] ^= 0xff; // gövdeyi çöpe çevir
    return out;
  }
  throw new Error(`yerel başlık bulunamadı: ${ad}`);
}

beforeAll(() => {
  dizin = fs.mkdtempSync(path.join(os.tmpdir(), "mlhub-3mf-"));
  dosya = path.join(dizin, "ornek.3mf");
  // Gcode büyük ve tekrarlı: gerçek dosyadaki "küçük zip → dev gcode" oranını taklit eder.
  const gcode = "; filament_colour = #0000FF\n" + "G1 X1 Y1 E0.5\n".repeat(60_000);
  const ham = zipSync({
    "Metadata/slice_info.config": strToU8(SLICE_INFO),
    "Metadata/plate_1.gcode": strToU8(gcode),
    "Metadata/plate_1.png": new Uint8Array(PNG),
  });
  fs.writeFileSync(dosya, govdeyiBoz(ham, "Metadata/plate_1.gcode"));
});

afterAll(() => {
  fs.rmSync(dizin, { recursive: true, force: true });
});

describe("3mf: gcode gereksiz yere açılmaz", () => {
  it("gcode girdisi gerçekten bozuk — testin dayanağı bu", () => {
    const zip = fs.readFileSync(dosya);
    expect(() =>
      unzipSync(new Uint8Array(zip), { filter: (f) => /\.gcode$/i.test(f.name) }),
    ).toThrow();
  });

  it("renkler slice_info'dan gelir, gcode'a dokunulmaz", () => {
    const r = readModelColors(dosya);
    expect(r.source).toBe("3mf-sliceinfo");
    expect(r.colors.map((c) => c.hex)).toEqual(["#FF0000", "#00FF00"]);
  });

  it("gramaj, süre ve önizleme config'ten gelir", () => {
    const m = readModelMeta(dosya);
    expect(m.grams).toBe(17);
    expect(m.estPrintMin).toBe(60);
    expect(m.thumbnail?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("dilimlenmiş mi sorusu yalnız isimlere bakar", () => {
    expect(is3mfSliced(dosya)).toBe(true);
  });

  it("tek okuma paketi üç sonucu birden verir", () => {
    const b = readModelBundle(dosya);
    expect(b.colors.source).toBe("3mf-sliceinfo");
    expect(b.meta.grams).toBe(17);
    expect(b.sliced).toBe(true);
  });

  it("dosya yoksa çökmez, boş döner", () => {
    const b = readModelBundle(path.join(dizin, "yok.3mf"));
    expect(b.colors.colors).toEqual([]);
    expect(b.meta.grams).toBeNull();
    expect(b.sliced).toBeNull();
  });
});
