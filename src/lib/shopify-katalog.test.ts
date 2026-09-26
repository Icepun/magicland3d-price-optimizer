import { describe, expect, it } from "vitest";
import {
  YOKSAYILAN_AZAMI,
  eklemePlani,
  katalogFarki,
  katalogUrunu,
  varyantKimligi,
  yoksayilanOku,
  yoksayilanYaz,
  type KatalogUrunu,
  type KatalogVaryanti,
  type UygulamaUrunu,
} from "./shopify-katalog";

/**
 * SHOPIFY'DAN ÜRÜN EKLEME — "Shopify'da listelediğim yeni ürünleri buraya ekleyemiyorum".
 * Mayıs'tan beri 80 ürün birikmişti; iki tanesi Shopify'da yeniden açılmış, eski ilanları ölü.
 */

function varyant(id: string, over: Partial<KatalogVaryanti> = {}): KatalogVaryanti {
  return { id, etiket: "", sku: null, barkod: null, fiyat: 100, stok: 5, gorsel: `https://cdn.shopify.com/${id}.jpg`, ...over };
}

function urun(id: string, baslik: string, varyantlar: KatalogVaryanti[], over: Partial<KatalogUrunu> = {}): KatalogUrunu {
  return { id, baslik, tur: "Figür", gorsel: `https://cdn.shopify.com/p${id}.jpg`, eklendi: "2026-09-16T10:00:00Z", satista: true, handle: `h-${id}`, varyantlar, ...over };
}

function uygulama(id: string, name: string, over: Partial<UygulamaUrunu> = {}): UygulamaUrunu {
  return { id, name, alias: null, barcode: `b-${id}`, sku: `s-${id}`, imageUrl: null, hidden: false, shopifyVaryantId: null, ilanBarkodlari: [], ilanSkulari: [], ...over };
}

