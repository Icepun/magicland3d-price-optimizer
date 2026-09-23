import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { GUN_MS, donemKesimi, panelCirosu } from "../../mobile/src/lib/panel-ciro";

/**
 * TELEFON PANEL CİROSU = MASAÜSTÜ SİPARİŞ ÖZETİ.
 *
 * 23 Eyl 2026: kullanıcı "siparişlerdeki ciro desktopla tutmuyor, bir iki günlük fark var gibi"
 * dedi. Canlı ölçüm: masaüstü 130.920,76 ₺, telefon 126.420,81 ₺. İki kök neden:
 *   1. Panel "şu an − 30×24 saat" kayan penceresi kullanıyordu; masaüstü 30 gün önceki UTC
 *      günün BAŞINDAN sayıyor → 24 Ağustos'un 4 siparişi (2.519,97 ₺) yalnız masaüstündeydi.
 *   2. Telefonun Trendyol çekimi 14 günlük sınırı aşıp en yeni saatleri kaybediyordu
 *      (bkz. mobile-trendyol-windows.test.ts).
 * Düzeltmeden sonra aynı canlı ölçüm: iki taraf da 130.920,76 ₺, kâr ve sipariş sayısı eşit.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const PLATFORMLAR = ["shopify", "trendyol", "hepsiburada", "manual"];
const siparis = (iso: string | null, tutar: number, ek: Record<string, unknown> = {}) => ({
  platform: "shopify",
  date: iso ? Date.parse(iso) : null,
  currency: "TRY",
  tutar,
  iptal: false,
  ...ek,
});
type S = ReturnType<typeof siparis>;
const hesapla = (liste: S[], simdiIso: string, gun = 30) =>
  panelCirosu(liste, {
    gun,
    simdi: Date.parse(simdiIso),
    platformlar: PLATFORMLAR,
    sayilmazMi: (o) => Boolean(o.iptal),
    hesapla: (o) => ({ revenue: o.tutar, profit: o.tutar / 4 }),
  });

describe("pencere başı masaüstüyle aynı", () => {
  it("kesim, masaüstü formülünün birebir aynısı (UTC gün başı)", () => {
    const simdi = Date.parse("2026-09-23T21:21:04.877Z");
    const masaustu = (Math.floor(simdi / 86_400_000) - 30) * 86_400_000;
    expect(donemKesimi(simdi, 30)).toBe(masaustu);
    expect(new Date(donemKesimi(simdi, 30)).toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  /** Sahadaki dört siparişin aynısı: 24 Ağu gün içinde verilmiş, kayan pencere hepsini atıyordu. */
  it("kesim gününün siparişleri SAYILIR", () => {
    const r = hesapla(
      [
        siparis("2026-08-24T09:52:57.825Z", 599.99),
        siparis("2026-08-24T10:39:37Z", 239.99),
        siparis("2026-08-24T18:59:24Z", 1080),
        siparis("2026-08-24T20:31:10Z", 599.99),
      ],
      "2026-09-23T21:21:04.877Z"
    );
    expect(r.count).toBe(4);
    expect(r.total).toBeCloseTo(2519.97, 2);
  });

  it("kesimden bir an önceki sipariş sayılmaz", () => {
    const r = hesapla([siparis("2026-08-23T23:59:59.999Z", 100)], "2026-09-23T21:21:04.877Z");
    expect(r.count).toBe(0);
  });

  it("tarihi bilinmeyen sipariş masaüstü gibi DAHİL (ama grafiğe girmez)", () => {
    const r = hesapla([siparis(null, 50)], "2026-09-23T21:21:04.877Z");
    expect(r.total).toBe(50);
    expect(r.gunluk.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("iptal ve TL dışı sipariş ciroya girmez", () => {
    const r = hesapla(
      [siparis("2026-09-20T10:00:00Z", 100, { iptal: true }), siparis("2026-09-20T10:00:00Z", 100, { currency: "USD" })],
      "2026-09-23T21:21:04.877Z"
    );
    expect(r.count).toBe(0);
  });
});

describe("günlük grafik takvim günlerine göre", () => {
  it("pencere gun+1 gün kapsar: N tam gün + bugün", () => {
    expect(hesapla([], "2026-09-23T21:21:04.877Z").gunluk).toHaveLength(31);
    expect(hesapla([], "2026-09-23T21:21:04.877Z", 7).gunluk).toHaveLength(8);
  });

  it("kesim günü ilk kovaya, bugün son kovaya düşer", () => {
    const r = hesapla(
      [siparis("2026-08-24T00:00:00Z", 10), siparis("2026-09-23T20:00:00Z", 20)],
      "2026-09-23T21:21:04.877Z"
    );
    expect(r.gunluk[0]).toBe(10);
    expect(r.gunluk[r.gunluk.length - 1]).toBe(20);
  });

  it("ardışık iki gün aynı kovada birleşmez", () => {
    const r = hesapla(
      [siparis("2026-09-21T12:00:00Z", 1), siparis("2026-09-22T12:00:00Z", 2)],
      "2026-09-23T21:21:04.877Z"
    );
    const dolu = r.gunluk.filter((v) => v > 0);
    expect(dolu).toEqual([1, 2]);
    expect(GUN_MS).toBe(86_400_000);
  });
});

describe("Panel ekranı bu hesabı kullanıyor", () => {
  const panel = oku("mobile/src/app/(tabs)/index.tsx");

  it("ciro panelCirosu'ndan geliyor, kayan pencere yok", () => {
    expect(panel).toContain("panelCirosu(ordersData.orders");
    expect(panel).not.toMatch(/simdi\s*-\s*donem\s*\*\s*GUN/);
  });

  it("tanınmayan pazaryeri durumu masaüstü gibi ciroya girmiyor", () => {
    expect(panel).toContain("sayilmazMi: (o) => isCancelledOrder(o) || durumuTaninmiyor(o)");
    expect(panel).toContain('from "@core/order-status-kind"');
  });
});
