import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECALC_BLOCK_LABELS,
  blockedRecalcText,
  deltaTone,
  missingCostCount,
  monthReadiness,
  profitWarningLabel,
  soldUnitsBadge,
  statDelta,
  windowRecalcSummary,
  type RecalcReadiness,
} from "./reports-view";

describe("statDelta", () => {
  it("bu ay ile geçen ayın farkını ve oranını verir", () => {
    expect(statDelta(120, 100)).toEqual({ diff: 20, ratio: 0.2 });
  });

  it("düşüşte fark negatiftir", () => {
    expect(statDelta(80, 100)).toEqual({ diff: -20, ratio: -0.2 });
  });

  it("geçen ay 0 ise yüzde ÜRETMEZ (sonsuz artış gösterilmez)", () => {
    expect(statDelta(500, 0)).toEqual({ diff: 500, ratio: null });
  });

  it("negatif tabanda oranın işareti farktan gelir", () => {
    // −100'den −150'ye giden bir net kâr KÖTÜLEŞMİŞTİR; oran pozitif çıkmamalı.
    expect(statDelta(-150, -100)).toEqual({ diff: -50, ratio: -0.5 });
  });

  it("BİLİNMEYEN ≠ SIFIR: taraflardan biri yoksa kıyas üretmez", () => {
    expect(statDelta(100, null)).toBeNull();
    expect(statDelta(null, 100)).toBeNull();
    expect(statDelta(undefined, undefined)).toBeNull();
    expect(statDelta(Number.NaN, 10)).toBeNull();
  });

  it("kuruş artığı biriktirmez", () => {
    expect(statDelta(70181.41, 68180.47)?.diff).toBe(2000.94);
  });
});

describe("deltaTone", () => {
  it("ciroda artış iyidir", () => {
    expect(deltaTone(500, true)).toBe("good");
    expect(deltaTone(-500, true)).toBe("bad");
  });

  it("giderde artış KÖTÜdür (renk ters döner)", () => {
    expect(deltaTone(500, false)).toBe("bad");
    expect(deltaTone(-500, false)).toBe("good");
  });

  it("değişim yoksa nötr", () => {
    expect(deltaTone(0, true)).toBe("neutral");
    expect(deltaTone(0, false)).toBe("neutral");
  });
});

describe("soldUnitsBadge", () => {
  it("satılan adedi yazar", () => {
    expect(soldUnitsBadge({ a: 7 }, "a")).toEqual({ text: "7 adet satıldı", sold: true });
  });

  it("her siparişin ürün dökümü varsa kayıtsız ürün gerçekten hiç satılmamıştır", () => {
    expect(soldUnitsBadge({ a: 7 }, "b", 0)).toEqual({ text: "hiç satılmadı", sold: false });
    expect(soldUnitsBadge({ a: 0 }, "a", 0)).toEqual({ text: "hiç satılmadı", sold: false });
  });

  it("BİLİNMEYEN ≠ SIFIR: dökümü olmayan sipariş varsa 'hiç satılmadı' İDDİA EDİLMEZ", () => {
    // Telefondan senkronlanan siparişlerin kalem geçmişi tutulmuyor; o siparişte satılmış bir
    // ürüne "hiç satılmadı" demek düpedüz yanlış bilgi olur (kullanıcı ürünü ölü sanıp
    // fiyat/ilan kararı veriyordu).
    expect(soldUnitsBadge({ a: 7 }, "b", 68)).toEqual({ text: "satış kaydı yok", sold: false });
    expect(soldUnitsBadge({ a: 0 }, "a", 1)).toEqual({ text: "satış kaydı yok", sold: false });
  });

  it("satış özeti hiç gelmediyse rozet basılmaz", () => {
    expect(soldUnitsBadge(undefined, "a")).toBeNull();
    expect(soldUnitsBadge(undefined, "a", 68)).toBeNull();
  });
});

describe("profitWarningLabel", () => {
  it("kâr kısmi hesaplandıysa uyarır", () => {
    expect(profitWarningLabel({ profitPartial: true, profitUnknownLines: 0 })).toBe(
      "Bu ürünün bazı satışlarında kâr hesaplanamadı"
    );
  });

  it("kârı BİLİNMEYEN satış satırı da aynı uyarıyı doğurur", () => {
    // Bu satırlar ürüne SIFIR kâr katıyor ama `profitPartial` false kalıyordu: ekranda
    // hiçbir işaret olmadan olduğundan düşük bir kâr KESİN rakam gibi gösteriliyordu.
    expect(profitWarningLabel({ profitPartial: false, profitUnknownLines: 1 })).toBe(
      "Bu ürünün bazı satışlarında kâr hesaplanamadı"
    );
  });

  it("her şey hesaplanmışsa uyarı yok", () => {
    expect(profitWarningLabel({ profitPartial: false, profitUnknownLines: 0 })).toBeNull();
    expect(profitWarningLabel({ profitPartial: false })).toBeNull();
  });
});

describe("missingCostCount", () => {
  it("maliyeti girilmemiş ürünleri sayar", () => {
    expect(
      missingCostCount([{ hasCost: true }, { hasCost: false }, { hasCost: false }])
    ).toBe(2);
  });

  it("boş listede 0", () => {
    expect(missingCostCount([])).toBe(0);
  });
});

