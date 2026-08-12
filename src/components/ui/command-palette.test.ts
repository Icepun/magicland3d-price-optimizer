import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupPaletteItems,
  highlightParts,
  moveActiveIndex,
  normalizeSearchText,
  paletteResults,
  rankPaletteItems,
  requestOrdersView,
  scoreEntry,
  scoreMatch,
  splitVariantTitle,
  takeOrdersRequest,
  type PaletteItem,
} from "./command-palette";

/**
 * Hızlı aramanın (Ctrl+K) çekirdeği. Buradaki davranışlar kullanıcı için doğrudan
 * hissedilir: Türkçe harf farkları eşleşmeyi bozmamalı, en iyi sonuç en üstte olmalı,
 * ok tuşları listenin ucunda takılmamalı.
 */

const urun = (id: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  kind: "urun",
  title,
  ...extra,
});

describe("Türkçe harf duyarsız arama", () => {
  it("şapkalı ve noktasız harfleri sadeleştirir", () => {
    expect(normalizeSearchText("Şoför Çiçek Ağı")).toBe("sofor cicek agi");
    expect(normalizeSearchText("İstanbul")).toBe("istanbul");
    expect(normalizeSearchText("KILIÇ")).toBe("kilic");
  });

  it("sadeleştirme harf sayısını değiştirmez (vurgulama buna dayanır)", () => {
    const kaynak = "İĞÜŞÖÇığüşöç";
    expect(normalizeSearchText(kaynak)).toHaveLength(kaynak.length);
  });

  it("Türkçe karakter yazmadan da ürünü bulur", () => {
    expect(scoreMatch("Çiçek Saksısı", "cicek")).toBeGreaterThan(0);
    expect(scoreMatch("Kılıf", "kilif")).toBeGreaterThan(0);
  });
});

describe("eşleşme puanı", () => {
  it("tam eşleşme baştan eşleşmeden, o da içeride geçmekten güçlüdür", () => {
    expect(scoreMatch("kalem", "kalem")).toBeGreaterThan(scoreMatch("kalemlik", "kalem"));
    expect(scoreMatch("kalemlik", "kalem")).toBeGreaterThan(scoreMatch("renkli kalemlik", "alem"));
  });

  it("kelime başı eşleşmesi kelime ortasından güçlüdür", () => {
    expect(scoreMatch("mavi kutu", "kutu")).toBeGreaterThan(scoreMatch("makutu", "kutu"));
  });

  it("eşleşme yoksa sıfır döner", () => {
    expect(scoreMatch("kalemlik", "vazo")).toBe(0);
  });

  it("aramadaki her kelime bir alanda geçmeli", () => {
    const alanlar = ["Mavi Kalemlik", "kalemlik-mavi", "8681234567890"];
    expect(scoreEntry(alanlar, "mavi kalemlik")).toBeGreaterThan(0);
    expect(scoreEntry(alanlar, "mavi vazo")).toBe(0);
  });

  it("barkod gibi görünmeyen alanlardan da bulunur", () => {
    expect(scoreEntry(["Vazo", null, "8681234567890"], "868123")).toBeGreaterThan(0);
  });
});

describe("sonuç sıralama", () => {
  const kayitlar: PaletteItem[] = [
    { id: "s1", kind: "sayfa", title: "Ürünler" },
    { id: "s2", kind: "sayfa", title: "Siparişler" },
    urun("u1", "Kalemlik"),
    urun("u2", "Renkli Kalemlik Seti"),
    { id: "sip1", kind: "siparis", title: "MG-1042", terms: ["Kalemlik"] },
  ];

  it("arama boşken yalnız sayfalar listelenir", () => {
    const sonuc = rankPaletteItems(kayitlar, "");
    expect(sonuc.every((item) => item.kind === "sayfa")).toBe(true);
    expect(sonuc).toHaveLength(2);
  });

  it("en iyi eşleşme en üstte olur", () => {
    const sonuc = rankPaletteItems(kayitlar, "kalemlik");
    expect(sonuc[0].id).toBe("u1");
  });

  it("eşleşmeyen kayıtlar listeye girmez", () => {
    const sonuc = rankPaletteItems(kayitlar, "kalemlik");
    expect(sonuc.map((item) => item.id)).not.toContain("s2");
  });

  it("her türden en fazla belirtilen kadar kayıt gösterilir", () => {
    const cokUrun = Array.from({ length: 20 }, (_, i) => urun(`u${i}`, `Kalemlik ${i}`));
    const sonuc = rankPaletteItems(cokUrun, "kalemlik", 24, 6);
    expect(sonuc).toHaveLength(6);
  });

  it("türler sıralamayı bozmadan gruplanır", () => {
    const gruplar = groupPaletteItems(rankPaletteItems(kayitlar, "kalemlik"));
    expect(gruplar[0].kind).toBe("urun");
    expect(gruplar.flatMap((grup) => grup.items).length).toBe(
      rankPaletteItems(kayitlar, "kalemlik").length
    );
  });
});

