/**
 * Baskı kartındaki AD — "okunamayan dosya adı" gerilemesinin koruması.
 *
 * Kart, yazıcının bildirdiği ham dosya adını gösteriyordu:
 *   "EN4Plus 0.4 PS5+Dummy+Controller+Display Generic PLA 0.2 3h36m-65b2a0d971.gcode"
 * Sondaki 10 haneli imza bizim eklediğimiz içerik kimliği; yazıcı modeli, nozzle çapı, malzeme,
 * katman yüksekliği ve süre dilimleyiciden kalan artıklar. Kullanıcının görmesi gereken tek şey
 * ürünün adı.
 *
 * Aşağıdaki adların hepsi 12 Ağu'da dört yazıcıdan CANLI okundu (üç Moonraker + Bambu A1).
 *
 * ⚠️ Bu yalnız GÖSTERİM adıdır: eşleştirme (`normalizeModelFileName` / `fileMatchKey`) ham addan
 * üretilmeye devam eder, içerik imzası kimlik olarak korunur.
 */
import { describe, expect, it } from "vitest";
import { printJobDisplayName } from "./print-job-name";
import { extractContentSignature, normalizeModelFileName } from "./print-file-signature";

describe("baskı adı temizleme (canlı dosya adları)", () => {
  it("keşif listesindeki örnek: profil/malzeme/süre/imza artıkları gider", () => {
    expect(printJobDisplayName("EN4Plus 0.4 PS5+Dummy+Controller+Display Generic PLA 0.2 3h36m-65b2a0d971.gcode"))
      .toBe("PS5 Dummy Controller Display");
  });

  it("Neptune 4 Pro — Türkçe ad ve süre eki (2s1dk)", () => {
    expect(printJobDisplayName("Darth Kol Gövde 2s1dk-8d28f87e04.gcode")).toBe("Darth Kol Gövde");
  });

  it("Neptune 4 Plus — 3s32dk", () => {
    expect(printJobDisplayName("Darth Kol Bacak 3s32dk-9e997568b1.gcode")).toBe("Darth Kol Bacak");
  });

  it("Snapmaker U1 — ürün adındaki PS5 KORUNUR (yazıcı modeli sanılmaz)", () => {
    expect(printJobDisplayName("Dark Lord PS5 19s55dk-4c655543a7.gcode")).toBe("Dark Lord PS5");
  });

  it("Bambu A1 — zincirli uzantı, alt çizgi, plaka eki ve yazıcı kodu", () => {
    expect(printJobDisplayName("PISTON_CUP_P1S_plate_1.gcode-90b29c4d56.3mf")).toBe("PISTON CUP");
  });

  it("klasör öneki atılır", () => {
    expect(printJobDisplayName("klasor/alt/Kupa Altligi 45dk-1234abcd90.gcode")).toBe("Kupa Altligi");
  });

  it("her şey artıksa ham ada geri döner (boş başlık gösterme)", () => {
    expect(printJobDisplayName("PLA 0.2 3h36m.gcode")).toBe("PLA 0.2 3h36m");
  });

  it("boş ad boş kalır", () => {
    expect(printJobDisplayName("")).toBe("");
  });
});

/**
 * Temizleyici ürün adının ANLAMLI parçalarını da eliyordu: "3D" süre eki sanılıyor, addaki tek
 * sayı ve kısa yazıcı kodu koşulsuz atılıyordu. Sonuç: "Ejderha 2" ile "Ejderha 3" kartta AYNI
 * ada iniyor, kullanıcı hangi varyantın basıldığını ayırt edemiyordu.
 * Modülün kendi ilkesi: yanlış eleme, kalan artıktan daha kötüdür.
 */
describe("ürün adının anlamlı parçaları KORUNUR", () => {
  it("'3D' süre eki sanılmaz", () => {
    expect(printJobDisplayName("3D Kalemlik.gcode")).toBe("3D Kalemlik");
    expect(printJobDisplayName("Magicland 3D Logo.gcode")).toBe("Magicland 3D Logo");
    // Gerçek süre eki yine gider.
    expect(printJobDisplayName("3D Kalemlik 45dk-1234abcd90.gcode")).toBe("3D Kalemlik");
  });

  it("addaki varyant sayısı korunur (Ejderha 2 ≠ Ejderha 3)", () => {
    expect(printJobDisplayName("Ejderha 2.gcode")).toBe("Ejderha 2");
    expect(printJobDisplayName("Ejderha 3.gcode")).toBe("Ejderha 3");
    expect(printJobDisplayName("Kupa 350.gcode")).toBe("Kupa 350");
    expect(printJobDisplayName("Vazo v2.gcode")).toBe("Vazo v2");
  });

  it("kısa yazıcı kodu adın ORTASINDA/SONUNDA korunur", () => {
    expect(printJobDisplayName("Robot A1.gcode")).toBe("Robot A1");
    expect(printJobDisplayName("Masa Standi U1.gcode")).toBe("Masa Standi U1");
  });

  it("kısa yazıcı kodu dilimleyici kalıbında (başta ya da plaka ekinden önce) elenir", () => {
    expect(printJobDisplayName("A1 Kalemlik.gcode")).toBe("Kalemlik");
    expect(printJobDisplayName("Kalemlik_P1S_plate_1.gcode")).toBe("Kalemlik");
  });

  it("nozzle/katman ondalıkları ve plaka numarası yine elenir", () => {
    expect(printJobDisplayName("Kalemlik 0.4 0.2 plate_2.gcode")).toBe("Kalemlik");
  });
});

describe("kimlik BOZULMAZ", () => {
  const raw = "Darth Kol Gövde 2s1dk-8d28f87e04.gcode";

  it("içerik imzası ham addan hâlâ okunur", () => {
    expect(extractContentSignature(raw)).toBe("8d28f87e04");
  });

  it("eşleştirme anahtarı gösterim adından ETKİLENMEZ", () => {
    expect(normalizeModelFileName(raw)).toBe(normalizeModelFileName("Darth Kol Gövde 2s1dk.gcode"));
  });
});
