import { describe, expect, it } from "vitest";
import { bambuNesnePoligonlari, bambuNesneleriniCoz } from "./bambu-objects";

/**
 * Kullanıcının gerçek Bambu dosyalarından (23 Eyl 2026) alınan biçim. plate json'daki `id`
 * identify_id DEĞİL — eşleşme ad + sıra ile.
 */
const SLICE = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="12"/>
    <metadata key="label_object_enabled" value="true"/>
    <object identify_id="1702" name="Underbody.stl" skipped="false" />
    <object identify_id="3446" name="Orange lights" skipped="false" />
    <object identify_id="3468" name="Orange lights" skipped="false" />
  </plate>
</config>`;

const PLATE12 = JSON.stringify({
  bbox_objects: [
    { id: 3669, name: "Underbody.stl", bbox: [193, 27, 207, 235] },
    { id: 3670, name: "Orange lights", bbox: [155, 191, 192, 209] },
    { id: 3671, name: "Orange lights", bbox: [155, 134, 192, 152] },
  ],
});

describe("bambuNesneleriniCoz", () => {
  it("kimlik slice_info'dan, konum plate json'dan AD + SIRA ile eşlenir", () => {
    const b = bambuNesneleriniCoz(SLICE, {
      "Metadata/plate_5.json": JSON.stringify({ bbox_objects: [{ id: 1, name: "Underbody.stl", bbox: [0, 0, 1, 1] }] }),
      "Metadata/plate_12.json": PLATE12,
    });
    expect(b.etiketli).toBe(true);
    expect(b.plaka).toBe(12);
    expect(b.nesneler).toEqual([
      { id: 1702, ad: "Underbody.stl", bbox: [193, 27, 207, 235] },
      { id: 3446, ad: "Orange lights", bbox: [155, 191, 192, 209] },
      { id: 3468, ad: "Orange lights", bbox: [155, 134, 192, 152] },
    ]);
  });

  it("etiketleme kapalı dosya atlanamaz sayılır", () => {
    const b = bambuNesneleriniCoz(SLICE.replace('value="true"', 'value="false"'), { "Metadata/plate_12.json": PLATE12 });
    expect(b.etiketli).toBe(false);
  });

  it("slice_info yoksa boş", () => {
    expect(bambuNesneleriniCoz(null, {})).toEqual({ etiketli: false, plaka: null, nesneler: [] });
  });

  it("poligon: yazıcıya giden kimlik ad olarak taşınır, kutu dikdörtgene çevrilir", () => {
    const p = bambuNesnePoligonlari([{ id: 1702, ad: "Underbody.stl", bbox: [10, 20, 30, 60] }, { id: 9, ad: "x", bbox: null }]);
    expect(p).toEqual([
      { name: "1702", center: [20, 40], polygon: [[10, 20], [30, 20], [30, 60], [10, 60]] },
    ]);
  });
});
