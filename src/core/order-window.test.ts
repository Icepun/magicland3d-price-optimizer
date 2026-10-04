import { describe, expect, it } from "vitest";
import { siparisListedeKalir } from "./order-window";

const KESIM = Date.parse("2026-09-04T00:00:00Z");
const ESKI = Date.parse("2026-09-03T07:25:00Z"); // 4 Eki vakası: 3 Eylül'deki özel sipariş
const YENI = Date.parse("2026-10-01T12:00:00Z");

describe("siparisListedeKalir", () => {
  it("pencere içindeki sipariş durumuna bakılmadan görünür", () => {
    expect(siparisListedeKalir({ platform: "trendyol", statusKind: "delivered", tarihMs: YENI }, KESIM)).toBe(true);
    expect(siparisListedeKalir({ platform: "manual", statusKind: "cancelled", tarihMs: YENI }, KESIM)).toBe(true);
  });

  it("işi bitmemiş ELLE EKLENEN sipariş 30 günü geçse de listede kalır", () => {
    expect(siparisListedeKalir({ platform: "manual", statusKind: "processing", tarihMs: ESKI }, KESIM)).toBe(true);
    expect(siparisListedeKalir({ platform: "manual", statusKind: "pending", tarihMs: ESKI }, KESIM)).toBe(true);
  });

  it("gönderilmiş/teslim edilmiş/iptal eski elle sipariş pencereden düşer", () => {
    for (const statusKind of ["shipped", "delivered", "cancelled"] as const) {
      expect(siparisListedeKalir({ platform: "manual", statusKind, tarihMs: ESKI }, KESIM)).toBe(false);
    }
  });

  it("pazaryeri siparişine istisna YOK (Shopify'da işaretlenmemiş eskiler hazırlığı kirletmesin)", () => {
    expect(siparisListedeKalir({ platform: "shopify", statusKind: "pending", tarihMs: ESKI }, KESIM)).toBe(false);
    expect(siparisListedeKalir({ platform: "trendyol", statusKind: "processing", tarihMs: ESKI }, KESIM)).toBe(false);
  });

  it("tarihi bilinmeyen sipariş dahil kalır", () => {
    expect(siparisListedeKalir({ platform: "hepsiburada", statusKind: "delivered", tarihMs: null }, KESIM)).toBe(true);
    expect(siparisListedeKalir({ platform: "manual", statusKind: null, tarihMs: Number.NaN }, KESIM)).toBe(true);
  });
});
