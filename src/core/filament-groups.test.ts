import { describe, expect, it } from "vitest";
import {
  buildFilamentAlerts,
  colorFamilyOf,
  groupSpools,
  isSealed,
  materialFamily,
  nearestColor,
  parseGroupThresholds,
  parseKeyList,
  parseThreshold,
  parseWatchedGroups,
  slugifyTr,
  spoolGroupKey,
  type SpoolLike,
} from "./filament-groups";

/** Test makarası — varsayılan: 1 kg, hiç kullanılmamış, kapalı. */
function spool(over: Partial<SpoolLike> = {}): SpoolLike {
  return {
    id: Math.random().toString(36).slice(2),
    name: "test",
    material: "PLA",
    colorName: "Siyah",
    colorHex: "#111827",
    brand: "Polyture",
    totalGrams: 1000,
    remainingGrams: 1000,
    openedAt: null,
    ...over,
  };
}

describe("Türkçe slug", () => {
  it("büyük/küçük İ-ı tuzağına düşmez — aynı renk tek anahtar olur", () => {
    // toLowerCase()'e güvenilseydi Node ile telefon farklı sonuç verip envanteri ikiye bölerdi.
    expect(slugifyTr("Yeşil")).toBe("yesil");
    expect(slugifyTr("YEŞİL")).toBe("yesil");
    expect(slugifyTr("yesil")).toBe("yesil");
    expect(slugifyTr("IŞIK")).toBe("isik");
    expect(slugifyTr("Fıstık Yeşili")).toBe("fistik-yesili");
    expect(slugifyTr("  Koyu   Gri  ")).toBe("koyu-gri");
  });
});

describe("tür ailesi (kullanıcı kararı: PLA ailesi TEK grup)", () => {
  it("PLA türevlerini tek ailede toplar", () => {
    for (const m of ["PLA", "PLA+", "pla plus", "Silk PLA", "PLA-CF", "  pla  "]) {
      expect(materialFamily(m)).toBe("PLA");
    }
  });

  it("PETG'yi PET'ten önce eşleştirir ve diğer aileleri ayırır", () => {
    expect(materialFamily("PETG")).toBe("PETG");
    expect(materialFamily("PETG-CF")).toBe("PETG");
    expect(materialFamily("ABS")).toBe("ABS");
    expect(materialFamily("TPU 95A")).toBe("TPU");
  });

  it("tanınmayan türü kaybetmez", () => {
    expect(materialFamily("Kevlar")).toBe("KEVLAR");
    expect(materialFamily("")).toBe("PLA");
  });
});

