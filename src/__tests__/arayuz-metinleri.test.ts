import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Arayüz metinleri SON KULLANICIYA hitap eder: geliştirici notu, mekanizma anlatımı ve
 * teknik terim (gcode, AMS, listing, fallback, Moonraker, izin anahtarı adı, durum kodu…)
 * ekrana çıkmaz. Bu terimler tek tek geri sızma eğiliminde olduğu için gerileme testiyle
 * kilitliyoruz: aşağıdaki ifadeler tekrar eklenirse test kırılır.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function oku(gorecelYol: string): string {
  return readFileSync(path.join(REPO_ROOT, gorecelYol), "utf8");
}

/** Dosya → o dosyada ARTIK bulunmaması gereken arayüz ifadeleri. */
const YASAKLI_IFADELER: Record<string, string[]> = {
  "src/components/printers/print-flow.tsx": [
    "AMS slotuna",
    "AMS kullan",
    "gcode bu seçime göre",
    "slot sırasına göre",
    "Timelapse (",
    "Yazıcıdaki slotlar",
    "akış beklenmedik kapandı",
    "`HTTP ${",
  ],
  "src/components/printers/CustomPrintLibrary.tsx": ["gcode/3mf yükleyince"],
  "src/app/printers/page.tsx": [
    "Moonraker — Elegoo",
    "gcode/3mf dosyası",
    "gcode / 3mf seç",
    "Access Code",
    "IP / Host",
    "Önce IP/host gir",
    "Nozzle {nozzle}",
  ],
  "src/app/commission-rules/page.tsx": ["fallback için", "listing&apos;inde"],
  "src/app/products/page.tsx": [
    "listings ve fiyat geçmişi",
    "no-sku",
    "Yeni Urun Ekle",
    "Urun Adi",
    "Satis Fiyati",
    "Urun Maliyeti",
    "(geri alındı)",
  ],
  "src/app/models/page.tsx": ["sonraki güncellemede", "renk/slot eşle"],
  "src/app/reports/page.tsx": [
    "iade/iptalleri yenilenir",
    "sürerse hata:",
    "sipariş/paket kaydında",
  ],
  "src/app/settings/page.tsx": [
    "libSQL",
    "local DB",
    "local veritabanı",
    "GitHub Releases",
    "JSON Dışa Aktar",
    "JSON İçe Aktar",
    "Auth Token",
    "Database URL",
    "listing,",
  ],
  "src/app/api-settings/page.tsx": [
    "unauthenticated_read_product_listings",
    "unauthenticated_read_product_inventory",
    "read_orders",
    "Storefront token",
    "Storefront API",
    "Admin API",
    "Bu örneği bana iletirsen",
    "Client ID",
    "Client Secret",
    "Seller ID",
    "Integrator Name",
    "eşleşmemiş havuzda",
    "listing&apos;leri",
  ],
};

/** Yerine geçen, son kullanıcıya hitap eden karşılıklar gerçekten yerinde mi? */
const BEKLENEN_IFADELER: Record<string, string[]> = {
  "src/components/printers/print-flow.tsx": [
    "Çok renkli besleyiciyi kullan",
    "hangi makarayı kullanacağını seç",
  ],
  "src/components/printers/CustomPrintLibrary.tsx": ["baskı dosyası yükleyince"],
  "src/app/printers/page.tsx": ["Baskı dosyası seç", "Erişim Kodu", "IP Adresi"],
  "src/app/commission-rules/page.tsx": ["genel bir kural"],
  "src/app/products/page.tsx": ["platform ilanları ve fiyat geçmişi"],
  "src/app/settings/page.tsx": ["Cihazlar Arası Senkron", "Yedeği İndir"],
  "src/app/api-settings/page.tsx": ["Platform Bağlantıları", "Teknik ayrıntı"],
};

describe("arayüz metinleri son kullanıcıya hitap eder", () => {
  for (const [dosya, ifadeler] of Object.entries(YASAKLI_IFADELER)) {
    it(`${dosya} içinde teknik/geliştirici dili kalmadı`, () => {
      const icerik = oku(dosya);
      const bulunanlar = ifadeler.filter((ifade) => icerik.includes(ifade));
      expect(bulunanlar).toEqual([]);
    });
  }

  for (const [dosya, ifadeler] of Object.entries(BEKLENEN_IFADELER)) {
    it(`${dosya} sade Türkçe karşılıkları içeriyor`, () => {
      const icerik = oku(dosya);
      const eksikler = ifadeler.filter((ifade) => !icerik.includes(ifade));
      expect(eksikler).toEqual([]);
    });
  }

  it("yazıcı hata ayrıntısı gizli bir bölümde tutuluyor", () => {
    const icerik = oku("src/app/printers/page.tsx");
    // Cihazın ham hata metni doğrudan karta basılmaz; "Ayrıntı" başlığı altında açılır.
    expect(icerik).toContain("Ayrıntı");
    expect(icerik).not.toContain("{printer.statusMessage || job?.productName");
  });
});
