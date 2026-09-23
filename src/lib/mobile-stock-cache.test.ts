import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { enEskiStokOkumasi, stoklariYama } from "../../mobile/src/lib/stock-cache";

/**
 * TELEFONDA STOK TAZELİĞİ — varyant grubu dahil DÖRT önbellek birlikte güncellenir.
 *
 * 23 Eyl 2026: varyant üründe stok değişince detaydaki "Varyant grubu" bölümü eski stoğu
 * göstermeye devam ediyordu — o liste ayrı bir sorgudan (`variant-group`) geliyor ve stok
 * değişikliği onu hiç güncellemiyordu. Başka yerde (masaüstü, sipariş) değişen stoklar da
 * telefon açıkken hiç gelmiyordu; masaüstünün aynı gün eklediği "değişen stokları çek"
 * düzeneğinin telefonda karşılığı yoktu.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Kök ve `mobile/` kendi @tanstack/react-query kopyalarını taşıyor; sınıfın özel alanları
 * yüzünden TypeScript iki kopyayı farklı tip sayıyor. Çalışma zamanında aynı API — testte
 * mobil fonksiyona kökün istemcisini geçirmek için tip bu noktada gevşetiliyor.
 */
type MobilIstemci = Parameters<typeof stoklariYama>[0];
const mobil = (qc: QueryClient) => qc as unknown as MobilIstemci;

function doluIstemci() {
  const qc = new QueryClient();
  qc.setQueryData(["dashboard-data"], [{ id: "a", stock: 5 }, { id: "b", stock: 2 }]);
  qc.setQueryData(["match-products"], [{ id: "a", stock: 5 }]);
  qc.setQueryData(["product", "a"], { id: "a", stock: 5, name: "Kırmızı" });
  qc.setQueryData(["variant-group", "g1"], {
    id: "g1",
    name: "Vazo",
    members: [{ id: "a", stock: 5 }, { id: "c", stock: 1 }],
  });
  return qc;
}

describe("stoklariYama", () => {
  it("dört önbelleğin HEPSİNİ yamalar — varyant grubu dahil", () => {
    const qc = doluIstemci();
    stoklariYama(mobil(qc), [{ id: "a", stock: 3 }]);
    expect(qc.getQueryData<{ id: string; stock: number }[]>(["dashboard-data"])![0].stock).toBe(3);
    expect(qc.getQueryData<{ id: string; stock: number }[]>(["match-products"])![0].stock).toBe(3);
    expect(qc.getQueryData<{ stock: number }>(["product", "a"])!.stock).toBe(3);
    const grup = qc.getQueryData<{ members: { id: string; stock: number }[] }>(["variant-group", "g1"])!;
    expect(grup.members.find((m) => m.id === "a")!.stock).toBe(3);
    expect(grup.members.find((m) => m.id === "c")!.stock).toBe(1);
  });

  /** "Stok düşüp geri gelince eski halinde kalıyordu" — iki yönlü değişim de yansımalı. */
  it("düşüp geri gelen stok grupta da geri gelir", () => {
    const qc = doluIstemci();
    stoklariYama(mobil(qc), [{ id: "a", stock: 4 }]);
    stoklariYama(mobil(qc), [{ id: "a", stock: 5 }]);
    const grup = qc.getQueryData<{ members: { id: string; stock: number }[] }>(["variant-group", "g1"])!;
    expect(grup.members.find((m) => m.id === "a")!.stock).toBe(5);
  });

  it("değişmeyen satır aynı nesne kalır (boşuna yeniden çizim yok)", () => {
    const qc = doluIstemci();
    const once = qc.getQueryData<{ id: string; stock: number }[]>(["dashboard-data"])!;
    stoklariYama(mobil(qc), [{ id: "a", stock: 3 }]);
    const sonra = qc.getQueryData<{ id: string; stock: number }[]>(["dashboard-data"])!;
    expect(sonra[1]).toBe(once[1]);
  });

  it("boş liste hiçbir şeye dokunmaz", () => {
    const qc = doluIstemci();
    expect(stoklariYama(mobil(qc), [])).toBe(0);
  });
});

describe("enEskiStokOkumasi", () => {
  it("stoklu önbelleklerin en eskisini verir, stoksuz sorguları saymaz", () => {
    const qc = new QueryClient();
    qc.setQueryData(["dashboard-data"], [], { updatedAt: 3_000 });
    qc.setQueryData(["variant-group", "g"], { members: [] }, { updatedAt: 1_000 });
    qc.setQueryData(["rules"], {}, { updatedAt: 500 });
    expect(enEskiStokOkumasi(mobil(qc))).toBe(1_000);
  });

  it("stoklu veri yoksa 0 — sorgu atılmaz", () => {
    expect(enEskiStokOkumasi(mobil(new QueryClient()))).toBe(0);
  });
});

describe("ekranlar bağlı", () => {
  it("ürün detayı stok değişince varyant grubunu da güncelliyor", () => {
    const detay = oku("mobile/src/app/product/[id].tsx");
    expect(detay).toContain("stoklariYama(qc, [{ id, stock }])");
    expect(detay).toContain('qc.invalidateQueries({ queryKey: ["variant-group"] })');
  });

  it("değişen stoklar uygulamaya ve ürün ekranlarına dönünce çekiliyor", () => {
    expect(oku("mobile/src/app/_layout.tsx")).toContain("void refreshChangedStocks(qc)");
    expect(oku("mobile/src/app/(tabs)/products.tsx")).toContain("void refreshChangedStocks(qc)");
    expect(oku("mobile/src/app/product/[id].tsx")).toContain("void refreshChangedStocks(qc)");
  });

  it("değişen stok sorgusu masaüstüyle aynı biçimden bağımsız karşılaştırma", () => {
    expect(oku("mobile/src/lib/fresh-stocks.ts")).toContain('dbEpochMs("updatedAt")');
  });
});

describe("Giderler ekranı dönemli", () => {
  const giderler = oku("mobile/src/app/expenses.tsx");

  it("masaüstüyle aynı dönem hesabı kullanılıyor, varsayılan 'bu ay'", () => {
    expect(giderler).toContain('from "@core/expense-view"');
    expect(giderler).toContain('useState<PeriyotTipi>("ay")');
    expect(giderler).toContain("donemOzeti(");
  });

  it("tüm zamanların toplamı artık gösterilmiyor", () => {
    expect(giderler).not.toContain("KAYITLI TOPLAM");
    expect(giderler).not.toMatch(/reduce\(\(sum, expense\) => sum \+ expense\.amountKurus/);
  });

  it("çekirdek kopyası masaüstüyle birebir", () => {
    expect(oku("mobile/src/core/expense-view.ts")).toBe(oku("src/core/expense-view.ts"));
  });
});
