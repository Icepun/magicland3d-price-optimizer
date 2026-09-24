/**
 * PARÇA ETİKETLERİ — 3B parça seçicinin temeli: her şerit hangi parçaya ait?
 *
 * Yanlış eşleme = kullanıcı bir parçaya tıklar, yazıcı BAŞKA parçayı iptal eder. Biçimler
 * kullanıcının gerçek dosyalarından (24 Eyl 2026): Bambu "unique label id" yorumları (id =
 * identify_id), Orca'nın EXCLUDE_OBJECT komutları (+ yanında yorumlar), yalnız yorum yazan
 * dosyalar (komutu yükleme sırasında biz ekliyoruz).
 *
 * TELEFON: telefondaki 3B paketi biçim sürümünü sıkı denetliyor ve yalnız v3'ü tanıyor. Parça
 * bölümü sürüm artmadan dosyanın SONUNA eklendi; eski çözücü yeni paketi aynen okuyabilmeli.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { klipperAdOku, scanGcodeText } from "./parse-gcode";
import { PACK_VERSION, decodeVizPack, encodeVizPack, expandPack, type VizPack } from "./viz-pack";
import { parcalariEsle } from "./parca-esle";
import { buildParcaSahnesi, parcaCapalari } from "./parca-sahne";

/** (x0, y0) köşeli 10 mm'lik kare, 4 segment. */
function kare(x0: number, y0: number): string[] {
  return [
    `G0 X${x0} Y${y0}`,
    `G1 X${x0 + 10} Y${y0} E0.5`, `G1 X${x0 + 10} Y${y0 + 10} E0.5`,
    `G1 X${x0} Y${y0 + 10} E0.5`, `G1 X${x0} Y${y0} E0.5`,
  ];
}

function bambu(katman = 2): string {
  const s = ["M83", "G1 F1200"];
  for (let l = 0; l < katman; l++) {
    s.push(";LAYER_CHANGE", `;Z:${(0.2 * (l + 1)).toFixed(2)}`, `G0 Z${(0.2 * (l + 1)).toFixed(2)}`);
    if (l === 0) s.push(";TYPE:Skirt", ...kare(-20, -20)); // etek parça DIŞI
    s.push("; start printing object, unique label id: 281", "M624 BAAAAAAAAAA=", ";TYPE:Outer wall", ...kare(0, 0));
    s.push("; stop printing object, unique label id: 281", "M625");
    s.push("; start printing object, unique label id: 292", "M624 CAAAAAAAAAA=", ";TYPE:Outer wall", ...kare(40, 0));
    s.push("; stop printing object, unique label id: 292", "M625");
  }
  return s.join("\n") + "\n";
}

function orca(): string {
  const a = "pistone (1) (1).stl id:0 copy 0";
  const b = "pistone (1) (1).stl id:1 copy 0";
  return [
    "M83", "G1 F1200",
    "EXCLUDE_OBJECT_DEFINE NAME=PISTONE_1_1_ID_0_COPY_0 CENTER=5,5 POLYGON=[[0,0],[10,0],[10,10],[0,10]]",
    "EXCLUDE_OBJECT_DEFINE NAME=PISTONE_1_1_ID_1_COPY_0 CENTER=45,5 POLYGON=[[40,0],[50,0],[50,10],[40,10]]",
    ";LAYER_CHANGE", ";Z:0.2", "G0 Z0.2",
    `; printing object ${a}`, "EXCLUDE_OBJECT_START NAME=PISTONE_1_1_ID_0_COPY_0", ";TYPE:Outer wall", ...kare(0, 0),
    "EXCLUDE_OBJECT_END NAME=PISTONE_1_1_ID_0_COPY_0", `; stop printing object ${a}`,
    `; printing object ${b}`, "EXCLUDE_OBJECT_START NAME=PISTONE_1_1_ID_1_COPY_0", ";TYPE:Outer wall", ...kare(40, 0),
    "EXCLUDE_OBJECT_END NAME=PISTONE_1_1_ID_1_COPY_0", `; stop printing object ${b}`,
  ].join("\n") + "\n";
}

