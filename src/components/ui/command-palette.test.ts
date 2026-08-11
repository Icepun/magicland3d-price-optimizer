import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupPaletteItems,
  highlightParts,
  moveActiveIndex,
  normalizeSearchText,
  rankPaletteItems,
  requestOrdersView,
  scoreEntry,
  scoreMatch,
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
