import { describe, expect, it } from "vitest";
import { baglanacakUrunler, benzerlikPuani, sadeMetin } from "./urun-bagla-oneri";

const urun = (id: string, name: string, over: Record<string, string | null> = {}) => ({ id, name, ...over });

describe("sadeMetin", () => {
  it("Türkçe harfleri ve noktalamayı sadeleştirir", () => {
    expect(sadeMetin("Cars - Piston Kupası")).toBe("cars piston kupasi");
    expect(sadeMetin("İĞNE ŞİŞ Çöp Ü")).toBe("igne sis cop u");
  });
});

describe("ürün önerileri", () => {
  const urunler = [
    urun("a", "Kedi Figürü"),
    urun("b", "Piston Kupasi", { variantLabel: "20 cm" }),
    urun("c", "Cars Piston Kupası — 25 cm"),
    urun("d", "Vazo"),
  ];

  const idler = (r: ReturnType<typeof baglanacakUrunler>) => r.liste.map((x) => x.urun.id);

  it("arama boşken satır adına en çok benzeyen üstte, benzemeyen listede yok", () => {
    const r = baglanacakUrunler("Cars - Piston Kupası", urunler, "");
    expect(r.tur).toBe("oneri");
    expect(idler(r)).toEqual(["c", "b"]);
    expect(benzerlikPuani("Cars - Piston Kupası", urunler[2])).toBe(3);
  });

  it("hiç benzeyen yoksa tüm ürünler ad sırasıyla", () => {
    const r = baglanacakUrunler("Uzay Gemisi", urunler, "");
    expect(r.tur).toBe("tumu");
    expect(idler(r)).toEqual(["c", "a", "b", "d"]);
  });

  it("aramada tüm kelimeler aranır, varyant adı da sayılır", () => {
    const r = baglanacakUrunler("Cars - Piston Kupası", urunler, "kupası 20");
    expect(r.tur).toBe("arama");
    expect(idler(r)).toEqual(["b"]);
    expect(idler(baglanacakUrunler("Cars - Piston Kupası", urunler, "vazo"))).toEqual(["d"]);
  });

  it("azami sayıyı aşmaz", () => {
    const cok = Array.from({ length: 100 }, (_, i) => urun(`u${i}`, `Piston ${i}`));
    expect(baglanacakUrunler("Piston", cok, "", 10).liste).toHaveLength(10);
  });
});
