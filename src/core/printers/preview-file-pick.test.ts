/**
 * KART GÖRSELİ HANGİ DOSYADAN? — sahada görülen hatanın kalıcı koruması.
 *
 * Bir ürünün aynı yazıcıda birden çok parçası olabiliyor ("gövde", "kapak", …). Görseli
 * ÜRÜNE göre seçmek, çok parçalı üründe hangi parça basılırsa basılsın hep aynı resmi
 * gösteriyordu (Bambu / "All versions ams Mercedes", 17 Ağu 2026). Eşleşme BASILAN DOSYA
 * ADIYLA kurulmalı; ürüne göre geri düşüş yalnız ürünün TEK dosyası varsa güvenli.
 *
 * `getModelFilesForPreview` veritabanına gittiği için burada onun kurduğu haritanın
 * kuralları, aynı mantık saf biçimde yeniden kurularak kilitleniyor.
 */
import { describe, expect, it } from "vitest";
import { deepFileMatchKey, fileMatchKey } from "./file-match";

type Satir = { id: string; productId: string; printerConfigId: string | null; originalName: string };

/** `getModelFilesForPreview` içindeki harita kurulumunun birebir aynısı. */
function haritaKur(rows: Satir[]) {
  const dosyaya = new Map<string, string>();
  const sayac = new Map<string, { id: string; adet: number }>();
  for (const r of rows) {
    if (!r.printerConfigId) continue;
    if (r.originalName) {
      for (const k of [fileMatchKey(r.originalName), deepFileMatchKey(r.originalName)]) {
        const anahtar = `${r.printerConfigId}::${k}`;
        if (!dosyaya.has(anahtar)) dosyaya.set(anahtar, r.id);
      }
    }
    const urunAnahtar = `${r.productId}|${r.printerConfigId}`;
    const mevcut = sayac.get(urunAnahtar);
    if (mevcut) mevcut.adet++;
    else sayac.set(urunAnahtar, { id: r.id, adet: 1 });
  }
  const urune = new Map<string, string>();
  for (const [a, v] of sayac) if (v.adet === 1) urune.set(a, v.id);
  return { dosyaya, urune };
}

/** Rotadaki seçim sırası. */
function sec(h: ReturnType<typeof haritaKur>, yaziciId: string, basilan: string, urunId: string | null) {
  return (
    h.dosyaya.get(`${yaziciId}::${fileMatchKey(basilan)}`) ??
    h.dosyaya.get(`${yaziciId}::${deepFileMatchKey(basilan)}`) ??
    (urunId ? h.urune.get(`${urunId}|${yaziciId}`) : undefined) ??
    null
  );
}

const COK_PARCALI: Satir[] = [
  { id: "govde", productId: "mercedes", printerConfigId: "bambu", originalName: "Gövde.gcode.3mf" },
  { id: "kapak", productId: "mercedes", printerConfigId: "bambu", originalName: "Kapak.gcode.3mf" },
  { id: "taban", productId: "mercedes", printerConfigId: "bambu", originalName: "Taban.gcode.3mf" },
];

describe("önizleme dosyası seçimi", () => {
  it("ÇOK PARÇALI üründe basılan parçanın kendi dosyası seçilir", () => {
    const h = haritaKur(COK_PARCALI);
    expect(sec(h, "bambu", "Kapak.gcode.3mf", "mercedes")).toBe("kapak");
    expect(sec(h, "bambu", "Taban.gcode.3mf", "mercedes")).toBe("taban");
    expect(sec(h, "bambu", "Gövde.gcode.3mf", "mercedes")).toBe("govde");
  });

  it("parçalar BİRBİRİNDEN farklı görsel verir — hepsi ilkine düşmez", () => {
    // Sahadaki hata tam buydu: üç parça da "govde" dönüyordu.
    const h = haritaKur(COK_PARCALI);
    const secimler = ["Gövde.gcode.3mf", "Kapak.gcode.3mf", "Taban.gcode.3mf"].map((f) =>
      sec(h, "bambu", f, "mercedes")
    );
    expect(new Set(secimler).size).toBe(3);
  });

  it("dosya adı eşleşmezse ÇOK PARÇALI üründe görsel verilmez", () => {
    // Yanlış parçayı göstermektense hiç göstermemek doğru — kart ürün fotoğrafına düşer.
    const h = haritaKur(COK_PARCALI);
    expect(sec(h, "bambu", "Bilinmeyen.gcode.3mf", "mercedes")).toBeNull();
  });

  it("TEK dosyalı üründe ad tutmasa da ürüne göre geri düşülür", () => {
    // Dosya yazıcıda yeniden adlandırılmış olabilir; belirsizlik yoksa göstermek güvenli.
    const h = haritaKur([
      { id: "tek", productId: "anahtarlik", printerConfigId: "u1", originalName: "Anahtarlik.gcode" },
    ]);
    expect(sec(h, "u1", "baska-ad.gcode", "anahtarlik")).toBe("tek");
  });

  it("ÇİFT UZANTI eşleşmeyi bozmaz — Bambu 'Parça.gcode.3mf' adlandırıyor", () => {
    // Yazıcı bazen `Kapak.gcode.3mf`, bazen `Kapak.gcode`, bazen klasör önekiyle bildiriyor.
    // Üçü de aynı dosyaya düşmeli, yoksa kart sessizce görselsiz kalır.
    const h = haritaKur(COK_PARCALI);
    for (const ad of ["Kapak.gcode.3mf", "Kapak.gcode", "cache/Kapak.gcode", "Kapak.3mf"]) {
      expect(sec(h, "bambu", ad, "mercedes")).toBe("kapak");
    }
  });

  it("BAŞKA yazıcının dosyası seçilmez", () => {
    const h = haritaKur(COK_PARCALI);
    expect(sec(h, "u1", "Kapak.gcode.3mf", "mercedes")).toBeNull();
  });
});
