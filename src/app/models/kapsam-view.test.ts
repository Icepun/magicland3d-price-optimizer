/**
 * Model Kütüphanesi — kapsama tablosu.
 *
 * 13 Eki 2026, Berke: "burada amacım hangi modellerin dosyası var hangisi yok onu görmek …
 * u1 alt ve u1 üstün ayrı ayrı yazılmasına gerek yok". Eski sayfa yalnız dosyası OLAN ürünleri
 * listeliyordu (481 görünür ürünün 328'i hiç görünmüyordu) ve her yazıcıya ayrı bölme açıyordu.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hucreAciklamasi, kapsamAileleri, kapsamOzeti, modelSatirlari, satirAra, satirSirala, satirUyar, varyantAdi,
  type KapsamUrunu,
} from "./kapsam-view";

const YAZICILAR = [
  { id: "u1-alt", name: "Snapmaker U1 Alt", type: "moonraker", brand: "snapmaker", model: "U1" },
  { id: "a1", name: "Bambu Lab A1 Combo", type: "bambu", brand: "bambu", model: "A1" },
  { id: "u1-ust", name: "Snapmaker U1 Üst", type: "moonraker", brand: "snapmaker", model: "U1" },
  { id: "a2l", name: "Bambu Lab A2L Combo", type: "bambu", brand: "bambu", model: "A2L" },
];
const AILELER = kapsamAileleri(YAZICILAR);

let sayac = 0;
const dosya = (printerConfigId: string, md5: string, ad = `${md5}.gcode`, boyut = 100) => ({
  id: `f${++sayac}`, printerConfigId, label: null, originalName: ad, sizeBytes: boyut, contentMd5: md5.padEnd(32, "0"),
});
const urun = (id: string, name: string, files: ReturnType<typeof dosya>[], grup: string | null = null): KapsamUrunu => ({
  productId: id, name, imageUrl: null, files, totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
  variantGroupId: grup, variantGroupName: grup ? `Grup ${grup}` : null,
});

describe("yazıcı aileleri — iki U1 TEK sütun", () => {
  it("aynı marka + modeldeki yazıcılar birleşir; sıra ilk görülene göre", () => {
    expect(AILELER.map((a) => a.kisaAd)).toEqual(["U1", "A1", "A2L"]);
    expect(AILELER[0].ad).toBe("Snapmaker U1");
    expect(AILELER[0].yazicilar.map((y) => y.id)).toEqual(["u1-alt", "u1-ust"]);
  });

  it("modeli girilmemiş yazıcı kendi sütununda kalır (kimseyle eşleştirilmez)", () => {
    const a = kapsamAileleri([
      { id: "x", name: "Eski Yazıcı", type: "moonraker", brand: "elegoo", model: null },
      { id: "y", name: "Diğer Yazıcı", type: "moonraker", brand: "elegoo", model: null },
    ]);
    expect(a).toHaveLength(2);
    expect(a[0].ad).toBe("Eski Yazıcı");
  });

  it("iki ayrı aile aynı kısaltmaya düşerse tam ad kullanılır", () => {
    const a = kapsamAileleri([
      { id: "x", name: "Bambu A1", type: "bambu", brand: "bambu", model: "A1" },
      { id: "y", name: "Başka A1", type: "moonraker", brand: "acme", model: "A1" },
    ]);
    expect(new Set(a.map((x) => x.kisaAd)).size).toBe(2);
  });
});

describe("satırlar — dosyası OLMAYAN ürün de listelenir", () => {
  const urunler = [
    urun("1", "Vazo", [dosya("u1-alt", "v"), dosya("a1", "v2"), dosya("a2l", "v3")]),
    urun("2", "Kalemlik", [dosya("u1-ust", "k")]),
    urun("3", "Anahtarlık", []),
  ];
  const satirlar = modelSatirlari(urunler, AILELER);
  const bul = (ad: string) => satirlar.find((s) => s.ad === ad)!;

  it("üç durum: tam, eksik, hiç yok", () => {
    expect(bul("Vazo").durum).toBe("tam");
    expect(bul("Kalemlik").durum).toBe("eksik");
    expect(bul("Anahtarlık").durum).toBe("yok");
  });

  it("kardeş U1'e yüklenen dosya U1 sütununu doldurur", () => {
    expect(bul("Kalemlik").hucreler.map((h) => h.durum)).toEqual(["var", "yok", "yok"]);
  });

  it("aynı dosya iki U1'e ayrı yüklendiyse bir parça sayılır", () => {
    const [s] = modelSatirlari([urun("9", "Çift", [dosya("u1-alt", "ayni"), dosya("u1-ust", "ayni")])], AILELER);
    expect(s.hucreler[0].parca).toBe(1);
    expect(s.parca).toBe(1);
  });

  it("özet: kaç modelin dosyası var / yok, yazıcı başına kapsama", () => {
    expect(kapsamOzeti(satirlar, AILELER)).toEqual({ toplam: 3, dosyali: 2, dosyasiz: 1, aileVar: [2, 1, 1] });
  });
});

describe("varyantlar tek satır", () => {
  const ps5 = () => [dosya("u1-alt", "ps5")];
  const urunler = [
    urun("1", "Kol Standı — PS5 / Altın", ps5(), "g1"),
    urun("2", "Kol Standı — PS5 / Bakır", ps5(), "g1"),
    urun("3", "Kol Standı — Xbox / Altın", [], "g1"),
    urun("4", "Tek Ürün", [dosya("a1", "t")]),
  ];
  const satirlar = modelSatirlari(urunler, AILELER);
  const grup = satirlar.find((s) => s.urunler.length > 1)!;

  it("aynı gruptaki ürünler tek satırda toplanır, ad ortak tabandır", () => {
    expect(satirlar).toHaveLength(2);
    expect(grup.ad).toBe("Kol Standı");
    expect(grup.urunler.map((u) => u.productId)).toEqual(["1", "2", "3"]);
  });

  it("bazı varyantlarda yoksa hücre KISMİ — kaç varyantta olduğu yazar", () => {
    const h = grup.hucreler[0];
    expect(h).toMatchObject({ durum: "kismi", varyantVar: 2, varyantToplam: 3, parca: 1 });
    expect(hucreAciklamasi(h, "Snapmaker U1")).toBe("Snapmaker U1: 3 varyantın 2 tanesinde var");
    expect(grup.durum).toBe("eksik");
  });

  it("paylaşılan dosya satır toplamında bir kez sayılır", () => {
    expect(grup.parca).toBe(1);
    expect(grup.boyut).toBe(100);
  });

  it("alt satırlar varyant başına hücre taşır ve yalnız varyant adını gösterir", () => {
    expect(grup.varyantHucreleri.map((v) => v[0].durum)).toEqual(["var", "var", "yok"]);
    expect(varyantAdi(grup.urunler[2], grup.ad)).toBe("Xbox / Altın");
    expect(varyantAdi({ ...grup.urunler[0], name: "Bambaşka Ad" }, grup.ad)).toBe("Bambaşka Ad");
  });

  it("varyantların dosyaları FARKLIYSA işaretlenir (parçalar tek varyanta indirgenemez)", () => {
    const [ayni] = modelSatirlari([
      urun("1", "X — Mor", [dosya("u1-alt", "x")], "g"),
      urun("2", "X — Mavi", [dosya("u1-alt", "x")], "g"),
    ], AILELER);
    const [farkli] = modelSatirlari([
      urun("1", "Y — PS5", [dosya("u1-alt", "ps5")], "g"),
      urun("2", "Y — Xbox", [dosya("u1-alt", "xbox")], "g"),
    ], AILELER);
    expect(ayni.hucreler[0]).toMatchObject({ durum: "var", ayniDosyalar: true });
    expect(farkli.hucreler[0]).toMatchObject({ durum: "var", ayniDosyalar: false });
  });

  it("ortak taban yoksa grubun adı kullanılır", () => {
    const [s] = modelSatirlari([urun("1", "Kırmızı Stant", [], "g7"), urun("2", "Mavi Stant", [], "g7")], AILELER);
    expect(s.ad).toBe("Grup g7");
  });
});

describe("süzme", () => {
  const satirlar = modelSatirlari(
    [
      urun("1", "Tam", [dosya("u1-alt", "a"), dosya("a1", "b"), dosya("a2l", "c")]),
      urun("2", "Yalnız U1", [dosya("u1-alt", "d")]),
      urun("3", "Boş", []),
      urun("4", "Kısmi — Mor", [dosya("a1", "e")], "g"),
      urun("5", "Kısmi — Mavi", [], "g"),
    ],
    AILELER,
  );
  const adlar = (f: Parameters<typeof satirUyar>[2]) => satirlar.filter((s) => satirUyar(s, AILELER, f)).map((s) => s.ad);
  const u1 = AILELER[0].anahtar;
  const a1 = AILELER[1].anahtar;

  it("dosyası var / yok", () => {
    expect(adlar({ tur: "dosyali" })).toEqual(["Tam", "Yalnız U1", "Kısmi"]);
    expect(adlar({ tur: "dosyasiz" })).toEqual(["Boş"]);
    expect(adlar({ tur: "tumu" })).toHaveLength(4);
  });

  it("yazıcıya göre: var olanlar / eksik olanlar", () => {
    expect(adlar({ tur: "aile", aile: u1, durum: "var" })).toEqual(["Tam", "Yalnız U1"]);
    expect(adlar({ tur: "aile", aile: u1, durum: "yok" })).toEqual(["Boş", "Kısmi"]);
  });

  it("kısmen dolu satır 'eksik' sayılır — bazı varyantların hâlâ dosyası yok", () => {
    expect(adlar({ tur: "aile", aile: a1, durum: "yok" })).toContain("Kısmi");
    expect(adlar({ tur: "aile", aile: a1, durum: "var" })).toEqual(["Tam"]);
  });

  it("silinmiş yazıcıya ait süzgeç listeyi boşaltmaz", () => {
    expect(adlar({ tur: "aile", aile: "yok-boyle-aile", durum: "yok" })).toHaveLength(4);
  });
});

describe("arama ve sıralama", () => {
  const satirlar = modelSatirlari(
    [
      urun("1", "Çanta Askısı", [dosya("u1-alt", "a", "Dark Lord PS5 19s55dk.gcode", 900)]),
      urun("2", "Ahtapot — Mor", [dosya("u1-alt", "b"), dosya("a1", "c"), dosya("a2l", "d")], "g"),
      urun("3", "Ahtapot — Şeker Pembe", [dosya("u1-alt", "b"), dosya("a1", "c"), dosya("a2l", "d")], "g"),
      urun("4", "Bardak", []),
    ],
    AILELER,
  );

  it("model adında, VARYANT adında ve parça adında arar", () => {
    const ahtapot = satirlar.find((s) => s.ad === "Ahtapot")!;
    const canta = satirlar.find((s) => s.ad === "Çanta Askısı")!;
    expect(satirAra(ahtapot, "ahtapot")).toEqual({ eslesti: true, eslesenParca: 0 });
    expect(satirAra(ahtapot, "seker pembe").eslesti).toBe(true); // diakritiksiz yazım
    expect(satirAra(canta, "dark lord")).toEqual({ eslesti: true, eslesenParca: 1 });
    expect(satirAra(canta, "bisiklet").eslesti).toBe(false);
    expect(satirAra(canta, "  ").eslesti).toBe(true);
  });

  it("ada göre Türkçe sıralar; 'eksikler önce' doldurulacak işi öne alır", () => {
    expect(satirSirala(satirlar, "ad").map((s) => s.ad)).toEqual(["Ahtapot", "Bardak", "Çanta Askısı"]);
    expect(satirSirala(satirlar, "eksik").map((s) => s.ad)).toEqual(["Bardak", "Çanta Askısı", "Ahtapot"]);
    expect(satirSirala(satirlar, "boyut")[0].ad).toBe("Çanta Askısı");
    expect(satirSirala(satirlar, "parca")[0].ad).toBe("Ahtapot");
  });

  it("girdi dizisini DEĞİŞTİRMEZ", () => {
    const kopya = [...satirlar];
    satirSirala(satirlar, "boyut");
    expect(satirlar).toEqual(kopya);
  });
});

describe("kütüphane ucu ve önbellek", () => {
  const KOK = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const oku = (yol: string) => readFileSync(path.join(KOK, yol), "utf8");

  it("uç TÜM görünür ürünleri döndürür (dosyası olmayan dahil)", () => {
    const uc = oku("src/app/api/models/route.ts");
    expect(uc).toContain("prisma.product.findMany(");
    expect(uc).toContain("if (!u.hidden) satirAc(u)");
    expect(uc).toContain("variantGroupId");
  });

  it("dosya yazan HER uç kütüphane önbelleğini düşürür — yoksa liste 2 dakika eski kalır", () => {
    for (const yol of [
      "src/app/api/products/[id]/models/route.ts",
      "src/app/api/models/[id]/route.ts",
      "src/app/api/models/[id]/gramaj/route.ts",
    ]) {
      expect(oku(yol), yol).toContain("bustModelCaches()");
    }
    // Yükleme (bulut + yerel) ve ad değiştirme + silme.
    expect(oku("src/app/api/products/[id]/models/route.ts").match(/bustModelCaches\(\)/g)?.length).toBe(2);
    expect(oku("src/app/api/models/[id]/route.ts").match(/bustModelCaches\(\)/g)?.length).toBe(2);
  });

  it("ürün değişince de düşer: kütüphane artık tüm ürünleri listeliyor", () => {
    const bust = oku("src/lib/cache-busting.ts");
    expect(bust.match(/"models:"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