/** Yolun parçası (0 = parça dışı) — paketteki sırayla. */
function yolParcalari(p: VizPack): string[] {
  return Array.from(p.pathObject ?? [], (k) => (k ? p.objects![k - 1] : "-"));
}

describe("parça etiketleri", () => {
  it("Bambu: etiket numarası parça anahtarı (yazıcıya giden identify_id), etek parça dışı", () => {
    const p = scanGcodeText(bambu());
    expect(p.objects).toEqual(["281", "292"]);
    expect(yolParcalari(p)).toEqual(["-", "281", "292", "281", "292"]);
  });

  it("Orca: komut varken yanındaki yorum adları SAYILMAZ (aynı parça iki adla çıkmasın)", () => {
    const p = scanGcodeText(orca());
    expect(p.objects).toEqual(["PISTONE_1_1_ID_0_COPY_0", "PISTONE_1_1_ID_1_COPY_0"]);
    expect(yolParcalari(p)).toEqual(["PISTONE_1_1_ID_0_COPY_0", "PISTONE_1_1_ID_1_COPY_0"]);
  });

  it("DEFINE başlığı yoksa: yorumdan önce görülen ad sıkıştırmada atılır", () => {
    const p = scanGcodeText(orca().replace(/^EXCLUDE_OBJECT_DEFINE.*\n/gm, ""));
    expect(p.objects).toEqual(["PISTONE_1_1_ID_0_COPY_0", "PISTONE_1_1_ID_1_COPY_0"]);
  });

  it("yalnız yorum yazan dosya: yorumdaki tam ad (yüklemede komuta bu adla çevriliyor)", () => {
    const s = ["M83", ";LAYER_CHANGE", ";Z:0.2", "; printing object Octopus key holder.stl id:0 copy 0", ";TYPE:Outer wall",
      ...kare(0, 0), "; stop printing object Octopus key holder.stl id:0 copy 0"].join("\n");
    expect(scanGcodeText(s).objects).toEqual(["Octopus key holder.stl id:0 copy 0"]);
  });

  it("etiketsiz dosyada paket parçasız kalır (eski biçim birebir)", () => {
    const p = scanGcodeText(["M83", ";LAYER_CHANGE", ";Z:0.2", ";TYPE:Outer wall", ...kare(0, 0)].join("\n"));
    expect(p.objects).toBeUndefined();
    expect(p.pathObject).toBeUndefined();
    const buf = encodeVizPack(p);
    const uz = new DataView(buf).getUint32(4, true);
    expect(new TextDecoder().decode(new Uint8Array(buf, 8, uz))).not.toContain("objects");
  });

  it("Klipper adı: tırnaklı (boşluk, kesme, #) ve tırnaksız", () => {
    expect(klipperAdOku(" NAME=foo_1 ; yorum")).toBe("foo_1");
    expect(klipperAdOku(' NAME="Max\'s part #1"')).toBe("Max's part #1");
    expect(klipperAdOku(' NAME="a\\"b"')).toBe('a"b');
    expect(klipperAdOku(" CENTER=1,2")).toBeNull();
  });
});