describe("yeniden hesap hazırlığı", () => {
  const readiness: RecalcReadiness = {
    calculationVersion: 4,
    totalOrders: 368,
    outdatedOrders: 91,
    recalculableOrders: 18,
    blockedOrders: 73,
    blockedReasons: { "no-item-history": 73 },
    months: [
      {
        month: "2026-07",
        totalOrders: 159,
        outdatedOrders: 150,
        recalculableOrders: 0,
        blockedOrders: 150,
        blockedReasons: { "no-item-history": 150 },
      },
      {
        month: "2026-08",
        totalOrders: 128,
        outdatedOrders: 18,
        recalculableOrders: 12,
        blockedOrders: 6,
        blockedReasons: { "no-item-history": 6 },
      },
    ],
  };

  it("seçili ayın dökümünü bulur", () => {
    expect(monthReadiness(readiness, "2026-08")?.recalculableOrders).toBe(12);
  });

  it("o ayda sipariş yoksa null döner", () => {
    expect(monthReadiness(readiness, "2026-05")).toBeNull();
    expect(monthReadiness(undefined, "2026-08")).toBeNull();
  });

  it("months alanı dizi değilse ÇÖKMEZ (yerel tip yalan söyleyebilir)", () => {
    const bozuk = { ...readiness, months: undefined } as unknown as RecalcReadiness;
    expect(monthReadiness(bozuk, "2026-08")).toBeNull();
    expect(windowRecalcSummary(bozuk, [{ month: "2026-08", outdatedOrders: 4 }])).toEqual({
      recalculable: null,
      outdated: 4,
      blocked: null,
    });
  });

  it("düzeltilemeyenleri sebebiyle yazar", () => {
    expect(blockedRecalcText(readiness)).toBe(
      "73 sipariş düzeltilemiyor — Ürün geçmişi kayıtlı değil."
    );
  });

  it("düzeltilemeyen yoksa satır basılmaz", () => {
    expect(blockedRecalcText({ ...readiness, blockedOrders: 0 })).toBeNull();
    expect(blockedRecalcText(null)).toBeNull();
  });

  it("tanınmayan sebep metin uydurmaya yol açmaz", () => {
    expect(
      blockedRecalcText({
        totalOrders: 1,
        outdatedOrders: 1,
        recalculableOrders: 0,
        blockedOrders: 1,
        blockedReasons: { "bilinmeyen-sebep": 1 },
      })
    ).toBe("1 sipariş düzeltilemiyor.");
  });
});

describe("windowRecalcSummary", () => {
  const readiness: RecalcReadiness = {
    calculationVersion: 4,
    totalOrders: 500,
    outdatedOrders: 200,
    recalculableOrders: 40,
    blockedOrders: 160,
    blockedReasons: { "no-item-history": 160 },
    months: [
      // Pencere DIŞINDA kalan eski bir ay — sunucunun toplamı bunu da sayıyor.
      {
        month: "2025-01",
        totalOrders: 90,
        outdatedOrders: 90,
        recalculableOrders: 22,
        blockedOrders: 68,
        blockedReasons: { "no-item-history": 68 },
      },
      {
        month: "2026-07",
        totalOrders: 159,
        outdatedOrders: 150,
        recalculableOrders: 0,
        blockedOrders: 150,
        blockedReasons: { "no-item-history": 150 },
      },
      {
        month: "2026-08",
        totalOrders: 128,
        outdatedOrders: 18,
        recalculableOrders: 12,
        blockedOrders: 6,
        blockedReasons: { "no-item-history": 6 },
      },
    ],
  };
  const pencere = [
    { month: "2026-07", outdatedOrders: 150 },
    { month: "2026-08", outdatedOrders: 18 },
  ];

  it("toplam YALNIZ ekranda görünen aylardan kurulur", () => {
    // "Son 12 ayda 40 sipariş" yazıp ayları tek tek toplayınca 12 çıkmasın: ekrandaki iki
    // sayının kapsamı aynı olmalı.
    const summary = windowRecalcSummary(readiness, pencere);
    expect(summary.recalculable).toBe(12);
    expect(summary.blocked?.blockedOrders).toBe(156);
    expect(summary.blocked?.blockedReasons["no-item-history"]).toBe(156);
  });

  it("hazırlık dökümü gelmediyse ham 'eski hesapla kayıtlı' sayısına düşer", () => {
    // Sunucu bu bloğu göndermiyorken uyarı BÜSBÜTÜN kaybolmuştu; yedek sayı hep elde durur.
    expect(windowRecalcSummary(undefined, pencere)).toEqual({
      recalculable: null,
      outdated: 168,
      blocked: null,
    });
  });

  it("ay listesi boşsa sıfırlanır, çökmez", () => {
    expect(windowRecalcSummary(readiness, [])).toEqual({
      recalculable: 0,
      outdated: 0,
      blocked: {
        totalOrders: 0,
        outdatedOrders: 0,
        recalculableOrders: 0,
        blockedOrders: 0,
        blockedReasons: {},
      },
    });
  });
});

describe("engel metni sunucudaki sabitle aynı kalır", () => {
  it("FINANCE_RECALC_BLOCK_LABELS ile ayrışmaz", () => {
    // Sunucu modülü `@/lib/prisma`'yı içe aktardığı için içe aktarılamaz; metin kaynaktan okunur.
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/finance-recalc-readiness.ts"),
      "utf8"
    );
    for (const [key, label] of Object.entries(RECALC_BLOCK_LABELS)) {
      expect(source).toContain(`"${key}": "${label}"`);
    }
  });
});
