/**
 * `readModelBilgisi` — buluttaki dosyanın süresi, gramajı ve önizlemesi.
 *
 * İki şeyi kilitler:
 *  1) 3MF artık TAMAMI indirilmeden okunuyor (eskiden gramaj için bütün arşiv iniyordu).
 *  2) Önizleme görseli aynı okumadan çıkıyor — eski dosyaların küçük resmi böyle doluyor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

const depo = vi.hoisted(() => ({ veri: Buffer.alloc(0), aralikBayt: 0, tamIndirme: 0 }));

vi.mock("./r2", () => ({
  getR2Config: async () => ({ bucket: "test" }),
  getObjectSize: async () => depo.veri.length,
  getObjectRange: async (_k: string, _c: unknown, a: number, b: number) => {
    const parca = depo.veri.subarray(a, Math.min(b, depo.veri.length - 1) + 1);
    depo.aralikBayt += parca.length;
    return parca;
  },
  getObjectBytes: async () => {
    depo.tamIndirme += 1;
    return depo.veri;
  },
}));

import { GORSEL_SINIRI, readModelBilgisi, readModelOlcum, saklanabilirGorsel } from "./model-gramaj";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const SLICE_INFO = `<?xml version="1.0"?>
<config>
  <plate>
    <metadata key="prediction" value="7200"/>
    <filament id="1" type="PLA" color="#123456" used_g="20.5"/>
    <filament id="2" type="PLA" color="#ABCDEF" used_g="9.5"/>
  </plate>
</config>`;

/** Sıkışmayan ~1,5 MB gövde: gerçek dosyada gcode arşivin neredeyse tamamıdır. */
function sikismayan(n: number): Uint8Array {
  let x = 987654321;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    b[i] = (x >>> 16) & 0xff;
  }
  return b;
}

beforeEach(() => {
  depo.aralikBayt = 0;
  depo.tamIndirme = 0;
});

describe("readModelBilgisi — buluttaki 3MF", () => {
  const zip = Buffer.from(
    zipSync({
      "Metadata/slice_info.config": strToU8(SLICE_INFO),
      "Metadata/plate_1.gcode": sikismayan(1_500_000),
      "Metadata/plate_1.png": new Uint8Array(PNG),
    }),
  );

  it("süre, gramaj ve önizlemeyi dosyayı İNDİRMEDEN okur", async () => {
    depo.veri = zip;
    const b = await readModelBilgisi({ r2Key: "models/a.3mf", storedPath: "", fileType: "3mf" });
    expect(b.gramaj).toBe(30);
    expect(b.estPrintMin).toBe(120);
    expect(b.thumbnail).toMatch(/^data:image\/png;base64,/);
    expect(depo.tamIndirme).toBe(0);
    // Arşivin küçük bir kısmı: dizin + ayar dosyası + tek görsel.
    expect(depo.aralikBayt).toBeLessThan(zip.length * 0.2);
  });

  it("readModelOlcum aynı değerleri verir (Modeller sayfası bunu kullanıyor)", async () => {
    depo.veri = zip;
    expect(await readModelOlcum({ r2Key: "models/a.3mf", storedPath: "", fileType: "3mf" })).toEqual({
      gramaj: 30,
      estPrintMin: 120,
    });
  });

  it("dizini okunamayan arşivde tam indirmeye düşer, çökmez", async () => {
    depo.veri = Buffer.from("bu bir zip değil ".repeat(100));
    const b = await readModelBilgisi({ r2Key: "models/bozuk.3mf", storedPath: "", fileType: "3mf" });
    expect(b).toEqual({ gramaj: null, estPrintMin: null, thumbnail: null });
    expect(depo.tamIndirme).toBe(1);
  });
});

describe("readModelBilgisi — buluttaki gcode", () => {
  it("başlıktaki süre/gramaj ve gömülü görsel okunur", async () => {
    const b64 = PNG.toString("base64");
    depo.veri = Buffer.from(
      [
        "; thumbnail begin 48x48 " + b64.length,
        "; " + b64,
        "; thumbnail end",
        "G28",
        "; total filament used [g] = 84.21",
        "; estimated printing time (normal mode) = 2h 18m 5s",
      ].join("\n"),
      "latin1",
    );
    const b = await readModelBilgisi({ r2Key: "models/a.gcode", storedPath: "", fileType: "gcode" });
    expect(b.gramaj).toBe(84.2);
    expect(b.estPrintMin).toBe(138);
    expect(b.thumbnail).toBe(`data:image/png;base64,${b64}`);
    expect(depo.tamIndirme).toBe(0);
  });

  it("bilgi yazmayan dosyada hepsi null — sıfır DEĞİL", async () => {
    depo.veri = Buffer.from("G28\nG1 X10 Y10\n", "latin1");
    expect(await readModelBilgisi({ r2Key: "models/b.gcode", storedPath: "", fileType: "gcode" })).toEqual({
      gramaj: null,
      estPrintMin: null,
      thumbnail: null,
    });
  });
});

describe("saklanabilirGorsel", () => {
  it("yalnız geçerli ve makul boyutta görseli kabul eder", () => {
    expect(saklanabilirGorsel("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(saklanabilirGorsel("data:text/html;base64,AAAA")).toBeNull();
    expect(saklanabilirGorsel(null)).toBeNull();
    expect(saklanabilirGorsel(`data:image/png;base64,${"A".repeat(GORSEL_SINIRI)}`)).toBeNull();
  });
});