describe("paket", () => {
  it("gidiş dönüşte parçalar korunur; açılmış geometride segment başına parça", () => {
    const p = scanGcodeText(bambu(3));
    const r = decodeVizPack(encodeVizPack(p));
    expect(r.objects).toEqual(["281", "292"]);
    expect(Array.from(r.pathObject!)).toEqual(Array.from(p.pathObject!));
    const g = expandPack(r);
    expect(g.objectKeys).toEqual(["281", "292"]);
    expect(g.objects!.length).toBe(g.totalSegments);
    // Katman 0: etek (4) + 281 (4) + 292 (4)
    expect(Array.from(g.objects!.subarray(0, 12))).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("TELEFON: v3 çözücü yeni paketi okur — biçim sürümü aynı, parça bölümü en sonda", () => {
    const p = scanGcodeText(bambu(3));
    const buf = encodeVizPack(p);
    const dv = new DataView(buf);
    const uz = dv.getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, uz)));
    expect(h.v).toBe(3);
    expect(PACK_VERSION).toBe(3);
    // Eski çözücünün birebir kopyası (parça bölümünü bilmez).
    const hizala = (n: number, a: number) => (n + a - 1) & ~(a - 1);
    let off = hizala(8 + uz, 8);
    const al = <T extends ArrayBufferView>(C: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }, n: number): T => {
      off = hizala(off, C.BYTES_PER_ELEMENT);
      const v = new C(buf, off, n);
      off += n * C.BYTES_PER_ELEMENT;
      return v;
    };
    const points = al(Uint16Array, h.pointCount * 2);
    al(Uint32Array, h.pathCount); al(Uint32Array, h.pathCount); al(Uint8Array, h.pathCount); al(Uint8Array, h.pathCount);
    const layerZ = al(Float32Array, h.layerCount);
    al(Uint32Array, h.layerCount); al(Uint32Array, h.layerCount); al(Float64Array, h.layerCount);
    al(Uint32Array, h.pathCount); al(Uint32Array, h.pathCount); al(Float32Array, h.pathCount);
    const pathTimeEnd = al(Float32Array, h.pathCount);
    expect(Array.from(points)).toEqual(Array.from(p.points));
    expect(Array.from(layerZ)).toEqual(Array.from(p.layerZ));
    expect(Array.from(pathTimeEnd)).toEqual(Array.from(p.pathTimeEnd));
    expect(off).toBeLessThanOrEqual(buf.byteLength); // parça bölümü bunun ARDINDA
  });
});

describe("eşleme (dosya ↔ yazıcı)", () => {
  it("Bambu: numara birebir", () => {
    const esle = parcalariEsle(
      [{ anahtar: "292", merkez: [45, 5] }, { anahtar: "281", merkez: [5, 5] }],
      [{ name: "281", center: [100, 100] }, { name: "292", center: [200, 200] }],
    );
    expect(esle).toEqual([1, 0]);
  });

  it("Klipper: ad büyük/küçük harf duyarsız (yazıcı adları büyük harfe çeviriyor)", () => {
    const esle = parcalariEsle(
      [{ anahtar: "pistone (1) (1).stl id:0 copy 0", merkez: [5, 5] }],
      [{ name: "PISTONE (1) (1).STL ID:0 COPY 0", center: [5, 5] }],
    );
    expect(esle).toEqual([0]);
  });

  it("ad tutmazsa yer: en yakın çiftler, birebir; tolerans dışı eşlenmez", () => {
    const esle = parcalariEsle(
      [{ anahtar: "a", merkez: [0, 0] }, { anahtar: "b", merkez: [50, 0] }, { anahtar: "c", merkez: [200, 200] }],
      [{ name: "X", center: [51, 1] }, { name: "Y", center: [1, 1] }],
    );
    expect(esle).toEqual([1, 0, -1]);
  });

  it("aynı ad birden çok parçadaysa ada güvenilmez, yere bakılır", () => {
    const esle = parcalariEsle(
      [{ anahtar: "ORANGE", merkez: [0, 0] }, { anahtar: "ORANGE", merkez: [60, 0] }],
      [{ name: "ORANGE", center: [60, 0] }, { name: "ORANGE", center: [0, 0] }],
    );
    expect(esle).toEqual([1, 0]);
  });
});

