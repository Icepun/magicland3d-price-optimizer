import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fetch-json", () => ({ fetchJson: vi.fn() }));

/**
 * SAHADA: "Değiştir" formu reklam bütçesi başlangıcını BİR GÜN GERİ dolduruyordu — Türkiye gece
 * yarısı (önceki gün 21:00 UTC) UTC tarihiyle okunuyordu. Olduğu gibi kaydetmek 409 hatası veriyordu.
 */
describe("tarihKutusu", () => {
  it("Türkiye gece yarısı kaydı AYNI günü gösterir", async () => {
    const { tarihKutusu } = await import("./ad-budget-card");
    expect(tarihKutusu("2026-08-31T21:00:00.000Z")).toBe("2026-09-01");
  });

  it("gün ortası kayıt da doğru gün", async () => {
    const { tarihKutusu } = await import("./ad-budget-card");
    expect(tarihKutusu("2026-09-01T09:00:00.000Z")).toBe("2026-09-01");
  });
});