describe("boş aramada kısayol sayfaları", () => {
  const sayfalar: PaletteItem[] = [
    "Panel",
    "Ürünler",
    "Siparişler",
    "Raporlar",
    "Yazıcılar",
    "Üretim",
    "Hazırlık Listesi",
    "Filament",
    "Modeller",
    "Ayarlar",
  ].map((title, i) => ({ id: `s${i}`, kind: "sayfa", title }));

  it("alfabetik değil, dizideki kullanım sırasıyla gelir", () => {
    const sonuc = rankPaletteItems(sayfalar, "");
    expect(sonuc[0].title).toBe("Panel");
    expect(sonuc[1].title).toBe("Ürünler");
    expect(sonuc.map((item) => item.title)).not.toContain("Ayarlar");
  });

  it("en çok kullanılan sekiz sayfa gösterilir", () => {
    expect(rankPaletteItems(sayfalar, "")).toHaveLength(8);
  });
});

describe("kırpılan sonuçların sayısı", () => {
  const cokUrun: PaletteItem[] = Array.from({ length: 30 }, (_, i) => ({
    id: `u${i}`,
    kind: "urun",
    title: `Stand ${i}`,
  }));

  it("grup başlığı gizlenenler dahil TÜM eşleşmeyi sayar", () => {
    const { groups } = paletteResults(cokUrun, "stand");
    expect(groups[0].items).toHaveLength(6);
    expect(groups[0].total).toBe(30);
  });

  it("düz liste ekrandaki sırayla döner", () => {
    const { groups, flat } = paletteResults(cokUrun, "stand");
    expect(flat).toEqual(groups.flatMap((group) => group.items));
  });
});

describe("eşleşme kalitesine göre sıralama", () => {
  it("baştan eşleşen, içinde geçenden önce gelir", () => {
    const kayitlar: PaletteItem[] = [
      { id: "a", kind: "urun", title: "Ahşap Stand Küçük" },
      { id: "b", kind: "urun", title: "Stand" },
    ];
    expect(rankPaletteItems(kayitlar, "stand")[0].id).toBe("b");
  });

  it("puan eşitse kısa ad önce gelir", () => {
    const kayitlar: PaletteItem[] = [
      { id: "uzun", kind: "urun", title: "Standlı Telefon Tutucu Büyük Boy" },
      { id: "kisa", kind: "urun", title: "Standlı Kutu" },
    ];
    expect(rankPaletteItems(kayitlar, "standli")[0].id).toBe("kisa");
  });

  it("gizli/pasif ürünler aramaya girer ama aktiflerin altında kalır", () => {
    const kayitlar: PaletteItem[] = [
      { id: "gizli", kind: "urun", title: "Vazo", muted: true, tag: "Gizli" },
      { id: "aktif", kind: "urun", title: "Vazo Büyük Boy" },
    ];
    const sonuc = rankPaletteItems(kayitlar, "vazo");
    expect(sonuc.map((item) => item.id)).toEqual(["aktif", "gizli"]);
  });
});