describe("Shopify ↔ uygulama farkı", () => {
  it("varyant kimliğiyle bağlı ürün listede görünmez; bağlı olmayan yeni sayılır", () => {
    const katalog = [urun("1", "Kupa", [varyant("11")]), urun("2", "Vazo", [varyant("21")])];
    const f = katalogFarki(katalog, [uygulama("a", "Kupa", { shopifyVaryantId: "11" })], new Set());
    expect(f.yeni.map((u) => u.baslik)).toEqual(["Vazo"]);
    expect(f.ozet).toMatchObject({ yeniUrun: 1, yeniVaryant: 1, kalkan: 0 });
  });

  it("en yeni listelenen en üstte", () => {
    const katalog = [
      urun("1", "Eski", [varyant("11")], { eklendi: "2026-05-01T00:00:00Z" }),
      urun("2", "Yeni", [varyant("21")], { eklendi: "2026-09-16T00:00:00Z" }),
    ];
    expect(katalogFarki(katalog, [], new Set()).yeni.map((u) => u.baslik)).toEqual(["Yeni", "Eski"]);
  });

  it("gizlenen varyant 'gizli'ye düşer, sayılmaz", () => {
    const f = katalogFarki([urun("1", "Kupa", [varyant("11")])], [], new Set(["11"]));
    expect(f.yeni).toEqual([]);
    expect(f.gizli.map((u) => u.baslik)).toEqual(["Kupa"]);
    expect(f.ozet.yeniUrun).toBe(0);
  });

  it("çok varyantlı üründe yalnız eksik varyantlar listelenir", () => {
    const katalog = [urun("1", "Kupa", [varyant("11", { etiket: "20 cm" }), varyant("12", { etiket: "30 cm" })])];
    const f = katalogFarki(katalog, [uygulama("a", "Kupa — 20 cm", { shopifyVaryantId: "11" })], new Set());
    expect(f.yeni[0].varyantlar.map((v) => v.etiket)).toEqual(["30 cm"]);
    expect(f.yeni[0].toplamVaryant).toBe(2);
  });

  it("barkodu tutan SERBEST ürün öneri olur (kopya açılmasın)", () => {
    const katalog = [urun("1", "Kupa", [varyant("11", { barkod: "869000" })])];
    const trendyoldan = uygulama("a", "Trendyol Kupa", { barcode: "869000" });
    const f = katalogFarki(katalog, [trendyoldan], new Set());
    expect(f.yeni[0].varyantlar[0].oneri).toMatchObject({ urunId: "a", neden: "barkod" });
  });

  it("Shopify'da yeniden açılan ürün: eski ilan ölü → ad eşleşir, kalkanlar iki yönlü önerir", () => {
    const katalog = [
      urun("9", "Cars - Piston Kupası", [
        varyant("91", { etiket: "20 cm", fiyat: 299 }),
        varyant("92", { etiket: "30 cm", fiyat: 399 }),
      ]),
    ];
    const eski = uygulama("a", "Cars - Piston Kupası", { shopifyVaryantId: "555" /* artık yok */ });
    const f = katalogFarki(katalog, [eski], new Set());
    expect(f.yeni[0].varyantlar.every((v) => v.oneri?.urunId === "a" && v.oneri.neden === "ad")).toBe(true);
    expect(f.kalkan).toHaveLength(1);
    expect(f.kalkan[0].oneriler.map((o) => o.etiket)).toEqual(["20 cm", "30 cm"]);
  });

  it("canlı ilanı olan ürün öneri olmaz (başka varyanta bağlı)", () => {
    const katalog = [urun("1", "Kupa", [varyant("11")]), urun("2", "Kupa", [varyant("21")])];
    const bagli = uygulama("a", "Kupa", { shopifyVaryantId: "11" });
    const f = katalogFarki(katalog, [bagli], new Set());
    expect(f.yeni[0].varyantlar[0].oneri).toBeNull();
  });

  it("aynı ada iki ürün düşerse öneri YAPILMAZ (kör eşleşme yok)", () => {
    const katalog = [urun("1", "Kupa", [varyant("11")])];
    const f = katalogFarki(katalog, [uygulama("a", "Kupa"), uygulama("b", "kupa")], new Set());
    expect(f.yeni[0].varyantlar[0].oneri).toBeNull();
  });

  it("aynı ürünün barkodu ilanında da geçse belirsiz sayılmaz", () => {
    const katalog = [urun("1", "Kupa", [varyant("11", { barkod: "X1" })])];
    const u = uygulama("a", "Başka ad", { barcode: "X1", ilanBarkodlari: ["X1"] });
    expect(katalogFarki(katalog, [u], new Set()).yeni[0].varyantlar[0].oneri?.urunId).toBe("a");
  });

  it("Shopify listesi yarım gelirse sağlam ürünler 'kalkan' diye GÖSTERİLMEZ", () => {
    const urunler = Array.from({ length: 30 }, (_, i) => uygulama(String(i), `Ürün ${i}`, { shopifyVaryantId: String(1000 + i) }));
    const f = katalogFarki([], urunler, new Set());
    expect(f.kalkan).toEqual([]);
    expect(f.kalkanSupheli).toBe(true);
    // Olağan sayıda kalkan gösterilir.
    const tek = katalogFarki([urun("1", "X", [varyant("1000")])], urunler.slice(0, 2), new Set());
    expect(tek.kalkan.map((k) => k.urunId)).toEqual(["1"]);
    expect(tek.kalkanSupheli).toBe(false);
  });

  it("gizlenmiş ürün kalkanlarda görünmez", () => {
    const u = uygulama("a", "Eski", { shopifyVaryantId: "777", hidden: true });
    expect(katalogFarki([], [u], new Set()).kalkan).toEqual([]);
  });
});

describe("Shopify ürününü karşılaştırma biçimine indirme", () => {
  it("'Default Title' boş etiket olur; varyant görseli yoksa ürün görseline düşülür", () => {
    const k = katalogUrunu({
      id: 5,
      title: "Kupa",
      handle: "kupa",
      status: "active",
      product_type: "",
      image: { src: "https://cdn/ilk.jpg" },
      published_at: "2026-09-16T10:00:00Z",
      created_at: "2026-07-27T10:00:00Z",
      variants: [{ id: 51, product_id: 5, title: "Default Title", price: "349.90", sku: "", barcode: null, inventory_quantity: 3, image: null }],
    });
    expect(k.varyantlar[0]).toMatchObject({ id: "51", etiket: "", sku: null, fiyat: 349.9, gorsel: "https://cdn/ilk.jpg" });
    expect(k.eklendi).toBe("2026-09-16T10:00:00Z");
    expect(k.tur).toBe("Shopify");
  });

  it("barkod sırası: barkod → stok kodu → varyant kimliği", () => {
    expect(varyantKimligi({ id: "1", barkod: "B", sku: "S" })).toBe("B");
    expect(varyantKimligi({ id: "1", barkod: null, sku: "S" })).toBe("S");
    expect(varyantKimligi({ id: "1", barkod: null, sku: null })).toBe("shopify-variant-1");
  });
});

