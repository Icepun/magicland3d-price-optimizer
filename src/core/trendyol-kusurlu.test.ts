import { describe, expect, it } from "vitest";
import {
  kusurluIadeleriFaturalarlaEsle,
  saticiKusuruMu,
  trendyolKusurluIadeleri,
  tyKusurluCezasiTutari,
} from "./trendyol-kusurlu";
import type { TrendyolIadeTalebi } from "./trendyol-iade";

/** Türkiye saatiyle an (ms). */
const tr = (s: string) => Date.parse(`${s}:00+03:00`);

function talep(
  paket: number,
  sebep: string,
  fiyat: number,
  kabul: string,
  durum = "Accepted",
  adet = 1
): TrendyolIadeTalebi {
  return {
    orderOutboundPackageId: paket,
    claimDate: tr(kabul) - 2 * 86_400_000,
    lastModifiedDate: tr(kabul),
    items: [
      {
        orderLine: { id: paket * 10, price: fiyat },
        claimItems: Array.from({ length: adet }, (_, i) => ({
          id: `${paket}-${i}`,
          claimItemStatus: { name: durum },
          customerClaimItemReason: { name: sebep },
          trendyolClaimItemReason: { name: sebep },
        })),
      },
    ],
  };
}

describe("Trendyol kusurlu ürün bedeli", () => {
  it("barem 27 Tem 2026 cezai şartlarıyla aynı", () => {
    expect(tyKusurluCezasiTutari(149.99)).toBe(50);
    expect(tyKusurluCezasiTutari(279.99)).toBe(100);
    expect(tyKusurluCezasiTutari(499.99)).toBe(120);
    expect(tyKusurluCezasiTutari(999.99)).toBe(180);
    expect(tyKusurluCezasiTutari(1151.44)).toBe(300);
    expect(tyKusurluCezasiTutari(4500)).toBe(600);
    expect(tyKusurluCezasiTutari(12000)).toBe(1200);
  });

  it("yalnız satıcı kusuru sayılan sebepler", () => {
    expect(saticiKusuruMu("Kusurlu ürün gönderildi")).toBe(true);
    expect(saticiKusuruMu("Yanlış ürün gönderildi")).toBe(true);
    expect(saticiKusuruMu("Eksik ürün gönderildi")).toBe(true);
    expect(saticiKusuruMu("Yanlış sipariş verdim")).toBe(false);
    expect(saticiKusuruMu("Beğenmedim")).toBe(false);
    expect(saticiKusuruMu("Vazgeçtim")).toBe(false);
    expect(saticiKusuruMu("Kargo Teslimatı Gecikmesi")).toBe(false);
  });

  // Ölçülen 4 vaka (23 Kas 2026): kabul günü → faturası ve tutarı birebir.
  const olculen = [
    talep(4021885547, "Kusurlu ürün gönderildi", 499.99, "2026-07-29T11:56"),
    talep(4041893201, "Kusurlu ürün gönderildi", 999.99, "2026-08-07T13:30"),
    talep(4067867387, "Kusurlu ürün gönderildi", 499.99, "2026-08-17T15:27"),
    talep(4143875273, "Kusurlu ürün gönderildi", 849.99, "2026-09-17T14:44"),
    // Müşteri kaynaklı ve sonuçlanmamış talepler bedel doğurmaz.
    talep(4138666857, "Yanlış sipariş verdim", 279.99, "2026-09-10T11:54"),
    talep(4170262931, "Kusurlu ürün gönderildi", 279.99, "2026-09-25T19:47", "Cancelled"),
  ];
  const faturalar = {
    bas: tr("2026-05-01T00:00"),
    faturalar: [
      { tarih: tr("2026-08-05T08:00"), tutar: 120 },
      { tarih: tr("2026-08-12T08:00"), tutar: 180 },
      { tarih: tr("2026-08-26T08:01"), tutar: 120 },
      { tarih: tr("2026-09-23T08:01"), tutar: 180 },
    ],
  };

  it("kabul edilmiş satıcı kusurlu iadeleri paket başına çıkarır", () => {
    const k = trendyolKusurluIadeleri(olculen);
    expect([...k.keys()]).toEqual(["ty-4021885547", "ty-4041893201", "ty-4067867387", "ty-4143875273"]);
    expect(k.get("ty-4067867387")).toEqual({
      sebep: "Kusurlu ürün gönderildi",
      netSatis: 499.99,
      adet: 1,
      gun: "2026-08-17",
      ceza: 120,
    });
  });

  it("dört faturanın dördü de doğru siparişe gerçek olarak düşer", () => {
    const k = trendyolKusurluIadeleri(olculen);
    const s = kusurluIadeleriFaturalarlaEsle(k, faturalar, tr("2026-11-23T10:00"));
    expect(Object.fromEntries(s)).toEqual({
      "ty-4021885547": { ceza: 120, durum: "gercek" },
      "ty-4041893201": { ceza: 180, durum: "gercek" },
      "ty-4067867387": { ceza: 120, durum: "gercek" },
      "ty-4143875273": { ceza: 180, durum: "gercek" },
    });
  });

  it("fatura gelmeden tahmini; beklenen sürede gelmezse kesilmedi", () => {
    const k = trendyolKusurluIadeleri([talep(5000000001, "Kusurlu ürün gönderildi", 349.99, "2026-11-18T10:00")]);
    const bos = { bas: tr("2026-05-01T00:00"), faturalar: [] };
    expect(kusurluIadeleriFaturalarlaEsle(k, bos, tr("2026-11-23T10:00")).get("ty-5000000001")).toEqual({
      ceza: 100,
      durum: "tahmini",
    });
    expect(kusurluIadeleriFaturalarlaEsle(k, bos, tr("2026-12-20T10:00")).get("ty-5000000001")).toEqual({
      ceza: 0,
      durum: "kesilmedi",
    });
  });

  it("aynı paketin iki kusurlu adedi toplam bedelden tek barem", () => {
    const k = trendyolKusurluIadeleri([talep(5000000002, "Kusurlu ürün gönderildi", 279.99, "2026-11-18T10:00", "Accepted", 2)]);
    expect(k.get("ty-5000000002")).toMatchObject({ netSatis: 559.98, adet: 2, ceza: 120 });
  });

  it("aynı kalem iki kez gelse de bir kez sayılır", () => {
    const t = talep(5000000003, "Kusurlu ürün gönderildi", 279.99, "2026-11-18T10:00");
    expect(trendyolKusurluIadeleri([t, t]).get("ty-5000000003")).toMatchObject({ adet: 1, ceza: 100 });
  });
});
