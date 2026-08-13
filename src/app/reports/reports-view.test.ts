import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECALC_BLOCK_LABELS,
  blockedRecalcText,
  chartMonths,
  chartScopeText,
  deltaTone,
  freshnessLine,
  isMonthRangeKey,
  monthKeyOf,
  monthPeriodLabel,
  monthProgress,
  monthProjection,
  monthReadiness,
  monthsWithData,
  profitWarningLabel,
  relativeAge,
  soldUnitsBadge,
  statDelta,
  visibleRangeOptions,
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

describe("grafik penceresi", () => {
  const TZ = "Europe/Istanbul";
  // Sunucu HER ZAMAN 12 kova döndürür; iş 24 Mayıs 2026'da başladı → 8'i bomboş.
  const months = [
    "2025-09",
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
  ].map((month) => ({ month }));
  const dataFrom = "2026-05-24T07:00:00.000Z";

  it("veri başlamadan önceki boş aylar atılır", () => {
    expect(monthsWithData(months, dataFrom, TZ).map((m) => m.month)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
  });

  it("ilk sipariş tarihi bilinmiyorsa hiçbir ay atılmaz", () => {
    expect(monthsWithData(months, null, TZ)).toHaveLength(12);
    expect(monthsWithData(months, "bozuk-tarih", TZ)).toHaveLength(12);
  });

  it("ay listesi dizi değilse ÇÖKMEZ", () => {
    expect(monthsWithData(undefined, dataFrom, TZ)).toEqual([]);
  });

  it("İLK SİPARİŞTEN ÖNCE ödenmiş gider ayı KESİLMEZ", () => {
    // `dataFrom` yalnız sipariş tarihlerinden kurulur; gider ödemesi o hesaba girmez.
    // Nisan'da ₺5.000 kira ödendiyse o ay zarar çubuğuyla doludur, sessizce düşmemeli.
    const giderli = months.map((bucket) =>
      bucket.month === "2026-04" ? { ...bucket, expenses: 5_000 } : bucket
    );
    expect(monthsWithData(giderli, dataFrom, TZ).map((m) => m.month)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
  });

  it("sıfır kovalar 'veri' saymaz — kesme yine ilk sipariş ayından olur", () => {
    const bosKovalar = months.map((bucket) => ({
      ...bucket,
      revenue: 0,
      expenses: 0,
      orderCount: 0,
      orderProfit: 0,
    }));
    expect(monthsWithData(bosKovalar, dataFrom, TZ)).toHaveLength(4);
  });

  it("aralık seçimi veri aylarının SONUNDAN kesilir", () => {
    expect(chartMonths(months, dataFrom, "3", TZ).map((m) => m.month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(chartMonths(months, dataFrom, "all", TZ)).toHaveLength(4);
    // Veriden uzun bir aralık istenirse veri ne kadarsa o kadar çizilir (boş ay eklenmez).
    expect(chartMonths(months, dataFrom, "12", TZ)).toHaveLength(4);
  });

  it("ay sınırı Europe/Istanbul: 30 Nisan 22:00 UTC zaten MAYIS'tır", () => {
    // UTC'ye göre nisan, İstanbul'a göre 1 Mayıs 01:00 → veri mayısta başlamış sayılır.
    expect(monthKeyOf("2026-04-30T22:00:00.000Z", TZ)).toBe("2026-05");
  });

  it("aynı grafiği çizen aralık düğmesi basılmaz", () => {
    // 4 aylık geçmişte "6 ay", "12 ay" ve "Tümü" birebir aynı grafik demek.
    expect(visibleRangeOptions(4).map((option) => option.key)).toEqual(["3", "all"]);
    expect(visibleRangeOptions(12).map((option) => option.key)).toEqual(["3", "6", "all"]);
    // Tek seçenek kalıyorsa grup hiç gösterilmez.
    expect(visibleRangeOptions(1)).toEqual([]);
    expect(visibleRangeOptions(0)).toEqual([]);
  });

  it("hatırlanan aralık tanınmayan bir değerse kabul edilmez", () => {
    expect(isMonthRangeKey("6")).toBe(true);
    expect(isMonthRangeKey("all")).toBe(true);
    expect(isMonthRangeKey("9")).toBe(false);
    expect(isMonthRangeKey(null)).toBe(false);
  });

  it("kapsam cümlesi ARALIK DARALTILDIĞINDA bunu söyler", () => {
    // 4 veri ayından 3'ü çiziliyorsa "ilk veri tarihinden bu yana" demek YALAN olurdu.
    expect(chartScopeText(3, 4)).toBe("Grafikte son 3 ay var — tamamı için Tümü'ne bas.");
  });

  it("tamamı çiziliyorsa daraltma cümlesi basılmaz", () => {
    expect(chartScopeText(4, 4)).toBeNull();
    expect(chartScopeText(12, 4)).toBeNull();
    expect(chartScopeText(0, 4)).toBeNull();
  });
});

describe("devam eden ay", () => {
  const TZ = "Europe/Istanbul";
  const AGUSTOS_13 = Date.parse("2026-08-13T09:00:00+03:00");

  it("süren ayın kaç günü geçtiğini sayar", () => {
    expect(monthProgress("2026-08", AGUSTOS_13, TZ)).toEqual({
      ongoing: true,
      elapsedDays: 13,
      // 13'ünün saat 09:00'ı: 12 tam gün + günün 3/8'i geçti.
      elapsed: 12.375,
      totalDays: 31,
    });
  });

  it("BAŞLAMIŞ gün tam gün SAYILMAZ", () => {
    // Ayın 2'sinde saat 00:30 → gerçekte ~1,02 gün geçti; 2 saymak tahmini yarıya indiriyordu.
    const gece = monthProgress("2026-08", Date.parse("2026-08-02T00:30:00+03:00"), TZ);
    expect(gece?.elapsedDays).toBe(2);
    expect(gece?.elapsed).toBeCloseTo(1.0208, 3);
  });

  it("bitmiş ay ayın TAMAMIDIR", () => {
    expect(monthProgress("2026-07", AGUSTOS_13, TZ)).toEqual({
      ongoing: false,
      elapsedDays: 31,
      elapsed: 31,
      totalDays: 31,
    });
    expect(monthProgress("2026-02", AGUSTOS_13, TZ)?.totalDays).toBe(28);
  });

  it("gün sınırı Europe/Istanbul: 21:30 UTC ertesi gündür", () => {
    const gece = Date.parse("2026-08-13T21:30:00.000Z"); // İstanbul'da 14 Ağustos 00:30
    expect(monthProgress("2026-08", gece, TZ)?.elapsedDays).toBe(14);
  });

  it("bozuk ay anahtarında hiçbir şey iddia etmez", () => {
    expect(monthProgress("2026-13", AGUSTOS_13, TZ)).toBeNull();
    expect(monthProgress("", AGUSTOS_13, TZ)).toBeNull();
  });

  it("ay sonu tahmini GERÇEKTEN geçen süreden çıkar", () => {
    const progress = monthProgress("2026-08", AGUSTOS_13, TZ);
    // 12,375 günde ₺70.174 → günde ₺5.671 → 31 günde ~₺175.789.
    expect(Math.round(monthProjection(70_174, progress) ?? 0)).toBe(175_789);
  });

  it("AYIN İLK GÜNLERİNDE tahmin ÜRETİLMEZ", () => {
    // Bir-iki günlük satıştan ay çıkarmak saçma bir rakam verir.
    const ilkGun = monthProgress("2026-08", Date.parse("2026-08-01T10:00:00+03:00"), TZ);
    expect(monthProjection(5_000, ilkGun)).toBeNull();
    const ikinciGun = monthProgress("2026-08", Date.parse("2026-08-02T01:00:00+03:00"), TZ);
    expect(monthProjection(1_200, ikinciGun)).toBeNull();
    // Üç tam gün dolduğunda tahmin başlar.
    const dorduncuGun = monthProgress("2026-08", Date.parse("2026-08-04T12:00:00+03:00"), TZ);
    expect(monthProjection(1_200, dorduncuGun)).not.toBeNull();
  });

  it("HENÜZ HAREKET YOKKEN tahmin ÜRETİLMEZ", () => {
    // "≈ ₺0 ay sonu tahmini" veri yokluğunu "ay sıfırla kapanacak" iddiasına çeviriyordu.
    const suren = monthProgress("2026-08", AGUSTOS_13, TZ);
    expect(monthProjection(0, suren)).toBeNull();
  });

  it("bitmiş ayda ve bilinmeyen değerde tahmin yok", () => {
    const bitmis = monthProgress("2026-07", AGUSTOS_13, TZ);
    expect(monthProjection(70_000, bitmis)).toBeNull();
    const suren = monthProgress("2026-08", AGUSTOS_13, TZ);
    expect(monthProjection(null, suren)).toBeNull();
    expect(monthProjection(Number.NaN, suren)).toBeNull();
  });

  it("ayın SON gününde tahmin yok (gerçek rakam zaten elde)", () => {
    const sonGun = monthProgress("2026-08", Date.parse("2026-08-31T18:00:00+03:00"), TZ);
    expect(monthProjection(150_000, sonGun)).toBeNull();
  });

  it("kart etiketi süren ayda aralık, bitmiş ayda ay adıdır", () => {
    expect(monthPeriodLabel("2026-08", monthProgress("2026-08", AGUSTOS_13, TZ))).toBe(
      "1–13 Ağustos"
    );
    expect(monthPeriodLabel("2026-07", monthProgress("2026-07", AGUSTOS_13, TZ))).toBe(
      "Temmuz"
    );
    expect(monthPeriodLabel("2026-07", null)).toBe("Temmuz");
    expect(monthPeriodLabel("bozuk", null)).toBeNull();
  });

  it("ayın ilk gününde etiket aralık yazmaz", () => {
    const ilkGun = monthProgress("2026-08", Date.parse("2026-08-01T10:00:00+03:00"), TZ);
    expect(monthPeriodLabel("2026-08", ilkGun)).toBe("1 Ağustos");
  });
});

describe("tazelik satırı", () => {
  it("süreyi sade Türkçe yazar", () => {
    expect(relativeAge(20_000)).toBe("az önce");
    expect(relativeAge(12 * 60_000)).toBe("12 dakika önce");
    expect(relativeAge(3 * 60 * 60_000)).toBe("3 saat önce");
    expect(relativeAge(25 * 60 * 60_000)).toBe("dün");
    expect(relativeAge(4 * 24 * 60 * 60_000)).toBe("4 gün önce");
  });

  it("ileri damgayı 'gelecek' gibi göstermez", () => {
    // Cihaz saati birkaç saniye geride olabilir; negatif fark "az önce"dir.
    expect(relativeAge(-5_000)).toBe("az önce");
  });

  it("rakamın ne zamanki olduğunu ve son sipariş çekimini tek satırda yazar", () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    expect(
      freshnessLine(
        new Date(now - 12 * 60_000).toISOString(),
        new Date(now - 3 * 60 * 60_000).toISOString(),
        now
      )
    ).toEqual({
      text: "Rakamlar 12 dakika önce güncellendi · son siparişler 3 saat önce alındı.",
      stale: false,
    });
  });

  it("bir saatten eski rakam vurgulanır", () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const line = freshnessLine(new Date(now - 95 * 60_000).toISOString(), null, now);
    expect(line?.stale).toBe(true);
    expect(line?.text).toBe("Rakamlar 2 saat önce güncellendi.");
  });

  it("damga yoksa satır basılmaz", () => {
    expect(freshnessLine(null, null, Date.now())).toBeNull();
    expect(freshnessLine("bozuk", null, Date.now())).toBeNull();
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

/**
 * Raporlar sayfası bir istemci bileşeni; bu kurallar TİPLE değil davranışla korunuyor, bu
 * yüzden kaynak metninden doğrulanır. Hepsi bir kez GERÇEKTEN bozuldu.
 */
describe("Raporlar sayfası sözleşmeleri", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/app/reports/page.tsx"),
    "utf8"
  );

  it("kârlılık sorgusu ÜRÜN ailesinin altında durur ve mount'ta bayatlığı sorar", () => {
    // `["products"]` düşürmeleri (~20 mutasyon) ön ek eşleşmesiyle bu kartı da kapsasın diye.
    expect(source).toContain('queryKey: ["products", "profitability"]');
    // QueryProvider varsayılanı `refetchOnMount: false`; bu olmadan düşürme mount'ta işe yaramaz.
    const blok = source.slice(source.indexOf('queryKey: ["products", "profitability"]'));
    expect(blok.slice(0, 420)).toContain("refetchOnMount: true");
  });

  it("çubuk arka plan tazelemesinde ZIPLAMAZ", () => {
    // Adetler değişince React aynı ögeyi yeniden kullanır; mount animasyonu tekrar çalışmaz,
    // geçiş olmadan satır içi `width` anında yeni değerine atlıyordu.
    const kural = source.slice(
      source.indexOf(".ml-bar {"),
      source.indexOf("@media (prefers-reduced-motion")
    );
    expect(kural).toContain("transition: width");
    // Gecikme + fill-mode ikilisi kademeli girişi çubuğa yüklüyordu; giriş SATIRIN işi.
    expect(kural).not.toContain("backwards");
  });

  it("grafik animasyonu gizli pencerede kapanır", () => {
    // Recharts çubuğu rAF ile büyütüyor; gizli pencerede kare gelmeyince sıfır yükseklikte kalır.
    expect(source).toContain("const grafikAnimasyonu = !reduceMotion && !sayfaGizli;");
    expect(source).not.toContain("isAnimationActive={!reduceMotion}");
  });

  it("odak halkası Yüksek Kontrast kipinde de görünür", () => {
    // Tailwind v4'te `outline-none` outline'ı tümden kaldırır; forced-colors'ta box-shadow çizilmez.
    expect(source).not.toContain("outline-none focus-visible:ring-2");
    expect(source).toContain("outline-hidden focus-visible:ring-2");
  });

  it("ağ kopukken 'veri yok' DENMEZ", () => {
    // Duraklamış sorguda isError de isFetching de false; bu ayrım olmadan ekran yalan söylüyordu.
    expect(source).toContain('financeQuery.fetchStatus === "paused"');
  });
});
