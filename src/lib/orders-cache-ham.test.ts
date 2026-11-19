import { beforeEach, describe, expect, it } from "vitest";
import {
  HAM_YENIDEN_KULLANIM_MS,
  getOrdersCache,
  getOrdersCacheGeneration,
  hamCekimAl,
  hamCekimDusur,
  hamCekimYaz,
  invalidateOrdersCache,
  setOrdersCache,
} from "./orders-cache";

/**
 * AŞAMA 1 önbelleği (19 Kas 2026): "Maliyet gir" / "Ürüne bağla" sonrası üç pazaryeri baştan
 * çekiliyordu (10-20 sn). Ham çekim kısa süre saklanır; kâr girdisi değişince yalnız kâr yeniden
 * hesaplanır. Bu testler üç şeyi kilitler: kâr girdisi değişince ham çekim KORUNUR, eski ya da
 * dünkü çekim KULLANILMAZ, verilen veri saklananı BOZAMAZ (kâr eşitliğinin güvencesi).
 */
const GUN = 86_400_000;
const T = Date.parse("2026-11-19T12:00:00.000Z");
const ornek = () => ({
  raws: [{ platform: "trendyol", id: "1", total: 499.99, lines: [{ name: "Vazo", quantity: 1, unitPrice: 499.99 }] }],
  shopify: { ok: true, count: 0 },
  trendyol: { ok: true, count: 1 },
  hepsiburada: { ok: true, count: 0, notConfigured: false },
});

beforeEach(() => {
  hamCekimDusur();
  invalidateOrdersCache();
});

describe("ham pazaryeri çekimi", () => {
  it("kâr girdisi değişince (invalidateOrdersCache) kâr gövdesi düşer, ham çekim KALIR", () => {
    hamCekimYaz(ornek(), T);
    setOrdersCache({ govde: 1 }, getOrdersCacheGeneration());
    invalidateOrdersCache();
    expect(getOrdersCache()).toBeNull();
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, T + 30_000)?.veri).toEqual(ornek());
  });

  it("sınırdan eski çekim kullanılmaz", () => {
    hamCekimYaz(ornek(), T);
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, T + HAM_YENIDEN_KULLANIM_MS)).not.toBeNull();
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, T + HAM_YENIDEN_KULLANIM_MS + 1)).toBeNull();
  });

  it("gün değişince (pencere kayar) dünkü çekim kullanılmaz", () => {
    const geceYarisinaAz = Math.floor(T / GUN) * GUN + GUN - 10_000;
    hamCekimYaz(ornek(), geceYarisinaAz);
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, geceYarisinaAz + 5_000)).not.toBeNull();
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, geceYarisinaAz + 20_000)).toBeNull();
  });

  it("sınır 0 ise (Yenile / arka plan tazelemesi) hiç kullanılmaz", () => {
    hamCekimYaz(ornek(), T);
    expect(hamCekimAl(0, T)).toBeNull();
  });

  it("verilen kopyayı değiştirmek saklanan çekimi BOZMAZ (her kullanım aynı veriyi görür)", () => {
    const kaynak = ornek();
    hamCekimYaz(kaynak, T);
    kaynak.raws[0].total = 1; // yazandan sonra kaynağı değiştirmek de etkilemez
    const ilk = hamCekimAl<ReturnType<typeof ornek>>(HAM_YENIDEN_KULLANIM_MS, T)!;
    ilk.veri.raws[0].lines[0].quantity = 99;
    ilk.veri.raws.push({ ...ilk.veri.raws[0], id: "2" });
    const ikinci = hamCekimAl<ReturnType<typeof ornek>>(HAM_YENIDEN_KULLANIM_MS, T)!;
    expect(ikinci.veri).toEqual(ornek());
    expect(ikinci.at).toBe(T);
  });

  it("çekim yoksa boş döner; düşürülünce kullanılmaz", () => {
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, T)).toBeNull();
    hamCekimYaz(ornek(), T);
    hamCekimDusur();
    expect(hamCekimAl(HAM_YENIDEN_KULLANIM_MS, T)).toBeNull();
  });
});