describe("pencereye bağlı (iyileştirme ekrana ulaşıyor mu?)", () => {
  const oku = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const pencere = oku("src/components/printers/PartCancelDialog.tsx");
  const kart = oku("src/app/printers/page.tsx");
  const worker = oku("src/lib/gcode-viz/gcode.worker.ts");
  const hat = oku("src/lib/gcode-viz/viz-pipeline.ts");

  it("kart basılan dosyanın 3B kaydını ve katmanı pencereye verir", () => {
    const cagri = kart.slice(kart.indexOf("<PartCancelDialog"), kart.indexOf("/>", kart.indexOf("<PartCancelDialog")));
    expect(cagri).toMatch(/model3d=\{viewer\}/);
    expect(cagri).toMatch(/katmanIdx=\{packLayerIndex\}/);
  });

  it("pencere parça etiketli geometriyle 3B seçiciyi kurar; tepeden görünüş yedek", () => {
    expect(pencere).toMatch(/loadGeometry\(modelAnahtar, modelDosya\)/);
    expect(pencere).toMatch(/g\.objects && g\.objectKeys\?\.length/);
    expect(pencere).toContain("<ParcaSecici3B");
    expect(pencere).toMatch(/onHata=\{\(\) => setUcHata\(true\)\}/);
    expect(pencere).toMatch(/ucGorunur \? "pointer-events-none opacity-0" : "opacity-100"/);
  });

  it("3B açıkken onay pencerenin içinde (seçili parça görünür kalır), değilse mini harita", () => {
    expect(pencere).toMatch(/onayda && seciliParca && ucGorunur/);
    expect(pencere).toMatch(/onayda && seciliParca && !ucGorunur/);
  });

  it("parça dizisi işçiden ana iş parçacığına taşınır", () => {
    expect(worker).toMatch(/objects: g\.objects\?\.buffer/);
    expect(hat).toMatch(/objects: new Uint16Array\(d\.objects\)/);
  });
});

/** three'nin programı derlerken yaptığını taklit et: gerçek şablon şaderine yamaları uygula. */
function derle(mat: THREE.Material, kaynak: { vertexShader: string; fragmentShader: string }) {
  const shader = { vertexShader: kaynak.vertexShader, fragmentShader: kaynak.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
  (mat.onBeforeCompile as unknown as (s: typeof shader, r: unknown) => void)(shader, null);
  return shader;
}

describe("seçici sahnesi", () => {
  const g = expandPack(scanGcodeText(bambu(3)));

  it("parça çapası: parçanın üst yüzeyinin ortası", () => {
    const c = parcaCapalari(g);
    expect(c.map((x) => x.anahtar)).toEqual(["281", "292"]);
    expect(c[0].merkez[0]).toBeCloseTo(5, 3);
    expect(c[1].merkez[0]).toBeCloseTo(45, 3);
    expect(c[0].z).toBeCloseTo(0.6, 3);
  });

  it("şader ekleri GERÇEKTEN uygulanıyor (katı, taslak, seçim geçişi)", () => {
    const s = buildParcaSahnesi(g);
    const mats = new Map<string, THREE.Material>();
    s.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      const k = m?.customProgramCacheKey?.();
      if (k?.includes("parca-v1")) mats.set(k.split("-").pop()!, m!);
    });
    expect([...mats.keys()].sort()).toEqual(["hayalet", "kati"]);
    const kati = derle(mats.get("kati")!, THREE.ShaderLib.standard);
    expect(kati.vertexShader).toContain("texelFetch( uNesneDurum");
    expect(kati.fragmentShader).toContain("uSecimRengi");
    expect(kati.uniforms.uNesneDurum).toBeTruthy();
    const hayalet = derle(mats.get("hayalet")!, THREE.ShaderLib.standard);
    expect(hayalet.fragmentShader).toContain("gVurgu");
    s.dispose();
  });

  it("parça etiketi olmayan dosyada sahne kurulmaz (eski görünüme düşülür)", () => {
    const eski = expandPack(scanGcodeText(["M83", ";LAYER_CHANGE", ";Z:0.2", ...kare(0, 0)].join("\n")));
    expect(() => buildParcaSahnesi(eski)).toThrow();
  });
});
