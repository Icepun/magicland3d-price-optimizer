/**
 * YAZICI AYRINTISI — masaüstünün yazdığı JSON'u telefon güvenle okuyabilmeli; katman hesabı
 * masaüstü paneliyle AYNI sayıyı vermeli.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOS_DETAY, dakikayaYuvarla, katmanTahmini, yaziciDetayOku, type YaziciDetay } from "./printer-detail";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("ayrıntı JSON'u", () => {
  it("yazılan okunur (gidiş-dönüş)", () => {
    const d: YaziciDetay = {
      ...BOS_DETAY,
      model: "U1",
      layer: 12,
      totalLayers: 340,
      startedAt: 1_790_000_040_000,
      nozzleTarget: 220,
      bedTarget: 60,
      heads: [
        { index: 0, temp: 219, target: 220, active: true },
        { index: 1, temp: 140, target: 140, active: false },
      ],
      speed: "%100",
      filamentType: "PLA",
      filamentGrams: 42,
      slots: [{ slot: 0, color: "#FF0000", type: "PLA", empty: false, active: true }],
      warnings: [{ code: null, level: "common", text: "Filament bitti" }],
      currentObject: "parca_1",
    };
    expect(yaziciDetayOku(JSON.stringify(d))).toEqual(d);
  });

  it("bozuk, boş ya da tanınmayan sürüm → null (ekran çökmez)", () => {
    expect(yaziciDetayOku(null)).toBeNull();
    expect(yaziciDetayOku("")).toBeNull();
    expect(yaziciDetayOku("{bozuk")).toBeNull();
    expect(yaziciDetayOku(JSON.stringify({ v: 2, layer: 3 }))).toBeNull();
    expect(yaziciDetayOku("42")).toBeNull();
  });

  it("eksik/yanlış tipli alanlar varsayılana düşer, uyarı seviyesi doğrulanır", () => {
    const d = yaziciDetayOku(JSON.stringify({
      v: 1, layer: "12", heads: [null, { temp: 200 }], warnings: [{ text: "x", level: "kıyamet" }, { text: "" }],
    }))!;
    expect(d.layer).toBeNull();
    expect(d.heads).toEqual([{ index: 0, temp: 200, target: 0, active: false }]);
    expect(d.warnings).toEqual([{ code: null, level: "common", text: "x" }]);
    expect(d.slots).toEqual([]);
  });
});

describe("3B alanları", () => {
  it("paket adresi yalnız https + anahtarla kabul edilir", () => {
    const d = (viz: unknown) => yaziciDetayOku(JSON.stringify({ v: 1, viz }))!.viz;
    expect(d({ url: "https://r2/viz/a.mlvz?sig", key: "viz/a.mlvz" })).toEqual({ url: "https://r2/viz/a.mlvz?sig", key: "viz/a.mlvz" });
    expect(d({ url: "http://192.168.1.5/a", key: "k" })).toBeNull(); // LAN adresi telefonda kırık olur
    expect(d({ url: "https://r2/a" })).toBeNull();
    expect(d("bozuk")).toBeNull();
  });

  it("plaka görseli https değilse düşer; canlı ölçüm ve takım renkleri doğrulanır", () => {
    const d = yaziciDetayOku(JSON.stringify({
      v: 1,
      plateUrl: "data:image/png;base64,AAAA",
      live: { filePosition: 1234, x: "5", y: 7, z: null },
      toolColors: ["#FF0000", "kırmızı", null, "#00ff00"],
    }))!;
    expect(d.plateUrl).toBeNull();
    expect(d.live).toEqual({ filePosition: 1234, x: null, y: 7, z: null });
    expect(d.toolColors).toEqual(["#FF0000", null, null, "#00ff00"]);
  });

  it("canlı ölçümün hepsi boşsa alan null", () => {
    expect(yaziciDetayOku(JSON.stringify({ v: 1, live: { filePosition: null } }))!.live).toBeNull();
  });
});

describe("katman tahmini — panelle aynı", () => {
  it("yazıcı söylüyorsa o", () => {
    expect(katmanTahmini({ current: 57, zHeight: 99, layerHeight: 0.2, firstLayerHeight: 0.2, total: 300 })).toBe(57);
  });
  it("söylemiyorsa Z'den: floor((z − ilk) / h) + 1, toplamla sınırlı", () => {
    expect(katmanTahmini({ current: null, zHeight: 2.0, layerHeight: 0.2, firstLayerHeight: 0.2, total: 300 })).toBe(10);
    expect(katmanTahmini({ current: 0, zHeight: 100, layerHeight: 0.2, firstLayerHeight: 0.3, total: 300 })).toBe(300);
  });
  it("hesaplanamıyorsa yazıcının değeri olduğu gibi", () => {
    expect(katmanTahmini({ current: null, zHeight: null, layerHeight: 0.2, firstLayerHeight: null, total: 10 })).toBeNull();
  });
  it("masaüstü paneli de aynı fonksiyonu kullanıyor", () => {
    const rota = fs.readFileSync(path.join(ROOT, "src/app/api/printers/route.ts"), "utf8");
    expect(rota).toContain("katmanTahmini({");
    expect(rota).not.toContain("Math.floor((st.zHeight - flh)");
  });
});

describe("başlangıç saati dakikaya yuvarlanır", () => {
  it("saniyelik oynama aynı değeri verir (her turda bulut yazması üretmez)", () => {
    const t = Date.UTC(2026, 8, 24, 10, 15, 0);
    expect(dakikayaYuvarla(t + 4_000)).toBe(dakikayaYuvarla(t - 3_000));
    expect(dakikayaYuvarla(null)).toBeNull();
    expect(dakikayaYuvarla(0)).toBeNull();
  });
});
