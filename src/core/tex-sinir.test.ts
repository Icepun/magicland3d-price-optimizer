/**
 * TARİFE SINIRINDA BOŞLUK OLMAMALI.
 *
 * Eski TEX tarifesi `23:59:59.000`'da kapanıyor, yenisi `00:00:00.000`'da başlıyordu. Kural
 * eşleşmesi kapsayıcıdır (`date > validTo` ise elenir), dolayısıyla aradaki 999 milisaniyeye
 * düşen bir siparişe HİÇBİR kural uymuyordu: eski bitmiş, yeni başlamamış. O siparişin kargo
 * maliyeti sessizce bulunamaz, kârı eksik hesaplanırdı.
 *
 * Bu dosya iki şeyi kilitler: (1) iki tarife arasında tek bir milisaniyelik boşluk bile yok,
 * (2) sınırın iki yanındaki siparişler DOĞRU tarifeyi görüyor (eski gün eski fiyat, yeni gün
 * yeni fiyat) — yani boşluğu kapatırken sınırı kaydırmadık.
 */
import { describe, expect, it } from "vitest";
import { findCargoRule } from "./cargo-calculator";
import {
  TEX_ESKI_TARIFE_BITIS,
  TEX_YENI_TARIFE_BASLANGIC,
  buildTexCargoRules,
} from "./tex-tariff";
import type { CargoRuleInput } from "./types";

/** Eski (1 Ağu öncesi) tarifeden tek bir desi kuralı — gerçek fiyatlarla. */
const ESKI: CargoRuleInput = {
  id: "eski-0-2",
  name: "TEX • 350+ TL • 0-2 desi",
  platform: "trendyol",
  cargoProvider: "TEX",
  categoryName: null,
  minPrice: 350,
  maxPrice: 999999,
  minDesi: 0,
  maxDesi: 2,
  cargoCost: 77.54,
  vatIncluded: false,
  validFrom: null,
  validTo: new Date(TEX_ESKI_TARIFE_BITIS),
  priority: 10,
  isActive: true,
};

/** Yeni tarifeden aynı barem (gerçek üretici fonksiyondan alınır — elle yazılmaz). */
function yeniKurallar(): CargoRuleInput[] {
  return buildTexCargoRules("standart")
    .filter((r) => r.isActive)
    .map((r, i) => ({
      id: `yeni-${i}`,
      name: r.name,
      platform: r.platform,
      cargoProvider: r.cargoProvider,
      categoryName: r.categoryName,
      minPrice: r.minPrice,
      maxPrice: r.maxPrice,
      minDesi: r.minDesi,
      maxDesi: r.maxDesi,
      cargoCost: r.cargoCost,
      vatIncluded: r.vatIncluded,
      validFrom: new Date(r.validFrom),
      validTo: null,
      priority: r.priority,
      isActive: r.isActive,
    }));
}

const HEPSI = () => [ESKI, ...yeniKurallar()];

describe("TEX tarife sınırı", () => {
  it("eski tarifenin bitişi, yeninin başlangıcından TAM 1 ms önce", () => {
    const bitis = new Date(TEX_ESKI_TARIFE_BITIS).getTime();
    const baslangic = new Date(TEX_YENI_TARIFE_BASLANGIC).getTime();
    expect(baslangic - bitis).toBe(1);
  });

  it("ESKİ boşluğa düşen an artık kuralsız kalmıyor", () => {
    // Eskiden kapanış .000 idi; .500 hiçbir kurala uymuyordu.
    const bosluktakiAn = new Date("2026-07-31T23:59:59.500+03:00");
    const kural = findCargoRule(HEPSI(), 500, "", 1, bosluktakiAn);
    expect(kural).toBeDefined();
    // Bu an hâlâ TEMMUZ — eski fiyatı görmeli.
    expect(kural?.cargoCost).toBe(77.54);
  });

  it("sınırın iki yanı DOĞRU tarifeyi görüyor (sınır kaymadı)", () => {
    const temmuzSonu = new Date("2026-07-31T23:59:59.999+03:00");
    const agustosBasi = new Date("2026-08-01T00:00:00.000+03:00");
    expect(findCargoRule(HEPSI(), 500, "", 1, temmuzSonu)?.cargoCost).toBe(77.54);
    expect(findCargoRule(HEPSI(), 500, "", 1, agustosBasi)?.cargoCost).toBe(81.95);
  });

  it("sıradan bir Temmuz ve Ağustos günü de doğru", () => {
    expect(findCargoRule(HEPSI(), 500, "", 1, new Date("2026-07-20T12:00:00+03:00"))?.cargoCost).toBe(77.54);
    expect(findCargoRule(HEPSI(), 500, "", 1, new Date("2026-08-10T12:00:00+03:00"))?.cargoCost).toBe(81.95);
  });
});
