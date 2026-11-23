/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * "Ürüne bağla" önizlemesi — eşleşmeyen kalem geçmişinin TAMAMI indirilmez (denetim, 23 Kas 2026):
 * önce yalnız farklı adlar okunur, eşleşme normalize kuralıyla JS'te yapılır, sonra yalnız uyan
 * adların satırları istenir. Sonuç eski yolla birebir aynı olmalı.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  kalemler: [] as Array<{ id: string; externalOrderId: string; orderedAt: string; productId: string | null; productName: string }>,
  sorgular: [] as Array<{ sql: string; args: unknown[] }>,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orderLineLink: { findUnique: vi.fn(async () => null) },
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      h.sorgular.push({ sql, args });
      const [platform] = args as string[];
      const adayKalemler = h.kalemler.filter((k) => k.productId == null && platform === "trendyol");
      if (/SELECT DISTINCT "productName"/.test(sql)) {
        return [...new Set(adayKalemler.map((k) => k.productName))].map((productName) => ({ productName }));
      }
      const adlar = new Set(args.slice(1) as string[]);
      return adayKalemler.filter((k) => adlar.has(k.productName));
    }),
  },
}));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite: vi.fn(async () => true) }));

const { bagOnizlemesi } = await import("./order-line-links");

beforeEach(() => {
  h.sorgular = [];
  h.kalemler = [
    { id: "1", externalOrderId: "ty-1", orderedAt: "2026-11-01T10:00:00Z", productId: null, productName: "Mavi Vazo" },
    { id: "2", externalOrderId: "ty-2", orderedAt: "2026-11-02T10:00:00Z", productId: null, productName: "mavi vazo " },
    { id: "3", externalOrderId: "ty-2", orderedAt: "2026-11-02T10:00:00Z", productId: null, productName: "Mavi Vazo" },
    { id: "4", externalOrderId: "ty-3", orderedAt: "2026-11-03T10:00:00Z", productId: null, productName: "Kırmızı Kase" },
    { id: "5", externalOrderId: "ty-4", orderedAt: "2026-11-04T10:00:00Z", productId: "p1", productName: "Mavi Vazo" },
  ];
});

describe("ürüne bağla önizlemesi", () => {
  it("aynı adın yazım farklarını sayar, bağlı ve başka adlı kalemleri saymaz", async () => {
    const sonuc = await bagOnizlemesi("trendyol", "MAVİ  vazo");
    // ty-1 ve ty-2 (iki kalem tek sipariş); ty-3 başka ad, ty-4 zaten bağlı.
    expect(sonuc.siparisSayisi).toBe(2);
  });

  it("satırlar yalnız UYAN adlarla istenir (geçmişin tamamı indirilmez)", async () => {
    await bagOnizlemesi("trendyol", "Mavi Vazo");
    const satirSorgusu = h.sorgular.find((q) => !/DISTINCT/.test(q.sql));
    expect(satirSorgusu?.args.slice(1).sort()).toEqual(["Mavi Vazo", "mavi vazo "].sort());
    expect(satirSorgusu?.args).not.toContain("Kırmızı Kase");
  });

  it("hiç uyan ad yoksa ikinci sorgu atılmaz", async () => {
    const sonuc = await bagOnizlemesi("trendyol", "Yeşil Tabak");
    expect(sonuc.siparisSayisi).toBe(0);
    expect(h.sorgular).toHaveLength(1);
  });
});
