import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { N11Client, N11Hatasi, sayfaCoz } from "./n11-client";

let istekler: { url: string; headers: Record<string, string> }[];
let yanit: { status: number; body: unknown };

beforeEach(() => {
  istekler = [];
  yanit = { status: 200, body: { content: [], totalElements: 0, totalPages: 0 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      istekler.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(yanit.body), { status: yanit.status });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const n11 = () => new N11Client({ appKey: "anahtar", appSecret: "sifre" });

describe("n11 istemcisi (yalnız okuma)", () => {
  it("her istekte appkey + appsecret başlığı; ürün sayfası en çok 50", async () => {
    yanit.body = { content: [{ n11ProductId: 1, stockCode: "A" }], totalElements: 120, totalPages: 3 };
    const s = await n11().urunler(0, 500);
    expect(s).toEqual({ icerik: [{ n11ProductId: 1, stockCode: "A" }], toplam: 120, toplamSayfa: 3 });
    expect(istekler[0].url).toBe("https://api.n11.com/ms/product-query?page=0&size=50");
    expect(istekler[0].headers).toMatchObject({ appkey: "anahtar", appsecret: "sifre" });
  });

  it("sipariş paketleri: tarih (epoch-ms), sayfa ≤ 100, yeniden eskiye", async () => {
    await n11().siparisPaketleri({ baslangic: 1000, bitis: 2000, durum: "Created", boyut: 999 });
    const u = new URL(istekler[0].url);
    expect(u.pathname).toBe("/rest/delivery/v1/shipmentPackages");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      startDate: "1000", endDate: "2000", status: "Created", page: "0", size: "100", orderByDirection: "DESC",
    });
  });

  it("kimlik reddi ve hız sınırı kullanıcıya anlaşılır hata olarak döner", async () => {
    yanit = { status: 401, body: {} };
    await expect(n11().urunler()).rejects.toMatchObject({ durum: 401 });
    yanit = { status: 429, body: {} };
    await expect(n11().urunler()).rejects.toBeInstanceOf(N11Hatasi);
  });

  it("beklenmeyen zarf boş sayfa sayılır", () => {
    expect(sayfaCoz(null)).toEqual({ icerik: [], toplam: 0, toplamSayfa: 0 });
    expect(sayfaCoz({ content: [null, 3, { a: 1 }], totalElements: "5" })).toEqual({ icerik: [{ a: 1 }], toplam: 5, toplamSayfa: 0 });
  });
});
