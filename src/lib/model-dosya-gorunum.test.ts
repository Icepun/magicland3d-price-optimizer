import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  baskiDosyasiMi, bilgiEksik, bitisMetni, fmtGram, fmtSure, gorunenAd, grupOzeti, ozetMetni, renkleriCoz,
  turEtiketi, uzantisizAd,
} from "./model-dosya-gorunum";
import { bilgiyiIsle } from "./dosya-bilgisi";

/**
 * 12 Eki 2026 — Baskı Dosyaları kartı: satırda yalnız dosya adı ve boyutu yazıyordu. Süre,
 * gramaj ve önizleme dosyanın içinde olduğu halde yüklemede okunup ATILIYORDU.
 */
describe("süre ve gramaj yazımı", () => {
  it("süre saat + dakika; bilinmeyen '—' (BİLİNMEYEN ≠ SIFIR)", () => {
    expect(fmtSure(138)).toBe("2sa 18dk");
    expect(fmtSure(120)).toBe("2sa");
    expect(fmtSure(45)).toBe("45dk");
    expect(fmtSure(null)).toBe("—");
    expect(fmtSure(0)).toBe("—");
  });

  it("gram Türkçe ondalıkla; 100 gr üstünde küsurat yok", () => {
    expect(fmtGram(61.4)).toBe("61,4 gr");
    expect(fmtGram(240.6)).toBe("241 gr");
    expect(fmtGram(null)).toBe("—");
    expect(fmtGram(0)).toBe("—");
  });
});

describe("satır adı", () => {
  it("verilen ad önceliklidir; yoksa dosya adı uzantısız gösterilir", () => {
    expect(gorunenAd({ label: "Gövde", originalName: "PS5 Dual Color.3mf" })).toBe("Gövde");
    expect(gorunenAd({ label: null, originalName: "PS5 Dual Color.3mf" })).toBe("PS5 Dual Color");
    expect(gorunenAd({ label: "   ", originalName: "kapak.gcode" })).toBe("kapak");
  });

  it("çift uzantı (.gcode.3mf) tek seferde atılır; uzantısız ad bozulmaz", () => {
    expect(uzantisizAd("vazo.gcode.3mf")).toBe("vazo");
    expect(uzantisizAd("vazo")).toBe("vazo");
    expect(uzantisizAd(".3mf")).toBe(".3mf");
  });

  it("tür rozeti", () => {
    expect(turEtiketi("3mf")).toBe("3MF");
    expect(turEtiketi("gcode")).toBe("GCODE");
    expect(turEtiketi("gco")).toBe("GCODE");
  });
});

describe("renkler", () => {
  const json = (colors: unknown[]) => JSON.stringify({ colors, source: "3mf-sliceinfo", fileKind: "3mf" });

  it("harcanan renk biliniyorsa yalnız onlar gösterilir", () => {
    const j = json([
      { index: 0, hex: "#ff0000", type: "PLA", grams: 12 },
      { index: 1, hex: "#00ff00", type: "PLA", grams: 0 },
      { index: 2, hex: "#0000ff", type: "PLA", grams: 3.5 },
    ]);
    expect(renkleriCoz(j)).toEqual(["#FF0000", "#0000FF"]);
  });

  it("harcama bilinmiyorsa hepsi; geçersiz renk atlanır", () => {
    const j = json([
      { index: 0, hex: "#111111", type: "PLA", grams: null },
      { index: 1, hex: "kirmizi", type: "PLA", grams: null },
      { index: 2, hex: "#222222", type: "PLA", grams: null },
    ]);
    expect(renkleriCoz(j)).toEqual(["#111111", "#222222"]);
  });

  it("boş ya da bozuk kayıt çökertmez", () => {
    expect(renkleriCoz(null)).toEqual([]);
    expect(renkleriCoz("{bozuk")).toEqual([]);
    expect(renkleriCoz(JSON.stringify({ colors: "yok" }))).toEqual([]);
  });
});

