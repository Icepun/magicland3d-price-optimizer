/**
 * Sunucu paket üreticisi — .3mf AKIŞLA çözülür, "çok büyük" dosya bir kez işaretlenip bir daha
 * taranmaz. 29 Eyl 2026: 106 MB'lık .3mf (425 MB gcode) eski üreticide tümüyle belleğe açılıyor ve
 * tarama saatlerce sürerek uygulamanın tamamını donduruyordu.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";

const h = vi.hoisted(() => ({
  dir: "",
  dosya: "",
  mf: null as null | { id: string; contentMd5: string; sizeBytes: number },
  indirme: 0,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { productModelFile: { findUnique: vi.fn(async () => h.mf) } },
}));
vi.mock("@/lib/storage", () => ({ getUserDataDir: () => h.dir }));
vi.mock("@/lib/model-files", () => ({
  resolveModelFileLocal: vi.fn(async () => {
    h.indirme++;
    return { path: h.dosya, cleanup: () => {} };
  }),
}));

const { getVizPack, packCacheKey, vizPaketiCokBuyuk, silinecekPaketler } = await import("./pack-server");
const { decodeVizPack, ModelCokBuyukHatasi } = await import("./parse-gcode");

function gcode(katman: number): string {
  const out = ["M83"];
  for (let l = 0; l < katman; l++) {
    out.push(";LAYER_CHANGE", `;Z:${(0.2 * (l + 1)).toFixed(2)}`, ";TYPE:Outer wall", "G1 X10 Y10 F9000");
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      out.push(`G1 X${(50 + 20 * Math.cos(a)).toFixed(3)} Y${(50 + 20 * Math.sin(a)).toFixed(3)} E0.05`);
    }
  }
  return out.join("\n") + "\n";
}

function uc3mfYaz(seviye: 0 | 6): void {
  const zip = zipSync(
    {
      "Metadata/slice_info.config": strToU8("<config/>"),
      "Metadata/plate_1.gcode": [strToU8(gcode(5)), { level: seviye }],
      "Metadata/plate_2.gcode": [strToU8(gcode(30)), { level: seviye }], // EN BÜYÜK plaka seçilmeli
    },
    { level: seviye }
  );
  fs.writeFileSync(h.dosya, zip);
  h.mf = { id: "mf1", contentMd5: "0123456789abcdef0123456789abcdef", sizeBytes: zip.byteLength };
}

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "viz-test-"));
  h.dosya = path.join(h.dir, "plaka.gcode.3mf");
  h.indirme = 0;
});
afterEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe("sunucu paket üreticisi", () => {
  it(".3mf içindeki en büyük plakayı akışla tarar ve diske yazar", async () => {
    uc3mfYaz(6);
    const ilk = await getVizPack("mf1");
    expect(ilk.fromCache).toBe(false);
    const pack = decodeVizPack(ilk.bytes.buffer.slice(ilk.bytes.byteOffset, ilk.bytes.byteOffset + ilk.bytes.byteLength) as ArrayBuffer);
    expect(pack.layerZ.length).toBe(30);

    const ikinci = await getVizPack("mf1");
    expect(ikinci.fromCache).toBe(true);
    expect(h.indirme).toBe(1);
  });

  it("sıkıştırmasız (stored) 3MF de okunur", async () => {
    uc3mfYaz(0);
    const r = await getVizPack("mf1");
    const pack = decodeVizPack(r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer);
    expect(pack.layerZ.length).toBe(30);
  });

  it("'çok büyük' işaretli dosya indirilmez, taranmaz; yer tutucu paket temizlenir", async () => {
    uc3mfYaz(6);
    const key = packCacheKey(h.mf!);
    const vizDir = path.join(h.dir, "viz-packs");
    fs.mkdirSync(vizDir, { recursive: true });
    fs.writeFileSync(path.join(vizDir, `${key}.buyuk`), "2421740 yol");
    fs.writeFileSync(path.join(vizDir, `${key}.mlvz`), "yer tutucu");

    expect(vizPaketiCokBuyuk(h.mf!)).toBe(true);
    await expect(getVizPack("mf1")).rejects.toBeInstanceOf(ModelCokBuyukHatasi);
    expect(h.indirme).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(path.join(vizDir, `${key}.mlvz`))).toBe(false);
  });
});


/**
 * 19 Kas 2026: önbellek 40 dosyayla sınırlıydı ve son 3 günde 67 farklı dosya basılmıştı → yeniden
 * basılan dosya baştan indirilip taranıyordu. Artık boyutla sınırlı; en yeni paketler hep kalır.
 */
describe("paket önbelleği boyutla budanır", () => {
  const p = (ad: string, mb: number, zaman: number) => ({ ad, boyut: mb * 1024 * 1024, zaman });
  it("sınırın altındayken hiçbir şey silinmez", () => {
    expect(silinecekPaketler([p("a", 100, 1), p("b", 100, 2)], 600 * 1024 * 1024, 1)).toEqual([]);
  });
  it("sınır aşılınca EN ESKİLER silinir, en yeniler kalır", () => {
    const paketler = [p("eski", 300, 1), p("orta", 300, 2), p("yeni", 300, 3)];
    expect(silinecekPaketler(paketler, 600 * 1024 * 1024, 1)).toEqual(["eski"]);
  });
  it("boyut ne olursa olsun en yeni asgari sayıda paket tutulur", () => {
    const paketler = [p("a", 500, 1), p("b", 500, 2), p("c", 500, 3)];
    expect(silinecekPaketler(paketler, 100 * 1024 * 1024, 2)).toEqual(["a"]);
  });
});

describe("ilk baskıda anahtar değişince paket yeniden taranmaz", () => {
  it("içerik özeti sonradan kaydedilen dosyanın eski anahtarlı paketi yeni ada taşınır", async () => {
    uc3mfYaz(6);
    const ozet = h.mf!.contentMd5;
    // İlk açılış: özet henüz yok → paket "file-…" anahtarıyla üretilir.
    h.mf = { ...h.mf!, contentMd5: "" };
    const ilk = await getVizPack("mf1");
    expect(ilk.fromCache).toBe(false);
    expect(h.indirme).toBe(1);
    // İlk baskı özeti kaydetti → anahtar "md5-…"e döndü. Aynı dosya YENİDEN indirilip taranmamalı.
    h.mf = { ...h.mf!, contentMd5: ozet };
    const ikinci = await getVizPack("mf1");
    expect(ikinci.fromCache).toBe(true);
    expect(ikinci.cacheKey).toBe(packCacheKey(h.mf!));
    expect(h.indirme).toBe(1);
    expect(Buffer.from(ikinci.bytes).equals(Buffer.from(ilk.bytes))).toBe(true);
  });
});
