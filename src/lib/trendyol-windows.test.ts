/**
 * "Bildirim geldi ama sipariş listede yok" hatasının koruması.
 *
 * Trendyol'un startDate/endDate aralığı 2 haftayı aşarsa sorgu REDDEDİLMİYOR, sessizce
 * kırpılıyor — ve kırpılan uç pencerenin sonu, yani en yeni siparişler. 13 Ağu 2026'da
 * dilimler 14 gündü, saat dilimi payı iki uçtan ±3 saat ekleyince açıklık 14 gün 6 saate
 * çıktı ve son ~3 saatin siparişleri listeye hiç düşmedi.
 *
 * Bu testler tek bir şeyi kilitler: GÖNDERİLEN pencere sınırı aşmaz.
 */
import { describe, expect, it } from "vitest";
import {
  TRENDYOL_MAX_WINDOW_MS,
  TRENDYOL_WINDOW_PAD_MS,
} from "@/core/trendyol-date";
import {
  TRENDYOL_CHUNK_MS,
  buildTrendyolWindows,
  windowSpan,
} from "./trendyol-windows";

const GUN = 86_400_000;
const SAAT = 3_600_000;
const NOW = Date.parse("2026-08-13T20:26:49.000Z");
const gunOnce = (n: number) => NOW - n * GUN;

describe("trendyol pencereleri sınırı aşmaz", () => {
  it("HİÇBİR pencere 2 haftayı geçmez", () => {
    for (const gun of [7, 14, 30, 60, 90, 365]) {
      const windows = buildTrendyolWindows(NOW, gunOnce(gun));
      expect(windows.length).toBeGreaterThan(0);
      for (const w of windows) {
        expect(windowSpan(w)).toBeLessThanOrEqual(TRENDYOL_MAX_WINDOW_MS);
      }
    }
  });

  it("dilim boyu payı HESABA KATAR", () => {
    // Asıl hata: dilim tam sınıra eşitlenmiş, pay unutulmuştu.
    expect(TRENDYOL_CHUNK_MS + 2 * TRENDYOL_WINDOW_PAD_MS).toBe(TRENDYOL_MAX_WINDOW_MS);
    expect(TRENDYOL_CHUNK_MS).toBeLessThan(14 * GUN);
  });

  it("en yeni pencere ŞU ANI kapsar — tazelik buna bağlı", () => {
    const [ilk] = buildTrendyolWindows(NOW, gunOnce(60));
    expect(ilk.endDate).toBeGreaterThanOrEqual(NOW);
  });

  it("kaybolan sipariş artık pencerenin İÇİNDE", () => {
    // #11503693822, 13 Ağu 23:19 (TR). Trendyol damgası duvar saatini taşıdığı için
    // ham değeri "23:19 UTC"ye denk gelir; en kötü yorumda bile pencereye girmeli.
    const [ilk] = buildTrendyolWindows(NOW, gunOnce(60));
    const duvarSaatiDamgasi = Date.parse("2026-08-13T23:19:19.000Z");
    expect(duvarSaatiDamgasi).toBeLessThanOrEqual(ilk.endDate);

    // Sınırı aşan pencere Trendyol tarafından baştan itibaren kırpılsaydı görülebilecek
    // en yeni an bu olurdu — sipariş bunun dışında kalıyordu.
    const eskiKirpilmisSon = ilk.startDate + TRENDYOL_MAX_WINDOW_MS;
    expect(duvarSaatiDamgasi).toBeLessThanOrEqual(eskiKirpilmisSon);
  });

  it("pencereler 60 günü BOŞLUKSUZ kapsar", () => {
    const cutoff = gunOnce(60);
    const windows = buildTrendyolWindows(NOW, cutoff);
    // Yeniden eskiye: her pencerenin başı, bir öncekinin başından küçük olmalı ve
    // ham (paysız) dilimler uç uca değmeli — arada delik kalırsa sipariş kaybolur.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].endDate).toBeLessThan(windows[i - 1].endDate);
      // Paylar örtüşmeyi zaten garantiliyor: bir sonraki pencerenin sonu, öncekinin
      // başından SONRA gelmeli.
      expect(windows[i].endDate).toBeGreaterThan(windows[i - 1].startDate);
    }
    const enEski = windows[windows.length - 1];
    expect(enEski.startDate).toBeLessThanOrEqual(cutoff);
  });

  it("çok kısa geçmişte tek pencere yeter", () => {
    const windows = buildTrendyolWindows(NOW, NOW - 2 * SAAT);
    expect(windows).toHaveLength(1);
    expect(windowSpan(windows[0])).toBeLessThanOrEqual(TRENDYOL_MAX_WINDOW_MS);
  });

  it("geçmiş sınırı gelecekteyse pencere üretilmez", () => {
    expect(buildTrendyolWindows(NOW, NOW + GUN)).toEqual([]);
  });
});