describe("renk tonu ve ailesi (kullanıcı kararı: TONLAR AYRI grup)", () => {
  it("tonlar ayrı anahtar taşır ama aynı aileye düşer", () => {
    const koyu = spool({ colorName: "Koyu Yeşil", colorHex: "#14532d" });
    const fistik = spool({ colorName: "Fıstık Yeşili", colorHex: "#84cc16" });
    expect(spoolGroupKey(koyu)).toBe("PLA__koyu-yesil");
    expect(spoolGroupKey(fistik)).toBe("PLA__fistik-yesili");
    expect(spoolGroupKey(koyu)).not.toBe(spoolGroupKey(fistik));
    // ama arayüz "Yeşil" başlığı altında toplayabilsin:
    expect(colorFamilyOf("koyu-yesil")).toBe("yesil");
    expect(colorFamilyOf("fistik-yesili")).toBe("yesil");
  });

  it("palet dışı ton adından da aile çıkarır", () => {
    expect(colorFamilyOf(slugifyTr("Deniz Mavisi"))).toBe("mavi");
    expect(colorFamilyOf(slugifyTr("Haki"))).toBe("yesil");
    expect(colorFamilyOf(slugifyTr("Antrasit"))).toBe("gri");
  });

  it("renk adı yoksa renk koduna en yakın paletten türetir", () => {
    const s = spool({ colorName: null, colorHex: "#dc2626" });
    expect(spoolGroupKey(s)).toBe("PLA__kirmizi");
    expect(nearestColor("#111827").key).toBe("siyah");
  });

  it("kayıtlı colorKey varsa ona öncelik verir", () => {
    const s = spool({ colorKey: "bordo", colorName: "Kırmızı", colorHex: "#dc2626" });
    expect(spoolGroupKey(s)).toBe("PLA__bordo");
  });

  it("marka gruba GİRMEZ — farklı markalar aynı grupta toplanır", () => {
    const groups = groupSpools([
      spool({ colorName: "Yeşil", brand: "Polyture" }),
      spool({ colorName: "Yeşil", brand: "Porima" }),
      spool({ colorName: "Yeşil", brand: "Esun" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sealedCount).toBe(3);
    expect(groups[0].brands).toEqual(["Esun", "Polyture", "Porima"]);
  });
});

describe("kapalı makara tespiti", () => {
  it("hiç kullanılmamış makara kapalıdır", () => {
    expect(isSealed(spool())).toBe(true);
  });

  it("1 g tolerans içinde hâlâ kapalı sayılır (ölçüm/yuvarlama payı)", () => {
    expect(isSealed(spool({ remainingGrams: 999 }))).toBe(true);
    expect(isSealed(spool({ remainingGrams: 998 }))).toBe(false);
  });

  it("openedAt doluysa gram dolu olsa bile AÇIK sayılır", () => {
    expect(isSealed(spool({ openedAt: new Date("2026-07-01") }))).toBe(false);
    expect(isSealed(spool({ openedAt: "2026-07-01T00:00:00.000Z" }))).toBe(false);
  });

  it("eski kayıtta openedAt hiç yokken kalan≈toplam kapalı sayılır (backfill gerekmez)", () => {
    const eski: SpoolLike = {
      id: "eski", material: "PLA", colorName: "Siyah", colorHex: "#111827",
      totalGrams: 1000, remainingGrams: 1000,
    };
    expect(isSealed(eski)).toBe(true);
  });

  it("biten makara ne kapalı ne açık sayılır", () => {
    const groups = groupSpools([spool({ remainingGrams: 0 })]);
    expect(groups[0]).toMatchObject({ sealedCount: 0, openCount: 0, emptyCount: 1, activeCount: 0 });
  });
});

describe("gruplama çıktısı", () => {
  it("sayıları, gramları ve etiketi doğru üretir; az kalan grubu başa alır", () => {
    const groups = groupSpools([
      spool({ colorName: "Siyah", colorHex: "#111827" }),
      spool({ colorName: "Siyah", colorHex: "#111827", remainingGrams: 400, openedAt: new Date("2026-07-01") }),
      spool({ colorName: "Beyaz", colorHex: "#f9fafb" }),
      spool({ colorName: "Beyaz", colorHex: "#f9fafb" }),
      spool({ colorName: "Beyaz", colorHex: "#f9fafb" }),
    ]);
    const siyah = groups.find((g) => g.colorKey === "siyah")!;
    const beyaz = groups.find((g) => g.colorKey === "beyaz")!;

    expect(siyah).toMatchObject({ sealedCount: 1, openCount: 1, activeCount: 2, label: "Siyah PLA" });
    expect(siyah.remainingGrams).toBe(1400);
    expect(beyaz.sealedCount).toBe(3);
    expect(groups[0].key).toBe(siyah.key); // az kalan önce
  });
});

describe("uyarılar — üç kademe", () => {
  const g = (spools: SpoolLike[]) => groupSpools(spools);

  it("hiç makara yoksa KIRMIZI 'Filament bitti'", () => {
    const alerts = buildFilamentAlerts(g([spool({ remainingGrams: 0 })]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", title: "Filament bitti" });
    expect(alerts[0].id).toBe("filament-PLA__siyah");
  });

  it("kapalı yok ama açık makara varsa SARI 'Son makara açık' — dolu makara varken bitti demez", () => {
    const alerts = buildFilamentAlerts(g([spool({ remainingGrams: 900, openedAt: new Date("2026-07-01") })]));
    expect(alerts[0]).toMatchObject({ severity: "warning", title: "Son makara açık" });
  });

  it("kapalı sayısı eşiğe inince SARI 'Filament azaldı'", () => {
    const alerts = buildFilamentAlerts(g([spool(), spool()]), { threshold: 2 });
    expect(alerts[0]).toMatchObject({ severity: "warning", title: "Filament azaldı" });
    expect(alerts[0].body).toContain("2 kapalı makara");
  });

  it("eşiğin üstünde uyarı çıkmaz", () => {
    expect(buildFilamentAlerts(g([spool(), spool(), spool()]), { threshold: 2 })).toHaveLength(0);
  });

  it("açık makaranın GRAMI uyarıya girmez (yalnız kapalı sayısı bakılır)", () => {
    const alerts = buildFilamentAlerts(
      g([spool(), spool(), spool(), spool({ remainingGrams: 5, openedAt: new Date("2026-07-01") })]),
      { threshold: 2 }
    );
    expect(alerts).toHaveLength(0); // 3 kapalı var; açıktaki 5 g alarm üretmez
  });
});

describe("uyarılar — eşik, susturma, izlenen grup", () => {
  it("grup bazlı eşik genel eşiği ezer", () => {
    const groups = groupSpools([spool(), spool(), spool()]);
    expect(buildFilamentAlerts(groups, { threshold: 2 })).toHaveLength(0);
    expect(
      buildFilamentAlerts(groups, { threshold: 2, groupThresholds: { "PLA__siyah": 3 } })
    ).toHaveLength(1);
  });

  it("susturulan grup uyarı üretmez", () => {
    const groups = groupSpools([spool({ remainingGrams: 0 })]);
    expect(buildFilamentAlerts(groups, { mutedGroups: ["PLA__siyah"] })).toHaveLength(0);
  });

  it("SON MAKARA SİLİNSE BİLE izlenen grup 'bitti' uyarısı verir", () => {
    // Asıl istenen davranış: eskiden grup satırı yok olunca uyarı HİÇ çıkmıyordu.
    const alerts = buildFilamentAlerts([], {
      watchedGroups: [{ key: "PLA__siyah", label: "Siyah PLA" }],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", title: "Filament bitti" });
    expect(alerts[0].body).toContain("Siyah PLA");
  });

  it("izlenen grubun etiketi yoksa anahtardan okunur ad üretir", () => {
    const alerts = buildFilamentAlerts([], { watchedGroups: [{ key: "PETG__bordo" }] });
    expect(alerts[0].body).toContain("Bordo PETG");
  });

  it("canlı satırı olan izlenen grup için çift uyarı üretmez", () => {
    const alerts = buildFilamentAlerts(groupSpools([spool()]), {
      threshold: 2,
      watchedGroups: [{ key: "PLA__siyah", label: "Siyah PLA" }],
    });
    expect(alerts).toHaveLength(1);
  });

  it("kırmızıları başa alır", () => {
    const alerts = buildFilamentAlerts(
      groupSpools([spool({ colorName: "Beyaz", colorHex: "#f9fafb" })]),
      { threshold: 2, watchedGroups: [{ key: "PLA__siyah", label: "Siyah PLA" }] }
    );
    expect(alerts.map((a) => a.severity)).toEqual(["critical", "warning"]);
  });
});

describe("ayar ayrıştırma — bozuk veri uyarı sistemini çökertmez", () => {
  it("eşik", () => {
    expect(parseThreshold("3")).toBe(3);
    expect(parseThreshold("")).toBe(2);
    expect(parseThreshold("abc")).toBe(2);
    expect(parseThreshold("-1")).toBe(2);
    expect(parseThreshold(null, 5)).toBe(5);
  });

  it("kayıtlı 0 eşiği 1 sayılır", () => {
    // Eşik 0 iken "azaldı" diye bir durum kalmaz; kullanıcı son makaraya düştüğünü hiç
    // öğrenemezdi. "Yalnız bitenleri gör" ihtiyacı artık sayfadaki filtreyle karşılanıyor.
    expect(parseThreshold("0")).toBe(1);
  });

  it("liste", () => {
    expect(parseKeyList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseKeyList("bozuk-json")).toEqual([]);
    expect(parseKeyList('{"a":1}')).toEqual([]);
  });

  it("izlenen gruplar iki biçimi de kabul eder", () => {
    expect(parseWatchedGroups('["PLA__siyah"]')).toEqual([{ key: "PLA__siyah" }]);
    expect(parseWatchedGroups('[{"key":"PLA__siyah","label":"Siyah PLA"}]')).toEqual([
      { key: "PLA__siyah", label: "Siyah PLA" },
    ]);
    expect(parseWatchedGroups("bozuk")).toEqual([]);
  });

  it("grup bazlı eşikler", () => {
    expect(parseGroupThresholds('{"PLA__siyah":3,"x":-1,"y":"abc"}')).toEqual({ "PLA__siyah": 3 });
    expect(parseGroupThresholds("bozuk")).toEqual({});
  });
});
