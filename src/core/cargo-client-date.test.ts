/**
 * İSTEMCİ TARAFINDA TARİH SÜZGECİ — ham JSON'la ÇALIŞMIYOR.
 *
 * Ürün detay ve Fiyat Lab ekranları kargo kurallarını `fetchJson("/api/cargo-rules")` ile
 * çekip doğrudan `CargoRuleInput[]` olarak kullanıyor. Ama JSON'da `validFrom`/`validTo`
 * METİNDİR; `cargo-calculator` ise `date < r.validFrom` karşılaştırması yapar.
 * JS bu karşılaştırmada iki tarafı da sayıya çevirir: metin `NaN` olur ve NaN ile yapılan
 * HER karşılaştırma `false` döner → süzgeç hiç elemez → SÜRESİ DOLMUŞ tarife hâlâ aday kalır.
 *
 * ÇÖZÜM: kural listesi motora girmeden önce `reviveRuleDates`'ten geçer (`core/rule-dates.ts`),
 * `lib/client-pricing.ts` bunu uyguluyor. Motorun kendisi hâlâ metinle çalışmaz — bu bilinçli:
 * motor saf kalır, tip sözleşmesi `Date` der. Aşağıdaki testler hem tuzağı hem çözümü kilitler.
 */
import { describe, expect, it } from "vitest";
import { findCargoRule } from "./cargo-calculator";
import { reviveRuleDates } from "./rule-dates";
import type { CargoRuleInput } from "./types";

const ESKI_KAPANIS = "2026-07-31T20:59:59.999Z"; // = 31 Tem 23:59:59.999 +03
const YENI_BASLANGIC = "2026-07-31T21:00:00.000Z"; // = 1 Ağu 00:00 +03

/** Aynı bant, iki dönem: eski 77.54, yeni 81.95. `tarihTipi` alanların nasıl geldiğini seçer. */
function kurallar(tarihTipi: "date" | "metin"): CargoRuleInput[] {
  const cevir = (s: string) => (tarihTipi === "date" ? new Date(s) : (s as unknown as Date));
  const ortak = {
    platform: "trendyol",
    cargoProvider: "TEX",
    categoryName: null,
    minPrice: 350,
    maxPrice: 999999,
    minDesi: 0,
    maxDesi: 2,
    vatIncluded: false,
    priority: 10,
    isActive: true,
  };
  return [
    // ESKİ önce: API sıralaması eşitlikte satır sırasına düşüyor, eklenme sırası bu.
    { ...ortak, id: "eski", name: "TEX • 0-2 desi (eski)", cargoCost: 77.54, validFrom: null, validTo: cevir(ESKI_KAPANIS) },
    { ...ortak, id: "yeni", name: "TEX • 0-2 desi (yeni)", cargoCost: 81.95, validFrom: cevir(YENI_BASLANGIC), validTo: null },
  ];
}

const BUGUN = new Date("2026-08-16T12:00:00+03:00");

describe("kargo kuralında tarih tipi", () => {
  it("GERÇEK Date ile: süresi dolmuş tarife elenir, YENİ fiyat gelir", () => {
    expect(findCargoRule(kurallar("date"), 500, "", 1, BUGUN)?.cargoCost).toBe(81.95);
  });

  it("METİN ile DOĞRUDAN motora verilirse: süzgeç ölür, ESKİ fiyat kazanır (tuzak)", () => {
    // Ürün/Fiyat Lab ekranlarının ESKİ davranışı buydu: kargo 4,41 ₺ eksik hesaplanıyor,
    // dolayısıyla o ekranlardaki kâr olduğundan yüksek görünüyordu.
    expect(findCargoRule(kurallar("metin"), 500, "", 1, BUGUN)?.cargoCost).toBe(77.54);
  });

  it("METİN + reviveRuleDates: süzgeç ÇALIŞIR, güncel fiyat gelir (çözüm)", () => {
    const canli = reviveRuleDates(kurallar("metin"));
    expect(findCargoRule(canli, 500, "", 1, BUGUN)?.cargoCost).toBe(81.95);
  });

  it("reviveRuleDates epoch-ms sayıyı da çözer (mobil ham SQL bu biçimde döner)", () => {
    const msKurallar = kurallar("date").map((r) => ({
      ...r,
      validFrom: (r.validFrom ? r.validFrom.getTime() : null) as unknown as Date | null,
      validTo: (r.validTo ? r.validTo.getTime() : null) as unknown as Date | null,
    }));
    const canli = reviveRuleDates(msKurallar);
    expect(findCargoRule(canli, 500, "", 1, BUGUN)?.cargoCost).toBe(81.95);
  });

  it("GEÇMİŞ bir tarihte hâlâ eski tarife gelir — düzeltme geçmişi bozmadı", () => {
    const temmuz = new Date("2026-07-20T12:00:00+03:00");
    const canli = reviveRuleDates(kurallar("metin"));
    expect(findCargoRule(canli, 500, "", 1, temmuz)?.cargoCost).toBe(77.54);
  });

  it("kusurun sebebi: metinle karşılaştırma HER ZAMAN false", () => {
    const metin = ESKI_KAPANIS as unknown as Date;
    expect(BUGUN > metin).toBe(false); // oysa 16 Ağustos, 31 Temmuz'dan SONRA
    expect(BUGUN < metin).toBe(false); // iki yönde de false → süzgeç ölü
    expect(Number.isNaN(Number(ESKI_KAPANIS))).toBe(true);
  });
});