describe("toplam (bir yazıcıdaki tüm parçalar)", () => {
  it("hepsi biliniyorsa düz toplam", () => {
    const o = grupOzeti([
      { gramaj: 61.4, estPrintMin: 138 },
      { gramaj: 20, estPrintMin: 42 },
    ]);
    expect(o).toEqual({ sureDk: 180, gram: 81.4, sureEksik: false, gramEksik: false });
    expect(ozetMetni(o)).toBe("3sa · 81,4 gr");
  });

  it("eksik parça varsa toplam ALT SINIRDIR — sonuna + konur, sıfır sayılmaz", () => {
    const o = grupOzeti([
      { gramaj: 61.4, estPrintMin: 138 },
      { gramaj: null, estPrintMin: null },
    ]);
    expect(o.sureEksik).toBe(true);
    expect(ozetMetni(o)).toBe("2sa 18dk+ · 61,4 gr+");
  });

  it("hiçbiri bilinmiyorsa toplam yazılmaz", () => {
    expect(ozetMetni(grupOzeti([{ gramaj: null, estPrintMin: null }]))).toBeNull();
  });
});

describe("eksik bilgi ve sürükle-bırak", () => {
  it("süre, gramaj ya da önizlemeden biri yoksa dosya okunmalıdır", () => {
    expect(bilgiEksik({ gramaj: 10, estPrintMin: 30, hasThumbnail: true })).toBe(false);
    expect(bilgiEksik({ gramaj: 10, estPrintMin: 30, hasThumbnail: false })).toBe(true);
    expect(bilgiEksik({ gramaj: null, estPrintMin: 30, hasThumbnail: true })).toBe(true);
    expect(bilgiEksik({ gramaj: 10, hasThumbnail: true })).toBe(true);
  });

  it("yalnız baskı dosyaları kabul edilir", () => {
    expect(baskiDosyasiMi("a.3mf")).toBe(true);
    expect(baskiDosyasiMi("a.GCODE")).toBe(true);
    expect(baskiDosyasiMi("a.gco")).toBe(true);
    expect(baskiDosyasiMi("a.stl")).toBe(false);
    expect(baskiDosyasiMi("a.png")).toBe(false);
  });
});

