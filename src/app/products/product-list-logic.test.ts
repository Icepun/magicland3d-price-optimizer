import { describe, expect, it } from "vitest";
import {
  isStaleProductListKey,
  listErrorText,
  memberCost,
  productListKey,
  selectionPreview,
  summarizeGroup,
  toRange,
  variantCountLabel,
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
  hasCost: true,
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

  /**
   * Paketleme her ürüne otomatik eklendiği için maliyeti GİRİLMEMİŞ varyantta bile
   * `resolvedTotalCost` dolu geliyor. Kapı olmasaydı grup satırı bir tutar yazarken,
   * açılan varyantın kendi satırı "—" diyordu.
   */
  it("üretim maliyeti bilinmiyorsa tutar varmış gibi gösterilmez", () => {
    expect(memberCost(uye({ hasCost: false, resolvedTotalCost: 4.2 }))).toBeNull();
    expect(memberCost(uye({ hasCost: false, cost: { totalCost: 4.2, manualCost: null } }))).toBeNull();
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

  it("maliyeti eksik varyantlar aralığa girmez ama sayılır", () => {
    const ozet = summarizeGroup([
      uye({ resolvedTotalCost: 20 }),
      uye({ resolvedTotalCost: 26 }),
      // Paketleme yüzünden tutar dolu görünüyor ama ÜRETİM maliyeti girilmemiş.
      uye({ hasCost: false, resolvedTotalCost: 4.2 }),
      uye({ hasCost: false, resolvedTotalCost: 4.2 }),
      uye({ hasCost: false, resolvedTotalCost: 4.2 }),
    ]);
    expect(ozet.maliyet).toMatchObject({ min: 20, max: 26, bilinen: 2, bilinmeyen: 3 });
    expect(ozet.maliyetiEksik).toBe(3);
  });

  it("hiçbir varyantın maliyeti yoksa '—' kalır, sayı yine bilinir", () => {
    const ozet = summarizeGroup([uye({ hasCost: false }), uye({ hasCost: false })]);
    expect(ozet.maliyet).toBeNull();
    expect(ozet.maliyetiEksik).toBe(2);
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

  it("maliyeti eksik varyant kâr/saat aralığını da bozmaz", () => {
    const ozet = summarizeGroup([
      uye({ profitPerHour: 30, profitPerGram: 0.5 }),
      uye({ hasCost: false, profitPerHour: null, profitPerGram: null }),
    ]);
    expect(ozet.karSaat).toMatchObject({ min: 30, max: 30, bilinen: 1, bilinmeyen: 1 });
    expect(ozet.karGram).toMatchObject({ min: 0.5, max: 0.5 });
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

// ── 4) Grup rozeti: kaç varyant görünüyor ────────────────────────────────────────────────────

describe("grup rozeti kısmi görünümü saklamaz", () => {
  it("grubun tamamı listedeyse tek sayı yazar", () => {
    const etiket = variantCountLabel(8, 8);
    expect(etiket.metin).toBe("8 varyant");
    expect(etiket.kismi).toBe(false);
  });

  it("arama/filtre bir kısmını elediyse pay/payda yazar", () => {
    const etiket = variantCountLabel(5, 8);
    expect(etiket.metin).toBe("5 / 8 varyant");
    expect(etiket.kismi).toBe(true);
    expect(etiket.ipucu).toContain("8 varyantından 5");
  });

  it("toplam bilinmiyorsa payda uydurulmaz", () => {
    expect(variantCountLabel(5).metin).toBe("5 varyant");
    expect(variantCountLabel(5, null).metin).toBe("5 varyant");
    expect(variantCountLabel(5, Number.NaN).metin).toBe("5 varyant");
  });

  // Bir varyant silinince sunucudan gelen toplam bir an geride kalır; "9 / 8" yazılmamalı.
  it("toplam görünenden küçük gelirse imkânsız rakam yazılmaz", () => {
    const etiket = variantCountLabel(9, 8);
    expect(etiket.metin).toBe("9 varyant");
    expect(etiket.kismi).toBe(false);
  });
});

// ── 5) Hata sebebi ekranda ───────────────────────────────────────────────────────────────────

describe("hata sebebi kısa bir cümleye iner", () => {
  it("sunucunun okunur mesajı olduğu gibi görünür", () => {
    expect(listErrorText(new Error("Barkod zorunlu"))).toBe("Barkod zorunlu.");
  });

  it("ağ kopması teknik metin yerine sade cümle olur", () => {
    expect(listErrorText(new TypeError("Failed to fetch"))).toBe("Sunucuya ulaşılamadı.");
  });

  it("sebep yoksa boş satır bırakmaz", () => {
    expect(listErrorText(new Error("   "))).toBe("Bağlantı kurulamadı.");
    expect(listErrorText(undefined)).toBe("Bağlantı kurulamadı.");
  });

  it("çok uzun mesaj satırı taşırmaz", () => {
    const metin = listErrorText(new Error("x".repeat(400)));
    expect(metin.length).toBeLessThanOrEqual(141);
    expect(metin.endsWith("…")).toBe(true);
  });

  it("zaten noktalı mesaja ikinci nokta eklenmez", () => {
    expect(listErrorText(new Error("Kayıt bulunamadı."))).toBe("Kayıt bulunamadı.");
  });
});
