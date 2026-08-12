import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { veriDurumu } from "./ModelFilesCard";

/**
 * Ürün detayındaki kartlar hata aldıklarında "başarılı" gibi davranıyordu:
 *
 * 1) Varyant etiketi kaydedilemediği halde "Etiket güncellendi" deniyordu — yazma isteğinin
 *    cevabı `r.json()` ile doğrudan çözülüyor, HTTP durumu hiç bakılmıyordu. Hata gövdesi de
 *    geçerli JSON olduğu için mutasyon BAŞARILI sayılıyordu.
 * 2) Baskı dosyaları çekilemediğinde liste boş kalıyor ve kart "Henüz parça yok" diyordu —
 *    kullanıcı yüklü dosyalarını yok sanıyordu.
 *
 * Kural: BİLİNMEYEN ≠ SIFIR. "Veri yok" ile "veri alınamadı" asla aynı ekranı göstermez.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const oku = (gorecelYol: string) => readFileSync(path.join(REPO_ROOT, gorecelYol), "utf8");

const SAYFA = oku("src/app/products/[id]/page.tsx");
const VARYANTLAR = oku("src/components/products/VariantsCard.tsx");
const MODELLER = oku("src/components/products/ModelFilesCard.tsx");
const FIYAT_LAB = oku("src/components/products/PriceLabCard.tsx");

/** Kontrolsüz "cevabı çöz, başarı say" kalıbı: `}).then((r) => r.json()),` */
const KONTROLSUZ_YAZMA = /\}\)\.then\(\(r\) => r\.json\(\)\)/;

describe("liste durumu — boş olmak ile alınamamak ayrı şeylerdir", () => {
  it("hata, boş listeyle karıştırılmaz", () => {
    expect(veriDurumu(false, true, 0)).toBe("hata");
    expect(veriDurumu(false, false, 0)).toBe("bos");
  });

  it("yükleme sırasında 'boş' denmez", () => {
    expect(veriDurumu(true, false, 0)).toBe("yukleniyor");
  });

  it("hata yüklemeye baskındır — tekrar denerken bile durum 'hata' kalır", () => {
    expect(veriDurumu(true, true, 0)).toBe("hata");
  });

  it("veri geldiyse liste gösterilir", () => {
    expect(veriDurumu(false, false, 3)).toBe("dolu");
  });
});

describe("varyant kartı hatayı yutmaz", () => {
  it("yazma istekleri HTTP durumunu kontrol eder", () => {
    expect(VARYANTLAR).not.toMatch(KONTROLSUZ_YAZMA);
  });

  it("başarısız etiket kaydı kartın içinde tek cümleyle söylenir", () => {
    expect(VARYANTLAR).toContain("Etiket kaydedilemedi — eski adı duruyor.");
    expect(VARYANTLAR).toContain("Tekrar dene");
  });

  it("ürün seçici, liste alınamadığında 'ürün yok' demez", () => {
    expect(VARYANTLAR).toContain("Ürün listesi alınamadı.");
    expect(VARYANTLAR).toContain("Eklenebilecek ürün bulunamadı.");
    // Arama sonucu boş olmak da ayrı bir durumdur.
    expect(VARYANTLAR).toContain("Aramana uyan ürün yok.");
  });
});

describe("baskı dosyaları kartı hatayı yutmaz", () => {
  it("yazma istekleri HTTP durumunu kontrol eder", () => {
    expect(MODELLER).not.toMatch(KONTROLSUZ_YAZMA);
  });

  it("alınamayan liste için ayrı ekran ve tekrar denemesi var", () => {
    expect(MODELLER).toContain("Baskı dosyaları alınamadı.");
    expect(MODELLER).toContain("Yazıcı listesi alınamadı.");
    expect(MODELLER).toContain("Tekrar dene");
    // Boş liste mesajı yerinde duruyor ama artık yalnız veri GELDİĞİNDE görünür.
    expect(MODELLER).toContain("Henüz parça yok.");
  });

  it("yükleme sırasında iskelet gösterilir (boş/donuk alan yok)", () => {
    expect(MODELLER).toContain("<ModelIskeleti />");
  });
});

describe("fiyat laboratuvarı uyarıları kartın içinde", () => {
  it("uyarılar önerilen fiyatlarla aynı kartta gösterilir", () => {
    expect(FIYAT_LAB).toContain("{assumptionNotes}");
    expect(SAYFA).toContain("assumptionNotes={priceLabNotes}");
  });

  it("kartın dışındaki eski uyarı bloğu kaldırıldı", () => {
    expect(SAYFA).not.toContain('className="-mb-3"');
  });

  it("kurallar çekilemezse kart sonsuza kadar iskelet göstermez", () => {
    expect(FIYAT_LAB).toContain("Fiyat önerileri hesaplanamadı.");
    expect(SAYFA).toContain("failed={pricingRulesFailed}");
  });
});

describe("platform kartı gerçek durumu yazar", () => {
  it("pasif ilan sonsuza kadar 'Hesaplanıyor' demez", () => {
    expect(SAYFA).not.toContain("Hesaplanıyor...");
    expect(SAYFA).toContain("İlan şu an pasif — bu ürün için kâr hesaplanmıyor.");
  });

  it("hesap hazır değilken iskelet, hiç yapılamıyorsa tekrar denemesi gösterilir", () => {
    expect(SAYFA).toContain('profitState === "yukleniyor"');
    expect(SAYFA).toContain("Kâr hesaplanamadı.");
  });
});