describe("yükleme ucu dosyadaki bilgiyi artık ATMIYOR", () => {
  const KOK = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const yukleme = readFileSync(path.join(KOK, "src/app/api/products/[id]/models/route.ts"), "utf8");
  const kart = readFileSync(path.join(KOK, "src/components/products/ModelFilesCard.tsx"), "utf8");

  it("süre, gramaj ve önizleme satıra yazılır (bulut ve yerel yol)", () => {
    expect(yukleme.match(/thumbnail: gorsel/g)?.length).toBe(2);
    expect(yukleme.match(/dosyaGram = olcum\(paket\.meta\.grams\)/g)?.length).toBe(2);
    expect(yukleme.match(/dosyaSure = olcum\(paket\.meta\.estPrintMin\)/g)?.length).toBe(2);
  });

  it("yanıt hafiftir: görselin kendisi değil 'var mı' bilgisi döner", () => {
    expect(yukleme.match(/NextResponse\.json\(hafifYanit\(mine\)/g)?.length).toBe(2);
    expect(yukleme).not.toMatch(/NextResponse\.json\(mine,/);
  });

  it("kart yeni satırı önizlemesiyle gösterir ve adı değiştirilebilir", () => {
    expect(kart).toContain("created.push(hafifSatir(row as ModelFile))");
    expect(kart).toContain('title="Adı değiştir"');
    // Görsel ve bilgi satırı ORTAK bileşenden — baskı ekranlarıyla aynı görünsün.
    expect(kart).toContain("<ParcaGorseli p={part}");
    expect(kart).toContain("<ParcaBilgiSatiri p={part}");
  });
});

/**
 * 13 Eki 2026, Berke: "baskıyı başlatırken de bu bilgileri görsek harika olur … şu anda çok sade
 * görünüyor ve ne basıyorum anlamıyorum". Baskı listeleri yalnız dosya adı + gramaj yazıyordu.
 */
describe("baskıyı başlatırken: ne basıyorum?", () => {
  const KOK = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const oku = (yol: string) => readFileSync(path.join(KOK, yol), "utf8");
  const ortak = oku("src/components/printers/parca-gorunum.tsx");

  it("tahmini bitiş: bugün saat, gece yarısını aşınca 'yarın'", () => {
    const ogle = new Date(2026, 9, 13, 14, 0).getTime();
    expect(bitisMetni(ogle, 220)).toBe("17:40");
    expect(bitisMetni(new Date(2026, 9, 13, 22, 30).getTime(), 220)).toBe("yarın 02:10");
    expect(bitisMetni(ogle, 36 * 60)).toBe("2 gün sonra 02:00"); // 13'ü 14:00 + 36 sa = 15'i 02:00
  });

  it("süre ya da saat bilinmiyorsa bitiş saati UYDURULMAZ", () => {
    const ogle = new Date(2026, 9, 13, 14, 0).getTime();
    expect(bitisMetni(ogle, null)).toBeNull();
    expect(bitisMetni(ogle, 0)).toBeNull();
    expect(bitisMetni(0, 120)).toBeNull(); // saat henüz bilinmiyor (sunucu çizimi)
  });

  it("dosyadan okunan bilgi yalnız EKSİK alanı doldurur, eldekini ezmez", () => {
    const satir = { gramaj: 61.4, estPrintMin: null as number | null, hasThumbnail: false };
    expect(bilgiyiIsle(satir, { gramaj: 99, estPrintMin: 138, hasThumbnail: true })).toEqual({
      gramaj: 99, estPrintMin: 138, hasThumbnail: true,
    });
    // Okunamayan (null) alan eldeki değeri SIFIRLAMAZ.
    expect(bilgiyiIsle({ gramaj: 61.4, estPrintMin: 138, hasThumbnail: true }, { gramaj: null, estPrintMin: null })).toEqual({
      gramaj: 61.4, estPrintMin: 138, hasThumbnail: true,
    });
  });

  it("ortak görünüm süre, gramaj, renk ve bitiş saatini çizer", () => {
    expect(ortak).toContain("fmtSure(p.estPrintMin)");
    expect(ortak).toContain("fmtGram(p.gramaj)");
    expect(ortak).toContain("<RenkNoktalari");
    expect(ortak).toContain("bitisMetni(simdi, p.estPrintMin)");
  });

  it("üç baskı ekranı da ortak görünümü kullanır", () => {
    const yazicilar = oku("src/app/printers/page.tsx");
    const hizli = oku("src/components/products/ProductPrintModal.tsx");
    const kutuphane = oku("src/app/models/page.tsx");
    for (const [ad, kaynak] of [["Yazıcılar", yazicilar], ["Ürünler", hizli], ["Modeller", kutuphane]] as const) {
      expect(kaynak, ad).toContain("<ParcaGorseli");
      expect(kaynak, ad).toContain("<ParcaBilgiSatiri");
      // Eski dosyaların bilgisi listeyi açınca arka planda dolar.
      expect(kaynak, ad).toContain("useEksikBilgiyiTamamla(");
    }
    // Son adımda büyük özet kartı: renk eşleme ve tek renkli onay.
    expect(oku("src/components/printers/print-flow.tsx")).toContain("<ParcaOzetKarti");
    expect(yazicilar).toContain("<ParcaOzetKarti");
  });

  it("yazıcının basılabilir dosyaları süre, renk ve önizleme bilgisiyle döner", () => {
    const uc = oku("src/app/api/printers/[id]/printable-models/route.ts");
    for (const alan of ["estPrintMin: f.estPrintMin", "hasThumbnail: gorselli.has(f.id)", "renkler: renkleriCoz(f.colorsJson)"]) {
      expect(uc).toContain(alan);
    }
    // Görselin KENDİSİ listeyle gelmez (satır başına ~61 KB) — yalnız "var mı".
    expect(uc).not.toMatch(/thumbnail:\s*true/);
  });
});
