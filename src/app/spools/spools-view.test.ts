/**
 * Filament sayfası görünüm mantığı.
 *
 * Asıl korunan davranış: STOĞU BİTEN RENK EKRANDAN KAYBOLMAMALI. Eski sayfada bir rengin son
 * makarası silinince o rengin grubu da yok oluyordu; yani "sipariş etmem gereken renk" tam da
 * görünmez olan renkti. Sahadan ölçüldü (13 Ağu): 34 makara / 19 renk içinde siyah ve gri hiç
 * yoktu ve sayfa bunu hiçbir şekilde söyleyemiyordu.
 */
import { describe, expect, it } from "vitest";
import type { FilamentGroup } from "@/core/filament-groups";
import {
  acikligi, alisverisListesi, bolumlere, filtrele, renkCipleri, stokOzeti, TEMEL_RENKLER,
} from "./spools-view";

const TEMEL = [
  { key: "siyah", name: "Siyah", hex: "#111827", family: "siyah" },
  { key: "gri", name: "Gri", hex: "#9ca3af", family: "gri" },
  { key: "beyaz", name: "Beyaz", hex: "#f9fafb", family: "beyaz" },
];

function grup(over: Partial<FilamentGroup> & { colorKey: string; sealedCount: number }): FilamentGroup {
  const { colorKey, sealedCount } = over;
  return {
    key: `PLA__${colorKey}`,
    material: "PLA",
    colorName: colorKey,
    colorHex: "#888888",
    colorFamily: colorKey,
    label: `${colorKey} PLA`,
    openCount: 0,
    emptyCount: 0,
    activeCount: sealedCount,
    remainingGrams: sealedCount * 1000,
    totalGrams: sealedCount * 1000,
    brands: [],
    spools: [],
    ...over,
  } as FilamentGroup;
}

const esikSabit = (n: number) => () => n;

describe("renkCipleri — temel renkler", () => {
  it("stoğu HİÇ olmayan temel renk yine de listede kalır", () => {
    // Tek canlı renk kırmızı; siyah/gri/beyaz hiç alınmamış.
    const cipler = renkCipleri([grup({ colorKey: "kirmizi", sealedCount: 4 })], esikSabit(1), 1, TEMEL);

    const adlar = cipler.map((c) => c.colorName);
    expect(adlar).toContain("Siyah");
    expect(adlar).toContain("Gri");
    expect(adlar).toContain("Beyaz");

    const siyah = cipler.find((c) => c.colorName === "Siyah")!;
    expect(siyah.sealed).toBe(0);
    expect(siyah.durum).toBe("biten");
    expect(siyah.group).toBeNull(); // kaydı yok → detay değil, "ekle" açılmalı
  });

  it("stoğu OLAN temel renk iki kez eklenmez", () => {
    const cipler = renkCipleri(
      [grup({ colorKey: "beyaz", colorFamily: "beyaz", sealedCount: 4 })],
      esikSabit(1), 1, TEMEL
    );
    expect(cipler.filter((c) => c.colorKey === "beyaz")).toHaveLength(1);
    expect(cipler.find((c) => c.colorKey === "beyaz")!.sealed).toBe(4);
  });

  it("aynı AİLEDEN başka bir ton, temel rengin yerini TUTMAZ", () => {
    // "Mermer" ve "Fildişi" açık tonlu oldukları için `beyaz` ailesine düşüyor. Aile
    // karşılaştırılsaydı elde mermer varken beyaz "var" sayılır ve beyazın bittiği gizlenirdi.
    const cipler = renkCipleri(
      [grup({ colorKey: "mermer", colorName: "Mermer", colorFamily: "beyaz", sealedCount: 2 })],
      esikSabit(1), 1, TEMEL
    );
    const beyaz = cipler.find((c) => c.colorKey === "beyaz");
    expect(beyaz).toBeDefined();
    expect(beyaz!.sealed).toBe(0);
    expect(beyaz!.durum).toBe("biten");
  });
});

describe("renkCipleri — izlenen (stoğu tükenmiş) renkler", () => {
  it("izlenen renk canlı kaydı olmasa da çip olarak kalır", () => {
    // Zil "PETG Natural bitti" derken sayfada o rengin izi olmaması, kullanıcıyı
    // listesinde bulamadığı bir renkle alışverişe yollardı.
    const cipler = renkCipleri(
      [grup({ colorKey: "kirmizi", sealedCount: 4 })],
      esikSabit(1), 1, TEMEL,
      [{ key: "PETG__natural", label: "Natural PETG" }]
    );
    const natural = cipler.find((c) => c.key === "PETG__natural");
    expect(natural).toBeDefined();
    expect(natural!.sealed).toBe(0);
    expect(natural!.durum).toBe("biten");
    expect(natural!.label).toBe("Natural PETG");
  });

  it("izlenen renk temel renkle ÇAKIŞMAZ (gri iki kez çizilmez)", () => {
    const cipler = renkCipleri([], esikSabit(1), 1, TEMEL, [{ key: "PLA__gri" }]);
    expect(cipler.filter((c) => c.colorKey === "gri")).toHaveLength(1);
  });

  it("canlı kaydı olan izlenen renk tekrar eklenmez", () => {
    const cipler = renkCipleri(
      [grup({ colorKey: "kirmizi", sealedCount: 4 })],
      esikSabit(1), 1, [], [{ key: "PLA__kirmizi" }]
    );
    expect(cipler.filter((c) => c.colorKey === "kirmizi")).toHaveLength(1);
    expect(cipler[0].sealed).toBe(4);
  });

  it("etiketi olmayan izlenen renk anahtarından okunabilir ad üretir", () => {
    const cipler = renkCipleri([], esikSabit(1), 1, [], [{ key: "PETG__natural" }]);
    expect(cipler[0].label).toBe("Natural PETG");
  });
});

