import { describe, expect, it } from "vitest";
import {
  gecikmeleriFaturalarlaEsle,
  trendyolGecikmesi,
  tyGecikmeCezasiTutari,
  tyGecikmeFaturalariOku,
  type TyGecikmeFaturalari,
} from "./trendyol-gecikme";

// Vakaların tamamı gerçek (Trendyol paneli "Sipariş Kayıtları" Ceza kolonu, 23 Kas 2026).
const ms = (s: string) => Date.parse(`${s}:00Z`);
const paket = (soz: string, kargo: string | null, tutar: number, ek: Record<string, unknown> = {}) => ({
  agreedDeliveryDate: ms(soz),
  totalPrice: tutar,
  status: kargo ? "Delivered" : "Picking",
  packageHistories: kargo ? [{ status: "Created", createdDate: ms(soz) - 86_400_000 }, { status: "Shipped", createdDate: ms(kargo) }] : [],
  ...ek,
});
const AN = ms("2026-11-23T10:00");

describe("Trendyol gecikme kuralı", () => {
  it("söz Cuma → Pazartesi kargolandı: tolerans Cumartesiydi → 100 TL (299,98)", () => {
    const g = trendyolGecikmesi(paket("2026-07-31T11:26", "2026-08-03T08:02", 299.98), AN)!;
    expect(g).toMatchObject({ sonGun: "2026-07-31", tolerans: "2026-08-01", gecikti: true, ceza: 100 });
  });

  it("söz Cumartesi (Türkiye) → Pazartesi: Pazar sayılmaz → gecikme yok", () => {
    // 22:08 UTC = Cumartesi 01:08 Türkiye.
    const g = trendyolGecikmesi(paket("2026-08-07T22:08", "2026-08-10T08:24", 799.99), AN)!;
    expect(g).toMatchObject({ sonGun: "2026-08-08", tolerans: "2026-08-10", gecikti: false, ceza: 0 });
  });

  it("söz Çarşamba → Cuma: 180 · söz Salı → Perşembe: 50", () => {
    expect(trendyolGecikmesi(paket("2026-08-05T12:06", "2026-08-07T08:05", 1199.96), AN)?.ceza).toBe(180);
    expect(trendyolGecikmesi(paket("2026-09-01T13:02", "2026-09-03T08:32", 149.99), AN)?.ceza).toBe(50);
  });

  it("hızlı teslimat: söz Perşembe gece → Cumartesi kargolandı → 180", () => {
    const g = trendyolGecikmesi(paket("2026-10-08T20:59", "2026-10-10T08:11", 1299.99, { fastDeliveryType: "FastDelivery" }), AN)!;
    expect(g).toMatchObject({ sonGun: "2026-10-08", tolerans: "2026-10-09", gecikti: true, ceza: 180 });
  });

  it("toleransın içinde kargolanan gecikmiş sayılmaz (söz Cumartesi gece → Pazartesi)", () => {
    expect(trendyolGecikmesi(paket("2026-11-14T20:59", "2026-11-16T09:08", 721.99), AN)?.gecikti).toBe(false);
  });

  it("Bugün Kargoda 1 Ocak 2027'ye kadar muaf", () => {
    const g = trendyolGecikmesi(paket("2026-11-19T20:59", "2026-11-21T11:36", 245.99, { fastDeliveryType: "SameDayShipping" }), AN)!;
    expect(g).toMatchObject({ gecikti: true, muaf: true, ceza: 0 });
  });

  it("kargolanmamış paket toleransı geçtiyse gecikmiş sayılır", () => {
    const g = trendyolGecikmesi(paket("2026-11-20T10:00", null, 500), AN)!;
    expect(g).toMatchObject({ kargolanmadi: true, gecikti: true, ceza: 120 });
    expect(trendyolGecikmesi(paket("2026-11-22T10:00", null, 500), AN)?.gecikti).toBe(false);
  });

  it("iptal / söz tarihi yok / kargo kaydı olmayan teslim → yorum yok", () => {
    expect(trendyolGecikmesi({ ...paket("2026-11-20T10:00", null, 500), status: "Cancelled" }, AN)).toBeNull();
    expect(trendyolGecikmesi({ totalPrice: 100 }, AN)).toBeNull();
    expect(trendyolGecikmesi({ ...paket("2026-11-20T10:00", null, 500), status: "Delivered" }, AN)).toBeNull();
  });

  it("barem", () => {
    expect([199.99, 200, 349.99, 350, 599.99, 600, 2999, 9999.99, 10000].map(tyGecikmeCezasiTutari)).toEqual([
      50, 100, 100, 120, 120, 180, 180, 180, 300,
    ]);
  });
});

describe("gecikme faturaları ile eşleşme", () => {
  const faturalar: TyGecikmeFaturalari = {
    bas: ms("2026-07-20T00:00"),
    faturalar: [
      { tarih: ms("2026-08-05T05:00"), tutar: 100 },
      { tarih: ms("2026-08-12T05:00"), tutar: 180 },
      { tarih: ms("2026-09-09T05:01"), tutar: 50 },
      { tarih: ms("2026-10-14T05:00"), tutar: 180 },
    ],
  };
  const g = (id: string, soz: string, kargo: string, tutar: number) => ({ id, g: trendyolGecikmesi(paket(soz, kargo, tutar), AN)! });

  it("dört gerçek fatura dört siparişle birebir", () => {
    const s = gecikmeleriFaturalarlaEsle(
      [
        g("a", "2026-07-31T11:26", "2026-08-03T08:02", 299.98),
        g("b", "2026-08-05T12:06", "2026-08-07T08:05", 1199.96),
        g("c", "2026-09-01T13:02", "2026-09-03T08:32", 149.99),
        g("d", "2026-10-08T20:59", "2026-10-10T08:11", 1299.99),
        g("e", "2026-08-07T22:08", "2026-08-10T08:24", 799.99),
      ],
      faturalar,
      AN
    );
    expect(s.get("a")).toEqual({ ceza: 100, durum: "gercek" });
    expect(s.get("b")).toEqual({ ceza: 180, durum: "gercek" });
    expect(s.get("c")).toEqual({ ceza: 50, durum: "gercek" });
    expect(s.get("d")).toEqual({ ceza: 180, durum: "gercek" });
    expect(s.get("e")).toEqual({ ceza: 0, durum: "zamaninda" });
  });

  it("faturası beklenen sürede gelmeyen gecikme → kesilmedi; zamanı gelmediyse tahmini", () => {
    const s = gecikmeleriFaturalarlaEsle(
      [g("x", "2026-09-15T10:00", "2026-09-18T09:00", 400), g("y", "2026-11-18T10:00", "2026-11-21T09:00", 400)],
      faturalar,
      AN
    );
    expect(s.get("x")).toEqual({ ceza: 0, durum: "kesilmedi" });
    expect(s.get("y")).toEqual({ ceza: 120, durum: "tahmini" });
  });

  it("fatura bilgisi olmayan eski hafta kesilmedi SAYILMAZ (tahmin kalır)", () => {
    const s = gecikmeleriFaturalarlaEsle([g("z", "2026-07-07T10:00", "2026-07-10T09:00", 400)], faturalar, AN);
    expect(s.get("z")?.durum).toBe("tahmini");
  });

  it("saklanan metin okunur, bozuk metin null", () => {
    expect(tyGecikmeFaturalariOku(JSON.stringify(faturalar))?.faturalar).toHaveLength(4);
    expect(tyGecikmeFaturalariOku("{bozuk")).toBeNull();
  });
});
