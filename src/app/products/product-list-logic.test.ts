import { describe, expect, it } from "vitest";
import {
  isStaleProductListKey,
  memberCost,
  productListKey,
  selectionPreview,
  summarizeGroup,
  toRange,
  visibleSelection,
  type GroupMember,
} from "./product-list-logic";

/**
 * Ürünler listesinin veri-kaybı ve yanlış-rakam noktaları.
 * Üçü de kullanıcının gözünde "uygulama ürünü yedi" ya da "kâr yok" olarak görünüyordu.
 */

const uye = (over: Partial<GroupMember> = {}): GroupMember => ({
  id: Math.random().toString(36).slice(2),
  stock: 0,
  madeToOrder: false,
  currentSalePrice: 100,
  resolvedTotalCost: null,
  cost: null,
  profitPerHour: null,
  profitPerGram: null,
  platforms: [],
  ...over,
});

// ── 1) Gizle / geri getir: hangi liste önbelleği düşer ────────────────────────────────────────

describe("gizlenen ürün diğer sekmede görünsün", () => {
  it("ekranda duran liste KORUNUR (yeniden çekim yok)", () => {
    expect(isStaleProductListKey(productListKey("active", null), "active", null)).toBe(false);
    expect(isStaleProductListKey(productListKey("hidden", "trendyol"), "hidden", "trendyol")).toBe(
      false
    );
  });

  it("karşı sekmenin listesi düşer — gizlenen ürün Gizlenenler'e girsin", () => {
    expect(isStaleProductListKey(productListKey("hidden", null), "active", null)).toBe(true);
    expect(isStaleProductListKey(productListKey("all", null), "active", null)).toBe(true);
  });

  it("aynı filtrenin farklı platform daraltması da düşer", () => {
    expect(isStaleProductListKey(productListKey("active", "trendyol"), "active", null)).toBe(true);
  });

  /**
   * Başka ekranların ürün önbellekleri de DÜŞER — bilerek.
   *
   * Gizleme iyimser güncellemesi ürünü `setQueriesData({ queryKey: ["products"] })` ile TÜM
   * ürün önbelleklerinden siliyor, "Geri al" ise yalnız ekrandaki listeye geri koyuyordu.
   * Sonuç: ürün Ürünler'de geri gelirken Ctrl+K aramasında, varyant seçicide ve Planlayıcı'da
   * silinmiş kalıyordu — `refetchOnMount:false` + uzun `staleTime` yüzünden kendi kendine de
   * düzelmiyordu. Düşürülünce o ekranlar bir sonraki açılışta taze çeker.
   */
  it("başka ekranların ürün önbellekleri de düşer (iyimser silme onları da bozuyor)", () => {
    for (const key of [
      ["products", "active"],
      ["products", "hizli-arama"],
      ["products", "variant-picker"],
      ["products", "printer-match"],
    ]) {
      expect(isStaleProductListKey(key, "active", null)).toBe(true);
    }
  });

  it("ürün DIŞI sorgulara dokunulmaz", () => {
    expect(isStaleProductListKey(["orders", "active", null], "hidden", null)).toBe(false);
    expect(isStaleProductListKey(["dashboard"], "active", null)).toBe(false);
  });
});

// ── 2) Toplu işlem kapsamı ───────────────────────────────────────────────────────────────────