describe("durum eşiği", () => {
  it("eşiğin ÜSTÜ yeterli, eşik ve altı azalan, sıfır biten", () => {
    const cipler = renkCipleri(
      [
        grup({ colorKey: "a", sealedCount: 3 }),
        grup({ colorKey: "b", sealedCount: 2 }),
        grup({ colorKey: "c", sealedCount: 0 }),
      ],
      esikSabit(2), 2, []
    );
    expect(cipler.map((c) => c.durum)).toEqual(["yeterli", "azalan", "biten"]);
  });

  it("renge özel eşik genel eşiği ezer", () => {
    const cipler = renkCipleri(
      [grup({ colorKey: "a", sealedCount: 3 })],
      (g) => (g.key === "PLA__a" ? 5 : 1),
      1, []
    );
    expect(cipler[0].durum).toBe("azalan");
  });
});

describe("filtrele", () => {
  const cipler = renkCipleri(
    [
      grup({ colorKey: "kirmizi", colorName: "Kırmızı", sealedCount: 4 }),
      grup({ colorKey: "mavi", colorName: "Mavi", sealedCount: 1 }),
      grup({ colorKey: "sari", colorName: "Sarı", sealedCount: 0 }),
    ],
    esikSabit(1), 1, []
  );

  it("'biten' YALNIZ sıfırları verir — eşiği 0'a çekme numarasının yerine geçer", () => {
    expect(filtrele(cipler, "biten", "").map((c) => c.colorName)).toEqual(["Sarı"]);
  });

  it("'azalan' hem azalanı hem biteni verir (ikisi de sipariş demek)", () => {
    expect(filtrele(cipler, "azalan", "").map((c) => c.colorName).sort()).toEqual(["Mavi", "Sarı"]);
  });

  it("'hepsi' hiçbirini elemez", () => {
    expect(filtrele(cipler, "hepsi", "")).toHaveLength(3);
  });

  it("arama Türkçe küçük harfe duyarsızdır", () => {
    expect(filtrele(cipler, "hepsi", "KIRMIZI").map((c) => c.colorName)).toEqual(["Kırmızı"]);
    expect(filtrele(cipler, "hepsi", "sarı").map((c) => c.colorName)).toEqual(["Sarı"]);
  });

  it("arama ile filtre birlikte çalışır", () => {
    expect(filtrele(cipler, "biten", "mavi")).toEqual([]);
  });
});

describe("bolumlere", () => {
  it("temel renkler HER ZAMAN ilk bölümdür", () => {
    const cipler = renkCipleri(
      [grup({ colorKey: "kirmizi", colorName: "Kırmızı", sealedCount: 9 })],
      esikSabit(1), 1, TEMEL
    );
    const bolumler = bolumlere(cipler);
    expect(bolumler[0].baslik).toBe("Temel renkler");
    expect(bolumler[0].cipler.every((c) => (TEMEL_RENKLER as readonly string[]).includes(c.colorKey))).toBe(true);
    expect(bolumler[1].baslik).toBe("Diğer renkler");
  });

  it("aile eşleşen ton üst bölüme SIZMAZ", () => {
    // Mermer beyaz ailesinden ama beyaz DEĞİL; yeri "Diğer renkler".
    const cipler = renkCipleri(
      [grup({ colorKey: "mermer", colorName: "Mermer", colorFamily: "beyaz", sealedCount: 2 })],
      esikSabit(1), 1, TEMEL
    );
    const bolumler = bolumlere(cipler);
    expect(bolumler[0].cipler.map((c) => c.colorName)).not.toContain("Mermer");
    expect(bolumler[1].cipler.map((c) => c.colorName)).toContain("Mermer");
  });

  it("çipler AÇIKTAN KOYUYA sıralanır", () => {
    const cipler = renkCipleri(
      [
        grup({ colorKey: "a", colorName: "Koyu", colorHex: "#111827", sealedCount: 5 }),
        grup({ colorKey: "b", colorName: "Açık", colorHex: "#f9fafb", sealedCount: 5 }),
        grup({ colorKey: "c", colorName: "Orta", colorHex: "#9ca3af", sealedCount: 5 }),
      ],
      esikSabit(1), 1, []
    );
    expect(bolumlere(cipler)[0].cipler.map((c) => c.colorName)).toEqual(["Açık", "Orta", "Koyu"]);
  });

  it("sıralama stok durumuna göre DEĞİŞMEZ", () => {
    // Kritiklik sırası kullanılsaydı bir makara eklenip çıktıkça çipler yer değiştirir,
    // kullanıcı aradığı rengi her açılışta başka yerde bulurdu.
    const yap = (koyuAdet: number, acikAdet: number) =>
      bolumlere(
        renkCipleri(
          [
            grup({ colorKey: "a", colorName: "Koyu", colorHex: "#111827", sealedCount: koyuAdet }),
            grup({ colorKey: "b", colorName: "Açık", colorHex: "#f9fafb", sealedCount: acikAdet }),
          ],
          esikSabit(1), 1, []
        )
      )[0].cipler.map((c) => c.colorName);
    expect(yap(5, 5)).toEqual(["Açık", "Koyu"]);
    expect(yap(0, 5)).toEqual(["Açık", "Koyu"]); // koyu bitti ama yeri değişmedi
    expect(yap(5, 0)).toEqual(["Açık", "Koyu"]);
  });

  it("boş çip listesi bölüm üretmez", () => {
    expect(bolumlere([])).toEqual([]);
  });
});

