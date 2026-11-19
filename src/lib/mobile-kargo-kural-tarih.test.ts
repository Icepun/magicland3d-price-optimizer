import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDbDateStorage } from "@/core/sqlite-date";

/**
 * TELEFONDAN EKLENEN KARGO KURALI — tarih masaüstüyle AYNI biçimde yazılmalı (19 Kas 2026).
 *
 * Yeni kural, platformun yürürlükteki döneminin başlangıcını devralır. Telefon bu başlangıcı ham
 * ms SAYISI olarak yazıyordu; masaüstü (Prisma) aynı kolona ISO METİN yazıyor. Karışık biçimli
 * tarih kolonunda filtreler satırları sessizce eleyebiliyor (Raporlar'ın %78'i böyle kaybolmuştu).
 * 19 Kas'ta canlı veride telefondan eklenmiş kural yoktu → bu düzeltme hiçbir rakamı değiştirmez.
 *
 * Telefonun GERÇEK `createCargoRule`'u ve ortak çekirdek çalışır; yalnız veritabanı uçları sahte.
 * Modül yolu DEĞİŞKENDE: telefonun `@/` takma adları kökte çözülmez (bkz. mobile-hb-siparis.test.ts).
 */

const yol = vi.hoisted(() => ({ kural: "../../mobile/src/lib/db/rule-crud" }));

const db = vi.hoisted(() => ({
  satirlar: [] as Record<string, unknown>[],
  execute: vi.fn<(sql: string, args?: unknown[]) => Promise<{ rowsAffected: number }>>(
    async () => ({ rowsAffected: 1 })
  ),
}));

vi.mock("@/lib/turso", () => ({
  query: vi.fn(async () => db.satirlar),
  execute: db.execute,
  writeBatch: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/schema", () => ({ ensureCargoVatSchema: vi.fn(async () => {}) }));

type KuralModulu = {
  createCargoRule: (d: {
    name: string; platform: string | null; categoryName: string | null;
    minDesi: number; maxDesi: number; minPrice: number; maxPrice: number;
    cargoCost: number; vatIncluded: boolean;
  }) => Promise<void>;
};

const taslak = {
  name: "0-1 desi", platform: "trendyol", categoryName: null,
  minDesi: 0, maxDesi: 1, minPrice: 0, maxPrice: 999_999, cargoCost: 50, vatIncluded: true,
};

/** INSERT'in `validFrom` argümanı (sütun sırasında 11.). */
async function yazilanBaslangic(): Promise<unknown> {
  const m = (await import(/* @vite-ignore */ yol.kural)) as KuralModulu;
  await m.createCargoRule(taslak);
  const cagri = db.execute.mock.calls.find(([sql]) => /INSERT INTO CargoRule/.test(String(sql)));
  expect(cagri).toBeDefined();
  return (cagri![1] as unknown[])[10];
}

beforeEach(() => {
  db.execute.mockClear();
  // Telefon bunu açılışta `mobile/src/lib/turso.ts` içinde yapıyor (burada o modül sahte).
  setDbDateStorage("iso-text");
});

afterEach(() => {
  setDbDateStorage(null);
});

describe("telefon: yeni kargo kuralının dönem başlangıcı", () => {
  it("masaüstünün yazdığı ISO metinle birebir aynı biçimde yazılır", async () => {
    db.satirlar = [
      { validFrom: null, validTo: "2026-07-31T20:59:59.999+00:00" }, // kapanmış dönem
      { validFrom: "2026-07-31T21:00:00.000+00:00", validTo: null }, // yürürlükte
    ];
    expect(await yazilanBaslangic()).toBe("2026-07-31T21:00:00.000+00:00");
  });

  it("eski (sayı biçimli) kayıttan devralsa da metin yazar", async () => {
    db.satirlar = [{ validFrom: Date.parse("2026-07-31T21:00:00.000Z"), validTo: null }];
    expect(await yazilanBaslangic()).toBe("2026-07-31T21:00:00.000+00:00");
  });

  it("dönemsiz platformda boş kalır", async () => {
    db.satirlar = [{ validFrom: null, validTo: null }];
    expect(await yazilanBaslangic()).toBeNull();
  });
});
