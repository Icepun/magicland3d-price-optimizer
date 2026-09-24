/**
 * TELEFONA 3B AKTARICISI — saf yardımcılar ve yapısal güvenceler.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACK_VERSION } from "@/lib/gcode-viz/viz-pack";
import { veriAdresiniCoz, vizNesneAnahtari } from "./viz-relay";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("R2 anahtarı", () => {
  it("içerik özetinden + paket biçim sürümüyle (biçim değişince yeniden yüklenir)", () => {
    const k = vizNesneAnahtari({ id: "m1", contentMd5: "ad098259bb0123456789abcdef012345", sizeBytes: 10 });
    expect(k).toBe(`viz/md5-ad098259bb-v${PACK_VERSION}.mlvz`);
  });

  it("özeti olmayan dosya kimlik + boyutla ayrışır", () => {
    expect(vizNesneAnahtari({ id: "m1", contentMd5: null, sizeBytes: 42 })).toBe(`viz/file-m1-42-v${PACK_VERSION}.mlvz`);
  });

  it("öneki depo hademesinin sildiği model önekleriyle KARIŞMAZ", () => {
    const k = vizNesneAnahtari({ id: "m1", contentMd5: null, sizeBytes: 1 });
    expect(k.startsWith("models/") || k.startsWith("meshes/")).toBe(false);
  });
});

describe("plaka görseli (veri adresi → bayt)", () => {
  it("png ve jpeg çözülür", () => {
    const png = veriAdresiniCoz(`data:image/png;base64,${Buffer.from("merhaba").toString("base64")}`);
    expect(png?.tur).toBe("image/png");
    expect(png?.uzanti).toBe("png");
    expect(png?.bayt.toString()).toBe("merhaba");
    expect(veriAdresiniCoz("data:image/jpeg;base64,QUJD")?.uzanti).toBe("jpg");
  });

  it("görsel olmayan ya da bozuk değer null", () => {
    expect(veriAdresiniCoz(null)).toBeNull();
    expect(veriAdresiniCoz("")).toBeNull();
    expect(veriAdresiniCoz("https://cdn.example.com/a.png")).toBeNull();
    expect(veriAdresiniCoz("data:text/html;base64,PGh0bWw+")).toBeNull();
  });
});

describe("yapısal güvenceler", () => {
  const kaynak = oku("src/core/printers/viz-relay.ts");
  const relay = oku("src/core/printers/relay.ts");

  it("relay turu 3B hazırlığını BEKLEMEZ (senkron durum, kuyrukta hazırlık)", () => {
    expect(kaynak).toMatch(/export function vizDurumu\([^)]*\): VizDurumu \{/);
    expect(relay).toContain("...(isVar ? vizDurumu(c.id, bs.filename) : {})");
    expect(relay).toContain("...(isVar ? vizDurumu(c.id, st.filename) : {})");
  });

  it("paket sıkıştırılıp `Content-Encoding: gzip` ile konur (WebView kendisi açar)", () => {
    expect(kaynak).toContain('contentEncoding: "gzip"');
  });

  it("çok büyük paket telefona gönderilmez", () => {
    expect(kaynak).toContain("paket.bytes.byteLength <= AZAMI_PAKET_BAYT");
  });

  it("masaüstü paneli ve aktarıcı aynı eşleştirme + renk + katman fonksiyonlarını kullanır", () => {
    expect(oku("src/app/api/printers/[id]/print-model/route.ts")).toContain("resolvePrintModel(");
    expect(kaynak).toContain("resolvePrintModel(");
    expect(oku("src/app/printers/panel-controls.ts")).toContain('export { slotToolColors } from "@/core/printers/tool-colors";');
    expect(oku("src/app/printers/panel-view.ts")).toContain('export { resolvePackLayerIndex } from "@/lib/gcode-viz/canli-konum";');
  });
});