describe("varyantı başlıktan ayırma", () => {
  it("grup adı başlıkta kalır, ayırt eden parça çipe geçer", () => {
    expect(splitVariantTitle("Diş Macunu Sıkacağı Sarı", "Diş Macunu Sıkacağı")).toEqual({
      title: "Diş Macunu Sıkacağı",
      variant: "Sarı",
    });
  });

  it("elle girilen etiket varsa o kullanılır", () => {
    expect(
      splitVariantTitle("Diş Macunu Sıkacağı - Mavi", "Diş Macunu Sıkacağı", "Gece Mavisi")
    ).toEqual({ title: "Diş Macunu Sıkacağı", variant: "Gece Mavisi" });
  });

  it("ad grup adıyla başlamıyorsa ada dokunulmaz", () => {
    expect(splitVariantTitle("Mavi Kalemlik", "Kalemlik")).toEqual({
      title: "Mavi Kalemlik",
      variant: undefined,
    });
  });

  it("grup yokken sondaki etiket ayrılır", () => {
    expect(splitVariantTitle("Kalemlik Kırmızı", null, "Kırmızı")).toEqual({
      title: "Kalemlik",
      variant: "Kırmızı",
    });
  });

  it("grubu olmayan ürünün adı bölünmez", () => {
    expect(splitVariantTitle("Kalemlik")).toEqual({ title: "Kalemlik" });
  });
});

describe("klavye gezinmesi", () => {
  it("liste sonunda başa, başında sona sarar", () => {
    expect(moveActiveIndex(2, 1, 3)).toBe(0);
    expect(moveActiveIndex(0, -1, 3)).toBe(2);
    expect(moveActiveIndex(0, 1, 3)).toBe(1);
  });

  it("liste boşken sıfırda kalır", () => {
    expect(moveActiveIndex(0, 1, 0)).toBe(0);
  });
});

describe("eşleşen bölümün vurgulanması", () => {
  it("aranan parçayı işaretler", () => {
    expect(highlightParts("Renkli Kalemlik", "kalem")).toEqual([
      { text: "Renkli ", hit: false },
      { text: "Kalem", hit: true },
      { text: "lik", hit: false },
    ]);
  });

  it("Türkçe harf farkına rağmen doğru bölümü işaretler", () => {
    expect(highlightParts("Çiçek Saksısı", "cicek")).toEqual([
      { text: "Çiçek", hit: true },
      { text: " Saksısı", hit: false },
    ]);
  });

  it("arama boşken metni bölmez", () => {
    expect(highlightParts("Kalemlik", "")).toEqual([{ text: "Kalemlik", hit: false }]);
  });

  it("aramanın TÜM kelimelerini işaretler", () => {
    expect(highlightParts("Mavi Büyük Kutu", "mavi kutu")).toEqual([
      { text: "Mavi", hit: true },
      { text: " Büyük ", hit: false },
      { text: "Kutu", hit: true },
    ]);
  });

  it("çakışan eşleşmeleri tek parçaya birleştirir", () => {
    expect(highlightParts("Kalemlik", "kalem kalemlik")).toEqual([
      { text: "Kalemlik", hit: true },
    ]);
  });
});

describe("aramadan Siparişler sayfasına geçiş", () => {
  beforeEach(() => {
    const kayit = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => kayit.get(key) ?? null,
      setItem: (key: string, value: string) => void kayit.set(key, value),
      removeItem: (key: string) => void kayit.delete(key),
    });
  });

  it("seçilen sipariş numarası sayfaya taşınır", () => {
    requestOrdersView({ search: "MG-1042", view: "liste" });
    expect(takeOrdersRequest()).toEqual({ search: "MG-1042", view: "liste" });
  });

  it("aynı istek ikinci kez uygulanmaz", () => {
    requestOrdersView({ view: "hazirlik" });
    expect(takeOrdersRequest()?.view).toBe("hazirlik");
    expect(takeOrdersRequest()).toBeNull();
  });

  it("bekleyen istek yoksa boş döner", () => {
    expect(takeOrdersRequest()).toBeNull();
  });

  it("tanınmayan görünüm adı yok sayılır", () => {
    sessionStorage.setItem(
      "mh-list-state:siparis-istegi",
      JSON.stringify({ view: "baska", search: 5 })
    );
    expect(takeOrdersRequest()).toEqual({ search: undefined, view: undefined });
  });
});
