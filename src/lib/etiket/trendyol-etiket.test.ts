/**
 * Trendyol kargo etiketi: önce var olanı al, yoksa BİR KEZ oluştur, hazırlanana dek bekle;
 * aynı etiketi ikinci kez basarken Trendyol'a gitme.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("@/lib/storage", () => ({ getUserDataDir: () => h.dir }));

const { TrendyolApiError } = await import("@/services/trendyol-client");
const { trendyolEtiketiGetir } = await import("./trendyol-etiket");
const { etiketleriBirlestir, takipNoTemizle, basildiIsaretle, basilanlariOku } = await import("./kayit");
const { KullaniciHatasi } = await import("./kullanici-hatasi");

const ZPL = "^XA^FO50,50^FDtest^FS^XZ";
const anında = async () => {};

function kaynak(getYanitlari: Array<string[] | Error>) {
  const cagrilar = { get: 0, create: 0 };
  return {
    cagrilar,
    createCommonLabel: vi.fn(async () => {
      cagrilar.create++;
    }),
    getCommonLabel: vi.fn(async () => {
      const y = getYanitlari[Math.min(cagrilar.get, getYanitlari.length - 1)];
      cagrilar.get++;
      if (y instanceof Error) throw y;
      return y;
    }),
  };
}

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "etiket-test-"));
});
afterEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe("trendyolEtiketiGetir", () => {
  it("etiket zaten varsa YENİDEN OLUŞTURMAZ", async () => {
    const k = kaynak([[ZPL]]);
    const r = await trendyolEtiketiGetir(k, "7330000000001", { bekleme: anında });
    expect(r).toEqual({ etiketler: [ZPL], kaynak: "trendyol" });
    expect(k.cagrilar.create).toBe(0);
  });

  it("yoksa bir kez oluşturur ve hazırlanana dek bekler (400 'henüz yok' sayılır)", async () => {
    const yok = new TrendyolApiError(400, "Trendyol API 400: kargo takip numarası");
    const k = kaynak([yok, [], [], [ZPL]]);
    const r = await trendyolEtiketiGetir(k, "7330000000002", { bekleme: anında });
    expect(r.etiketler).toEqual([ZPL]);
    expect(k.cagrilar.create).toBe(1);
    expect(k.cagrilar.get).toBe(4);
  });

  it("yetki hatası etiketi OLUŞTURMAYA çalışmadan yukarı çıkar", async () => {
    const k = kaynak([new TrendyolApiError(401, "Trendyol API 401")]);
    await expect(trendyolEtiketiGetir(k, "7330000000003", { bekleme: anında })).rejects.toBeInstanceOf(TrendyolApiError);
    expect(k.cagrilar.create).toBe(0);
  });

  it("hesapta servis kapalıysa (COMMON_LABEL_NOT_ALLOWED) net mesaj verir — sahada görüldü", async () => {
    const kapali = new TrendyolApiError(400, "Trendyol API 400", {
      error: { status: 400, errors: [{ code: 400, type: "COMMON_LABEL_NOT_ALLOWED", title: "yetkiniz bulunmamaktadır" }] },
    });
    // GET de kapalı derse oluşturmaya hiç girişmez.
    const k1 = kaynak([kapali]);
    await expect(trendyolEtiketiGetir(k1, "7330000000006", { bekleme: anında })).rejects.toThrow(/açmamış/);
    expect(k1.cagrilar.create).toBe(0);
    // GET "yok" deyip oluşturma kapalı derse de aynı mesaj.
    const k2 = { ...kaynak([new TrendyolApiError(400, "yok")]), createCommonLabel: vi.fn(async () => { throw kapali; }) };
    await expect(trendyolEtiketiGetir(k2, "7330000000007", { bekleme: anında })).rejects.toBeInstanceOf(KullaniciHatasi);
  });

  it("hiç hazırlanmazsa kullanıcıya gösterilecek hata verir", async () => {
    const k = kaynak([[]]);
    await expect(
      trendyolEtiketiGetir(k, "7330000000004", { bekleme: anında, deneme: 3 })
    ).rejects.toBeInstanceOf(KullaniciHatasi);
    expect(k.cagrilar.create).toBe(1);
  });

  it("ikinci basımda yerel kopyayı kullanır, Trendyol'a gitmez (çok koli dahil)", async () => {
    const iki = [ZPL, "^XA^FDkoli2^FS^XZ"];
    const k1 = kaynak([iki]);
    await trendyolEtiketiGetir(k1, "7330000000005", { bekleme: anında });
    const k2 = kaynak([new Error("çağrılmamalıydı")]);
    const r = await trendyolEtiketiGetir(k2, "7330000000005", { bekleme: anında });
    expect(r).toEqual({ etiketler: iki, kaynak: "kopya" });
    expect(k2.cagrilar.get).toBe(0);
  });
});

describe("yardımcılar", () => {
  it("etiketler tek baskı işinde arka arkaya gider", () => {
    const b = etiketleriBirlestir([" ^XA1^XZ ", "^XA2^XZ"]).toString("utf8");
    expect(b).toBe("^XA1^XZ\n^XA2^XZ\n");
  });

  it("takip numarası dosya adına girer → yalnız güvenli karakter", () => {
    expect(takipNoTemizle("7330039048986936")).toBe("7330039048986936");
    expect(takipNoTemizle(7330039048986936)).toBe("7330039048986936");
    expect(takipNoTemizle("../../etc")).toBeNull();
    expect(takipNoTemizle("")).toBeNull();
  });

  it("basılanlar listesi kaydedilir, 60 günden eskisi düşer", () => {
    basildiIsaretle("1111", new Date(Date.now() - 61 * 86_400_000));
    basildiIsaretle("2222");
    const liste = basilanlariOku();
    expect(Object.keys(liste)).toEqual(["2222"]);
  });
});