describe("toplu işlem yalnız GÖRÜNEN ürünlere dokunur", () => {
  const gorunen = [{ id: "a" }, { id: "b" }];

  it("görünmeyen seçim silinmeye dahil edilmez", () => {
    // Kullanıcı "a,b,c,d" seçip filtreyi değiştirdi; ekranda yalnız a ve b var.
    const secim = new Set(["a", "b", "c", "d"]);
    expect(visibleSelection(gorunen, secim).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("hiçbiri görünmüyorsa hiçbir şey silinmez", () => {
    expect(visibleSelection(gorunen, new Set(["x", "y"]))).toEqual([]);
  });

  it("onay metni ilk adları ve kalan sayıyı verir", () => {
    const adlar = Array.from({ length: 11 }, (_, i) => `Ürün ${i + 1}`);
    const onizleme = selectionPreview(adlar);
    expect(onizleme.shown).toHaveLength(8);
    expect(onizleme.shown[0]).toBe("Ürün 1");
    expect(onizleme.rest).toBe(3);
  });

  it("liste kısaysa 'daha' satırı çıkmaz", () => {
    expect(selectionPreview(["Vazo", "Kalemlik"]).rest).toBe(0);
  });
});

// ── 3) Varyant grubu özeti ───────────────────────────────────────────────────────────────────

describe("aralık hesabı bilinmeyeni sıfıra indirmez", () => {
  it("hiç değer yoksa null döner (ekranda '—')", () => {
    expect(toRange([null, undefined, Number.NaN])).toBeNull();
  });

  it("eksik değerler aralığı 0'a çekmez, sayılır", () => {
    const aralik = toRange([12, null, 30]);
    expect(aralik).toEqual({ min: 12, max: 30, bilinen: 2, bilinmeyen: 1 });
  });

  it("gerçek 0 bilinen bir değerdir", () => {
    expect(toRange([0, 0])).toEqual({ min: 0, max: 0, bilinen: 2, bilinmeyen: 0 });
  });
});

describe("maliyet kaynağı ürün satırıyla aynı", () => {
  it("önce güncel ayarlardan hesaplanan maliyet", () => {
    expect(memberCost(uye({ resolvedTotalCost: 41, cost: { totalCost: 9, manualCost: 7 } }))).toBe(41);
  });

  it("o yoksa kayıtlı toplam, o da yoksa elle girilen", () => {
    expect(memberCost(uye({ cost: { totalCost: 9, manualCost: 7 } }))).toBe(9);
    expect(memberCost(uye({ cost: { totalCost: null, manualCost: 7 } }))).toBe(7);
    expect(memberCost(uye({ cost: null }))).toBeNull();
  });
});

describe("grup satırı ekranda görünenle tutarlı", () => {
  it("yalnız kendisine verilen varyantları sayar ve toplar", () => {
    // Grup gerçekte 8 varyantlı; filtre 3'ünü gösteriyor → satır o 3'ü anlatmalı.
    const ozet = summarizeGroup([
      uye({ stock: 4 }),
      uye({ stock: 6 }),
      uye({ stock: 1 }),
    ]);
    expect(ozet.varyant).toBe(3);
    expect(ozet.stokToplam).toBe(11);
  });

  it("sipariş üzerine üretilen varyant stok toplamını bozmaz", () => {
    const ozet = summarizeGroup([
      uye({ stock: 5 }),
      uye({ stock: 0, madeToOrder: true }),
      uye({ stock: 0, madeToOrder: true }),
    ]);
    expect(ozet.stokToplam).toBe(5);
    expect(ozet.siparisUzerine).toBe(2);
    expect(ozet.stokTutan).toBe(1);
  });

  it("hepsi sipariş üzerineyse 'Σ 0' yerine stok yok bilgisi döner", () => {
    const ozet = summarizeGroup([
      uye({ stock: 0, madeToOrder: true }),
      uye({ stock: 0, madeToOrder: true }),
    ]);
    expect(ozet.stokToplam).toBeNull();
  });
});

describe("grup satırında kâr ve maliyet artık görünüyor", () => {
  it("maliyet ve kâr/saat aralık olarak özetlenir", () => {
    const ozet = summarizeGroup([
      uye({ resolvedTotalCost: 20, profitPerHour: 30, profitPerGram: 0.5 }),
      uye({ resolvedTotalCost: 35, profitPerHour: 48, profitPerGram: 0.9 }),
    ]);
    expect(ozet.maliyet).toMatchObject({ min: 20, max: 35 });
    expect(ozet.karSaat).toMatchObject({ min: 30, max: 48 });
    expect(ozet.karGram).toMatchObject({ min: 0.5, max: 0.9 });
  });

  it("maliyeti bilinmeyen varyant kâr aralığını sıfıra çekmez", () => {
    const ozet = summarizeGroup([
      uye({
        platforms: [
          {
            platform: "trendyol",
            salePrice: 200,
            netProfit: 45,
            profitMargin: 0.22,
            commissionMissing: false,
          },
        ],
      }),
      uye({
        platforms: [
          {
            platform: "trendyol",
            salePrice: 260,
            netProfit: null, // maliyeti bilinmiyor
            profitMargin: null,
            commissionMissing: false,
          },
        ],
      }),
    ]);
    expect(ozet.platformlar.trendyol?.kar).toEqual({
      min: 45,
      max: 45,
      bilinen: 1,
      bilinmeyen: 1,
    });
    expect(ozet.platformlar.trendyol?.fiyat).toMatchObject({ min: 200, max: 260 });
  });

  it("ilanı olmayan platform '—' kalır, 0 gösterilmez", () => {
    const ozet = summarizeGroup([uye({ platforms: [] })]);
    expect(ozet.platformlar.shopify).toBeNull();
    expect(ozet.platformlar.trendyol).toBeNull();
    expect(ozet.platformlar.hepsiburada).toBeNull();
  });

  it("kaç varyantta ilan var ve kaçında uyarı var sayılır", () => {
    const ozet = summarizeGroup([
      uye({
        platforms: [
          {
            platform: "shopify",
            salePrice: 150,
            netProfit: 20,
            profitMargin: 0.13,
            commissionMissing: false,
            cargoMissing: true,
          },
        ],
      }),
      uye({
        platforms: [
          {
            platform: "shopify",
            salePrice: 150,
            netProfit: -5,
            profitMargin: -0.03,
            commissionMissing: true,
          },
        ],
      }),
      uye({ platforms: [] }),
    ]);
    const shopify = ozet.platformlar.shopify;
    expect(shopify?.ilanli).toBe(2);
    expect(ozet.varyant).toBe(3);
    expect(shopify?.komisyonEksik).toBe(1);
    expect(shopify?.kargoEksik).toBe(1);
    expect(shopify?.kar).toMatchObject({ min: -5, max: 20 });
  });
});
