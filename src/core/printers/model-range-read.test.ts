/**
 * ARALIKLI OKUMA: dosyanın TAMAMI indirilmeden meta/renk çıkar.
 *
 * Özel baskıda tarayıcı dosyayı buluta yükledikten sonra sunucu aynı baytları geri
 * indiriyordu — 25-140 MB'lık gcode'da kullanıcının "başlıyor…" ekranında beklediği
 * sürenin büyük kısmı buydu.
 *
 * Bu testin ölçtüğü şey doğrudan o: okuyucudan KAÇ BAYT istendiği. Bir gün biri tekrar
 * "kolay olsun" diye tüm nesneyi çekerse oran patlar ve test kırmızı yanar.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readModelBundleAralikli } from "./model-colors";

const SLICE_INFO = `<?xml version="1.0"?>
<config>
  <plate>
    <metadata key="prediction" value="7200"/>
    <filament id="1" type="PLA" color="#123456" used_g="20.5"/>
    <filament id="2" type="PLA" color="#ABCDEF" used_g="9.5"/>
  </plate>
</config>`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Buffer üzerinde HTTP Range semantiği + okunan bayt sayacı. */
function okuyucu(veri: Buffer) {
  let okunan = 0;
  return {
    oku: async (a: number, b: number): Promise<Buffer> => {
      const son = Math.min(b, veri.length - 1);
      const parca = veri.subarray(a, son + 1);
      okunan += parca.length;
      return parca;
    },
    okunanBayt: () => okunan,
  };
}

describe("readModelBundleAralikli — 3mf", () => {
  /**
   * Gcode kasten SIKIŞMAYAN veriyle doldurulur (~2 MB). Tekrarlı metin kullanılırsa zip
   * birkaç KB'a iniyor ve "dosyanın küçük bir kısmı okundu" ölçüsü anlamını yitiriyor —
   * gerçek dosyalarda gcode zip'in neredeyse tamamı.
   */
  const rastgele = (() => {
    let x = 123456789; // sabit tohum: test her koşuda aynı
    const b = Buffer.alloc(2_000_000);
    for (let i = 0; i < b.length; i++) {
      // Math.imul şart: düz çarpım 2^53'ü aşıp hassasiyet kaybediyor ve dizi kısa bir
      // döngüye düşüyor → veri sıkışıyor → test ölçmek istediği şeyi ölçemiyor.
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      b[i] = (x >>> 16) & 0xff;
    }
    return b;
  })();
  const zip = Buffer.from(
    zipSync({
      "Metadata/slice_info.config": strToU8(SLICE_INFO),
      "Metadata/plate_1.gcode": new Uint8Array(rastgele),
      "Metadata/plate_1.png": new Uint8Array(PNG),
      "Metadata/plate_2.png": new Uint8Array(PNG),
    }),
  );

  it("renk, gramaj ve süreyi config'ten okur", async () => {
    const r = okuyucu(zip);
    const p = await readModelBundleAralikli(r.oku, zip.length, "3mf");
    expect(p.colors.source).toBe("3mf-sliceinfo");
    expect(p.colors.colors.map((c) => c.hex)).toEqual(["#123456", "#ABCDEF"]);
    expect(p.meta.grams).toBe(30);
    expect(p.meta.estPrintMin).toBe(120);
    expect(p.sliced).toBe(true);
  });

  it("dosyanın küçük bir kısmını okur — tamamını DEĞİL", async () => {
    const r = okuyucu(zip);
    await readModelBundleAralikli(r.oku, zip.length, "3mf");
    // Zip dizini + iki küçük config + tek önizleme. Gcode hiç okunmaz.
    expect(r.okunanBayt()).toBeLessThan(zip.length * 0.2);
  });

  it("basılacak plakanın önizlemesini alır", async () => {
    const r = okuyucu(zip);
    const p = await readModelBundleAralikli(r.oku, zip.length, "3mf");
    expect(p.meta.thumbnail?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("bozuk/boş dosyada çökmez", async () => {
    const r = okuyucu(Buffer.from("bu bir zip değil"));
    const p = await readModelBundleAralikli(r.oku, 16, "3mf");
    expect(p.colors.colors).toEqual([]);
    expect(p.meta.grams).toBeNull();
  });
});

describe("readModelBundleAralikli — ham gcode", () => {
  it("baş ve son parçadan okur, ortasını hiç istemez", async () => {
    const bas = "; filament_colour = #00FF00\n; filament_type = PETG\n";
    const orta = "G1 X0 Y0\n".repeat(120_000); // ~1 MB dolgu
    const son = "; total filament used [g] = 42.5\n; estimated printing time = 1h 30m\n";
    const veri = Buffer.from(bas + orta + son, "latin1");
    const r = okuyucu(veri);

    const p = await readModelBundleAralikli(r.oku, veri.length, "gcode");
    expect(p.colors.colors.map((c) => c.hex)).toEqual(["#00FF00"]);
    expect(p.meta.grams).toBe(42.5);
    expect(p.meta.estPrintMin).toBe(90);
    expect(p.sliced).toBe(true);
    // 400 KB baş + 400 KB son; 1 MB'lık dosyanın tamamı değil.
    expect(r.okunanBayt()).toBeLessThan(veri.length);
  });

  it("küçük dosyada tek seferde okur", async () => {
    const veri = Buffer.from("; filament_colour = #0000FF\n; total filament used [g] = 3\n", "latin1");
    const r = okuyucu(veri);
    const p = await readModelBundleAralikli(r.oku, veri.length, "gcode");
    expect(p.colors.colors[0]?.hex).toBe("#0000FF");
    expect(p.meta.grams).toBe(3);
  });
});
