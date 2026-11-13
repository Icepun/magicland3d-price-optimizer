import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("@/lib/storage", () => ({ getUserDataDir: () => h.dir }));

const { HepsiburadaApiError } = await import("@/services/hepsiburada-client");
const { hbEtiketiGetir } = await import("./hb-etiket");
const { KullaniciHatasi } = await import("./kullanici-hatasi");

/** 2×2 gri PNG (renk türü 0) — HB yanıtı yerine. */
function kucukPng(): string {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const parca = (tur: string, veri: Buffer) => {
    const u = Buffer.alloc(4);
    u.writeUInt32BE(veri.length);
    const tv = Buffer.concat([Buffer.from(tur, "latin1"), veri]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tv));
    return Buffer.concat([u, tv, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const ham = Buffer.from([0, 0, 255, 0, 255, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    parca("IHDR", ihdr),
    parca("IDAT", zlib.deflateSync(ham)),
    parca("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-etiket-test-"));
});
afterEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe("hbEtiketiGetir", () => {
  it("PNG etiketi ister, 100×100 ZPL'e çevirir, ikinci basımda HB'ye gitmez", async () => {
    const kaynak = { getPackageLabel: vi.fn(async () => ({ format: "png", data: [kucukPng()] })) };
    const r1 = await hbEtiketiGetir(kaynak, "5543138988", "62755431389885");
    expect(kaynak.getPackageLabel).toHaveBeenCalledWith("5543138988", "png");
    expect(r1.kaynak).toBe("hepsiburada");
    expect(r1.etiketler[0]).toMatch(/^\^XA\^PW800\^LL800.*\^GFA,/);
    const r2 = await hbEtiketiGetir(kaynak, "5543138988", "62755431389885");
    expect(r2.kaynak).toBe("kopya");
    expect(kaynak.getPackageLabel).toHaveBeenCalledTimes(1);
  });

  it("ortak barkod vermeyen kargo firmasında anlaşılır mesaj", async () => {
    const kaynak = {
      getPackageLabel: vi.fn(async () => {
        throw new HepsiburadaApiError(400, "Hepsiburada API 400: Cargo company does not provide mutual barcodes.");
      }),
    };
    await expect(hbEtiketiGetir(kaynak, "1111", "1111")).rejects.toThrow(/kargo firması/);
  });

  it("boş yanıt ve bozuk resim kullanıcıya gösterilebilir hata olur", async () => {
    const bos = { getPackageLabel: vi.fn(async () => ({ format: "png", data: [] })) };
    await expect(hbEtiketiGetir(bos, "2222", "2222")).rejects.toBeInstanceOf(KullaniciHatasi);
    const bozuk = { getPackageLabel: vi.fn(async () => ({ format: "png", data: ["bm90LXBuZw=="] })) };
    await expect(hbEtiketiGetir(bozuk, "3333", "3333")).rejects.toBeInstanceOf(KullaniciHatasi);
  });
});
