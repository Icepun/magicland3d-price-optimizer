/**
 * KARGO KURALI SİPARİŞİN KENDİ TARİHİNE GÖRE SEÇİLİR.
 *
 * ⚠️ Bu davranış kâr rakamını belirliyor. Eskiden `findCargoRule`'a tarih geçilmiyordu ve
 * arama HEP BUGÜNLE yapılıyordu; sonucu:
 *   • kargo tarifesi değiştiği anda GEÇMİŞ siparişlerin kargo maliyeti ve kârı da yeni
 *     fiyata kayıyordu,
 *   • barem düğmesini çevirmek (Avantajlı ↔ Standart) tüm geçmişi anında değiştiriyordu —
 *     oysa kullanıcı düğmenin yalnız sonraki siparişleri etkilediğini sanıyordu.
 *
 * Tarife değişimi 1 Ağustos 2026'da yaşandı (TEX ve HepsiJet zamları). Temmuz siparişi
 * Temmuz fiyatını, Ağustos siparişi Ağustos fiyatını görmeli.
 */
import { describe, expect, it } from "vitest";
import { findCargoRule } from "./cargo-calculator";
import { computeOrderProfit, type OrderProfitInput } from "./order-profit";
import type { CargoRuleInput } from "./types";

const TR = (iso: string) => new Date(`${iso}+03:00`);

/** Eski tarife: 31 Temmuz sonunda kapandı. */
const eskiKural: CargoRuleInput = {
  id: "eski",
  name: "TEX • Standart Barem • 0-200 TL",
  platform: "trendyol",
  cargoProvider: "TEX",
  categoryName: null,
  minPrice: 0,
  maxPrice: 199.99,
  minDesi: 0,
  maxDesi: 999,
  cargoCost: 64.58,
  vatIncluded: false,
  validFrom: null,
  validTo: TR("2026-07-31T23:59:59"),
  priority: 20,
  isActive: true,
} as CargoRuleInput;

/** Yeni tarife: 1 Ağustos'ta başladı. */
const yeniKural: CargoRuleInput = {
  ...eskiKural,
  id: "yeni",
  cargoCost: 73.33,
  validFrom: TR("2026-08-01T00:00:00"),
  validTo: null,
} as CargoRuleInput;

const kurallar = [eskiKural, yeniKural];

describe("kural seçimi tarihe bağlı", () => {
  it("TEMMUZ siparişi eski tarifeyi bulur", () => {
    const r = findCargoRule(kurallar, 150, "", 1, TR("2026-07-15T12:00:00"));
    expect(r?.id).toBe("eski");
    expect(r?.cargoCost).toBe(64.58);
  });

  it("AĞUSTOS siparişi yeni tarifeyi bulur", () => {
    const r = findCargoRule(kurallar, 150, "", 1, TR("2026-08-15T12:00:00"));
    expect(r?.id).toBe("yeni");
    expect(r?.cargoCost).toBe(73.33);
  });

  it("tarife sınırında gün kaymaz", () => {
    // 31 Temmuz 23:00 hâlâ eski, 1 Ağustos 00:30 artık yeni.
    expect(findCargoRule(kurallar, 150, "", 1, TR("2026-07-31T23:00:00"))?.id).toBe("eski");
    expect(findCargoRule(kurallar, 150, "", 1, TR("2026-08-01T00:30:00"))?.id).toBe("yeni");
  });
});

/* ── Kâr hesabı gerçekten bu tarihi kullanıyor mu? ── */

function girdi(orderedAt: Date | null): OrderProfitInput {
  return {
    platform: "trendyol",
    orderTotal: 150,
    orderedAt,
    lines: [
      {
        unitPrice: 150,
        quantity: 1,
        product: {
          id: "p1",
          name: "Ürün",
          categoryName: "",
          desi: 1,
          commissionRate: 0,
          productionCost: 10,
          packagingCost: 0,
          filamentCost: 0,
          productionCostKnown: true,
          listing: null,
        },
      },
    ],
    commissionRules: [],
    cargoRules: kurallar,
    expenseRules: [],
    settings: {},
  };
}

describe("sipariş kârı siparişin tarihindeki tarifeyi kullanır", () => {
  it("Temmuz ve Ağustos siparişleri FARKLI kâr verir", () => {
    const temmuz = computeOrderProfit(girdi(TR("2026-07-15T12:00:00")));
    const agustos = computeOrderProfit(girdi(TR("2026-08-15T12:00:00")));

    expect(temmuz.profit).not.toBeNull();
    expect(agustos.profit).not.toBeNull();
    // Yeni tarife daha pahalı (64,58 → 73,33) → Ağustos kârı daha düşük olmalı.
    expect(agustos.profit!).toBeLessThan(temmuz.profit!);
    // Fark tam olarak iki tarife arasındaki farktır (KDV etkisi hariç tutulamadığı için
    // yaklaşık karşılaştırma; yön ve büyüklük mertebesi doğru olsun).
    const fark = temmuz.profit! - agustos.profit!;
    expect(fark).toBeGreaterThan(5);
    expect(fark).toBeLessThan(10);
  });

  it("tarih geçilmezse bugüne düşer — eski davranış korunur", () => {
    // Geriye dönük uyum: `orderedAt` vermeyen bir çağrı çökmemeli.
    const sonuc = computeOrderProfit(girdi(null));
    expect(sonuc.profit).not.toBeNull();
  });
});