describe("ekleme planı", () => {
  let sayac = 0;
  const yeniId = (onek: string) => `${onek}_${++sayac}`;

  it("tek varyant → kullanıcının verdiği adla tek ürün + Shopify ilanı", () => {
    const katalog = [urun("1", "Wolverine Kitap Tutucu", [varyant("11", { fiyat: 809.99 })])];
    const plan = eklemePlani(
      [{ shopifyUrunId: "1", ad: "  Wolverine Tutucu  ", siparisUzerine: true, stok: 7, varyantlar: [{ id: "11" }] }],
      katalog,
      new Set(),
      new Set(),
      yeniId
    );
    expect(plan.gruplar).toEqual([]);
    expect(plan.urunler).toHaveLength(1);
    expect(plan.urunler[0]).toMatchObject({
      ad: "Wolverine Tutucu",
      fiyat: 809.99,
      stok: 0, // sipariş üzerine → stok tutulmaz
      siparisUzerine: true,
      barkod: "shopify-variant-11",
      grupId: null,
      gorsel: "https://cdn.shopify.com/11.jpg",
      ilan: { varyantId: "11" },
    });
  });

  it("çok varyant → grup + 'Ad — Etiket' adlı ürünler; etiket kullanıcıdan", () => {
    const katalog = [urun("1", "Kupa", [varyant("11", { etiket: "20 cm" }), varyant("12", { etiket: "30 cm" })])];
    const plan = eklemePlani(
      [{ shopifyUrunId: "1", ad: "Piston Kupası", siparisUzerine: false, stok: 2, varyantlar: [{ id: "11", etiket: "Küçük" }, { id: "12" }] }],
      katalog,
      new Set(),
      new Set(),
      yeniId
    );
    expect(plan.gruplar).toEqual([{ id: expect.any(String), ad: "Piston Kupası" }]);
    expect(plan.urunler.map((u) => [u.ad, u.varyantEtiketi, u.stok])).toEqual([
      ["Piston Kupası — Küçük", "Küçük", 2],
      ["Piston Kupası — 30 cm", "30 cm", 2],
    ]);
    expect(new Set(plan.urunler.map((u) => u.grupId)).size).toBe(1);
  });

  it("ad boşsa Shopify adı kullanılır", () => {
    const plan = eklemePlani(
      [{ shopifyUrunId: "1", ad: "   ", siparisUzerine: true, stok: 0, varyantlar: [{ id: "11" }] }],
      [urun("1", "Kupa", [varyant("11")])],
      new Set(),
      new Set(),
      yeniId
    );
    expect(plan.urunler[0].ad).toBe("Kupa");
  });

  it("zaten bağlı varyant atlanır; barkod çakışırsa varyant kimliğine düşülür", () => {
    const katalog = [urun("1", "Kupa", [varyant("11", { barkod: "DOLU" }), varyant("12", { etiket: "B" })])];
    const plan = eklemePlani(
      [{ shopifyUrunId: "1", ad: "Kupa", siparisUzerine: true, stok: 0, varyantlar: [{ id: "11" }, { id: "12" }] }],
      katalog,
      new Set(["12"]),
      new Set(["DOLU"]),
      yeniId
    );
    expect(plan.atlanan).toEqual([{ varyantId: "12", ad: "Kupa — B", neden: "Zaten ekli" }]);
    // Tek varyant kaldı → grup kurulmaz.
    expect(plan.gruplar).toEqual([]);
    expect(plan.urunler).toHaveLength(1);
    expect(plan.urunler[0].barkod).toBe("shopify-variant-11");
  });

  it("Shopify'da olmayan ürün atlanır", () => {
    const plan = eklemePlani(
      [{ shopifyUrunId: "404", ad: "Yok", siparisUzerine: true, stok: 0, varyantlar: [{ id: "1" }] }],
      [],
      new Set(),
      new Set(),
      yeniId
    );
    expect(plan.urunler).toEqual([]);
    expect(plan.atlanan[0].neden).toBe("Shopify'da bulunamadı");
  });
});

describe("gizlenen listesi", () => {
  it("bozuk değer boş liste", () => {
    expect(yoksayilanOku("{yarım")).toEqual(new Set());
    expect(yoksayilanOku(null)).toEqual(new Set());
  });

  it("ekle/çıkar ve tavan", () => {
    const bir = yoksayilanOku(yoksayilanYaz(new Set(), ["1", "2"], []));
    expect([...bir]).toEqual(["1", "2"]);
    expect([...yoksayilanOku(yoksayilanYaz(bir, [], ["1"]))]).toEqual(["2"]);
    const cok = yoksayilanOku(yoksayilanYaz(new Set(), Array.from({ length: YOKSAYILAN_AZAMI + 5 }, (_, i) => String(i)), []));
    expect(cok.size).toBe(YOKSAYILAN_AZAMI);
    expect(cok.has("0")).toBe(false); // en eskiler düşer
  });
});
