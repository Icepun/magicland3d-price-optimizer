/**
 * FİYAT YENİLEMESİ HANGİ EKRANLARI TAZELİYOR — sessiz bayatlığın kalıcı koruması.
 *
 * React Query öneke göre eşleştirir ama `["products"]` (liste) ile `["product", id]` (detay)
 * FARKLI anahtarlardır. Yenileme yalnız çoğul olanı geçersiz kılıyordu; kullanıcı fiyatları
 * yeniledikten sonra ürün detayında ESKİ fiyatı görüyor ve sayfayı elle yenilemek zorunda
 * kalıyordu (sahada bildirildi, 17 Ağu 2026).
 *
 * Bileşen testi kurulu değil (RTL yok) → kaynak düzeyinde koruma.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LISTE = readFileSync(join(process.cwd(), "src/app/products/page.tsx"), "utf8");
const DETAY = readFileSync(join(process.cwd(), "src/app/products/[id]/page.tsx"), "utf8");

/** Yenileme akışındaki invalidate bloğunu ayıkla (toast'a kadar). */
function yenilemeBlogu(): string {
  const bas = LISTE.indexOf('setRefreshProgress({ total, done, label: "Liste & panel güncelleniyor…" })');
  expect(bas).toBeGreaterThan(0);
  return LISTE.slice(bas, bas + 1400);
}

describe("fiyat yenileme sonrası tazelenen anahtarlar", () => {
  const blok = yenilemeBlogu();

  it("liste tazeleniyor", () => {
    expect(blok).toContain('queryKey: ["products"]');
  });

  it("ÜRÜN DETAYI da tazeleniyor", () => {
    // Asıl hata buydu: detay anahtarı listede yoktu.
    expect(blok).toContain('queryKey: ["product"]');
  });

  it("fiyata bağlı türev ekranlar da tazeleniyor", () => {
    expect(blok).toContain('queryKey: ["profit-preview"]');
    expect(blok).toContain('queryKey: ["price-lab"]');
  });

  it("panel ve sipariş ekranları unutulmamış", () => {
    expect(blok).toContain('queryKey: ["dashboard"]');
    expect(blok).toContain('queryKey: ["orders"]');
  });
});

describe("detay sayfasının per-ürün anahtarları", () => {
  /**
   * Detayda YENİ bir per-ürün sorgusu açılırsa burada karar vermek ZORUNLU olsun:
   * ya fiyat yenilemesinde tazelenir, ya da aşağıdaki listeye gerekçesiyle eklenir.
   * Amaç, "yeni sorgu ekledim ama yenilemeye koymayı unuttum" hatasını sessiz bırakmamak —
   * sahada tam bu oldu: fiyat yenilendi, detay eski fiyatı göstermeye devam etti.
   */
  const FIYATTAN_BAGIMSIZ: Record<string, string> = {
    // Baskı dosyaları listesi — fiyatla ilgisi yok; tazelemek gereksiz sorgu olur.
    "product-models": "baskı dosyaları; fiyattan etkilenmez",
  };

  /** Detay dosyasındaki `queryKey: ["ad", id]` kalıplarını regex'siz topla. */
  function perUrunAnahtarlar(kaynak: string): Set<string> {
    const bulunan = new Set<string>();
    const ONEK = 'queryKey: ["';
    let i = kaynak.indexOf(ONEK);
    while (i >= 0) {
      const adBas = i + ONEK.length;
      const adSon = kaynak.indexOf('"', adBas);
      if (adSon > adBas) {
        const ad = kaynak.slice(adBas, adSon);
        const kalan = kaynak.slice(adSon + 1, adSon + 16);
        if (kalan.startsWith(", id]") || kalan.startsWith(", productId]")) bulunan.add(ad);
      }
      i = kaynak.indexOf(ONEK, adBas);
    }
    return bulunan;
  }

  it("her per-ürün anahtarı ya tazeleniyor ya da gerekçeli muaf", () => {
    const blok = yenilemeBlogu();
    const perUrun = perUrunAnahtarlar(DETAY);

    // Test kendi kendini kandırmasın: tarama gerçekten bir şey bulmalı.
    expect(perUrun.has("product")).toBe(true);
    expect(perUrun.size).toBeGreaterThanOrEqual(3);

    for (const anahtar of perUrun) {
      if (anahtar in FIYATTAN_BAGIMSIZ) continue;
      expect(
        blok,
        `"${anahtar}" detayda per-ürün sorgu olarak kullanılıyor ama fiyat yenilemesinde ` +
          "tazelenmiyor. Ya invalidate listesine ekle ya da FIYATTAN_BAGIMSIZ'a gerekçesiyle yaz.",
      ).toContain(`queryKey: ["${anahtar}"]`);
    }
  });
});
