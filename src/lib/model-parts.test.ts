/**
 * Baskıdan önce dosyanın parça listesi — adlar yazıcının baskı sırasında göreceği adlarla AYNI olmalı.
 * Yerel dosyalarla (bulut yok) üç yol: komutlu G-code, yalnız yorumla etiketli G-code (yükleme
 * komutları ekleyecek → aynı adlar), etiketsiz dosya ve dosya/yazıcı türü uyuşmazlığı.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/r2", () => ({
  getR2Config: async () => null,
  getObjectBytes: vi.fn(),
  getObjectRange: vi.fn(),
}));

const { modelDosyaParcalari } = await import("./model-parts");

const dizin = fs.mkdtempSync(path.join(os.tmpdir(), "mlhub-parca-"));
afterAll(() => fs.rmSync(dizin, { recursive: true, force: true }));

let sayac = 0;
function dosya(icerik: string, ad = "parca.gcode") {
  const yol = path.join(dizin, `${++sayac}-${ad}`);
  fs.writeFileSync(yol, icerik, "utf8");
  return {
    id: `f${sayac}`, originalName: ad, fileType: ad.endsWith(".3mf") ? "3mf" : "gcode",
    sizeBytes: Buffer.byteLength(icerik), contentMd5: null, r2Key: null, storedPath: yol,
  };
}

describe("dosyadan parça listesi", () => {
  it("komutlu G-code: tanımlar dosyanın başından okunur", async () => {
    const mf = dosya([
      "; HEADER",
      "EXCLUDE_OBJECT_DEFINE NAME=kup_id_0 CENTER=50,50 POLYGON=[[40,40],[60,40],[60,60],[40,60]]",
      "EXCLUDE_OBJECT_DEFINE NAME=top_id_1 CENTER=150,50 POLYGON=[[140,40],[160,40],[160,60],[140,60]]",
      "PRINT_START",
      "G1 X10 Y10",
    ].join("\n"));
    const r = await modelDosyaParcalari(mf, false);
    expect(r.neden).toBeUndefined();
    expect(r.parts.map((p) => p.name)).toEqual(["kup_id_0", "top_id_1"]);
  });

  it("yalnız yorumla etiketli G-code: yüklemenin ekleyeceği adlar ve hareketlerden kutular", async () => {
    const mf = dosya([
      "G28",
      "; printing object Çiçek Saksı",
      "G1 X10 Y20 E1",
      "G1 X30 Y40 E1",
      "; stop printing object Çiçek Saksı",
      "; printing object kup",
      "G1 X100 Y100 E1",
      "G1 X120 Y110 E1",
      "; stop printing object kup",
    ].join("\n"));
    const r = await modelDosyaParcalari(mf, false);
    expect(r.parts.map((p) => p.name)).toEqual(["Çiçek Saksı", "kup"]);
    expect(r.parts[0].polygon).toEqual([[10, 20], [30, 20], [30, 40], [10, 40]]);
  });

  it("etiketsiz dosyada liste boş ve kullanıcıya nedeni söylenir", async () => {
    const r = await modelDosyaParcalari(dosya("G28\nG1 X10 Y10 E1\n"), false);
    expect(r.parts).toEqual([]);
    expect(r.neden).toMatch(/işaretlenmemiş/);
  });

  it("Bambu'ya ham G-code ya da U1'e 3MF: kimlikler bilinemez → seçim yok", async () => {
    const gcode = dosya("EXCLUDE_OBJECT_DEFINE NAME=a CENTER=1,1\nEXCLUDE_OBJECT_DEFINE NAME=b CENTER=9,9\n");
    expect((await modelDosyaParcalari(gcode, true)).parts).toEqual([]);
    const ucmf = dosya("PK", "parca.3mf");
    const r = await modelDosyaParcalari(ucmf, false);
    expect(r.parts).toEqual([]);
    expect(r.neden).toBeTruthy();
  });
});