describe("acikligi", () => {
  it("beyaz en yüksek, siyah en düşük", () => {
    expect(acikligi("#ffffff")).toBeCloseTo(1, 3);
    expect(acikligi("#000000")).toBeCloseTo(0, 3);
  });

  it("göz duyarlılığını hesaba katar — sarı maviden AÇIKTIR", () => {
    // Ham RGB ortalamasıyla sıralansaydı ikisi de 0.33 çıkar, sıra rastgeleleşirdi.
    expect(acikligi("#facc15")).toBeGreaterThan(acikligi("#2563eb"));
  });

  it("bozuk renk kodu listeyi uçlara savurmaz", () => {
    expect(acikligi("bozuk")).toBe(0.5);
    expect(acikligi("")).toBe(0.5);
  });
});

describe("stokOzeti", () => {
  it("hiç alınmamış temel renk 'renk sayısına' girmez", () => {
    // Ekranda 3 çip görünür ama sahip olunan renk 1'dir — özet şişirilmemeli.
    const cipler = renkCipleri([grup({ colorKey: "kirmizi", sealedCount: 4 })], esikSabit(1), 1, TEMEL);
    const ozet = stokOzeti(cipler);
    expect(ozet.toplam).toBe(4);
    expect(ozet.renk).toBe(1);
    expect(ozet.sorunlu).toBe(3); // siyah + gri + beyaz
  });

  it("biten ve azalan AYRI sayılır", () => {
    // Tek sayıya harmanlanınca gerçekten biten renk, "bir makarası kalmış" yığınında kaybolur.
    const cipler = renkCipleri(
      [
        grup({ colorKey: "a", sealedCount: 0 }),
        grup({ colorKey: "b", sealedCount: 1 }),
        grup({ colorKey: "c", sealedCount: 1 }),
        grup({ colorKey: "d", sealedCount: 9 }),
      ],
      esikSabit(1), 1, []
    );
    const ozet = stokOzeti(cipler);
    expect(ozet.biten).toBe(1);
    expect(ozet.azalan).toBe(2);
    expect(ozet.sorunlu).toBe(3);
    expect(ozet.toplam).toBe(11);
  });
});

describe("alisverisListesi", () => {
  it("stoğu biten temel renk listeye GİRER", () => {
    // Asıl hata buydu: liste uyarılardan üretilince, kaydı silinmiş renk listeye hiç girmezdi.
    const cipler = renkCipleri([grup({ colorKey: "kirmizi", sealedCount: 9 })], esikSabit(1), 1, TEMEL);
    const metin = alisverisListesi(cipler);
    expect(metin).toContain("Siyah PLA");
    expect(metin).toContain("Gri PLA");
    expect(metin).not.toContain("kirmizi");
  });

  it("eşiğin BİR ÜSTÜNE çıkacak adet ister", () => {
    const cipler = renkCipleri([grup({ colorKey: "a", colorName: "A", sealedCount: 1 })], esikSabit(2), 2, []);
    expect(alisverisListesi(cipler)).toBe("a PLA ×2"); // 2 - 1 + 1
  });

  it("susturulan renk listeye girmez", () => {
    const cipler = renkCipleri([grup({ colorKey: "a", sealedCount: 0 })], esikSabit(1), 1, []);
    expect(alisverisListesi(cipler, ["PLA__a"])).toBe("");
  });

  it("her şey yeterliyse liste boştur", () => {
    const cipler = renkCipleri([grup({ colorKey: "a", sealedCount: 9 })], esikSabit(1), 1, []);
    expect(alisverisListesi(cipler)).toBe("");
  });

  it("en kritik renk listenin başındadır", () => {
    const cipler = renkCipleri(
      [
        grup({ colorKey: "az", colorName: "Az", sealedCount: 1 }),
        grup({ colorKey: "yok", colorName: "Yok", sealedCount: 0 }),
      ],
      esikSabit(1), 1, []
    );
    expect(alisverisListesi(cipler).indexOf("yok")).toBeLessThan(alisverisListesi(cipler).indexOf("az"));
  });
});
