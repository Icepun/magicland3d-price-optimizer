/**
 * Kalan süre / ilerleme — U1'de KALAN SÜRENİN SAATLERCE ŞİŞMESİ gerilemesinin koruması.
 *
 * Kök neden: ilerleme `virtual_sdcard.progress`ten (dosyanın okunan BAYT oranı) alınıyordu.
 * Bayt oranı ZAMAN değil KONUM ölçer; destek ve ilk katmanlar az bayt/çok zaman harcadığı için
 * baskının başında hep GERİDE kalır. 12 Ağu canlı okuma (Snapmaker U1, gerçek baskı):
 *
 *   virtual_sdcard.progress = 0.1765      (bayt oranı)
 *   display_status.progress = 0.24        (dilimleyicinin M73 P zaman tahmini)
 *   print_stats.print_duration = 15082 sn
 *   gcode içindeki M73 satırı: "M73 P24 R904" → yazıcının kendi kalan süresi 904 dakika
 *
 * Bayt oranıyla: 15082 / 0.1765 = 85.4 bin sn toplam → ~19.5 saat kaldı (kartın gösterdiği).
 * M73 ile     : 15082 / 0.24   = 62.8 bin sn toplam → ~13.3 saat kaldı (gerçeğe yakın).
 * Fark ~6 saat. Bu yüzden ilerleme ÖNCE M73'ten okunmalı.
 */
import { describe, expect, it } from "vitest";
import { pickProgress, resolveEta } from "./eta";

describe("ilerleme kaynağı", () => {
  it("M73 (dilimleyici) varsa bayt oranını KULLANMAZ", () => {
    const p = pickProgress({ slicerProgress: 0.24, byteProgress: 0.1765 });
    expect(p.progress).toBeCloseTo(0.24, 4);
    expect(p.source).toBe("slicer");
  });

  it("M73 yoksa bayt oranına düşer", () => {
    const p = pickProgress({ slicerProgress: null, byteProgress: 0.1765 });
    expect(p.progress).toBeCloseTo(0.1765, 4);
    expect(p.source).toBe("bytes");
  });

  it("yazıcı kendi yüzdesini veriyorsa (Bambu) o esastır", () => {
    const p = pickProgress({ printerPercent: 12, slicerProgress: 0.5, byteProgress: 0.9 });
    expect(p.progress).toBeCloseTo(0.12, 4);
    expect(p.source).toBe("printer");
  });

  it("hiçbir kaynak yoksa 0 döner ama kaynağı 'none' işaretler", () => {
    expect(pickProgress({})).toEqual({ progress: 0, source: "none" });
  });

  it("0..1 dışına taşmaz", () => {
    expect(pickProgress({ printerPercent: 130 }).progress).toBe(1);
  });
});

describe("kalan süre", () => {
  it("U1 sahnesi: M73 ilerlemesiyle kalan süre ~6 saat kısalır", () => {
    const bayt = resolveEta({ progress: 0.1765, elapsedSec: 15082, slicerEstimateSec: 71709 });
    const m73 = resolveEta({ progress: 0.24, elapsedSec: 15082, slicerEstimateSec: 71709 });

    // Eski (hatalı) hesap 19 saatin üzerindeydi.
    expect(bayt.remainingSec! / 3600).toBeGreaterThan(19);
    // Yeni hesap 13-14 saat aralığında — yazıcının kendi M73 R'si (904 dk ≈ 15 sa, nominal
    // hızda) ile aynı büyüklükte; makine %150 hızda çalıştığı için biraz daha kısa çıkması doğru.
    expect(m73.remainingSec! / 3600).toBeGreaterThan(12.5);
    expect(m73.remainingSec! / 3600).toBeLessThan(14.5);
    expect(m73.source).toBe("measured");
  });

  it("yazıcının kendi kalan süresi (Bambu) her şeyi yener", () => {
    const r = resolveEta({
      progress: 0.12,
      elapsedSec: 5000,
      slicerEstimateSec: 99999,
      printerRemainingSec: 40320,
    });
    expect(r.remainingSec).toBe(40320);
    expect(r.totalSec).toBe(45320);
    expect(r.source).toBe("printer");
  });

  it("baskının hazırlık anında yazıcı 0 kalan derse buna İNANMAZ", () => {
    // Bambu hazırlık aşamasında mc_remaining_time=0 raporluyor; "bitti" demek değil.
    const r = resolveEta({ progress: 0.02, elapsedSec: 60, slicerEstimateSec: 7200, printerRemainingSec: 0 });
    expect(r.source).toBe("slicer");
    expect(r.remainingSec).toBeGreaterThan(6000);
  });

  it("erken evrede dilimleyici tahminini kullanır (ölçüm gürültüsünü büyütmez)", () => {
    const r = resolveEta({ progress: 0.02, elapsedSec: 300, slicerEstimateSec: 7250 });
    expect(r.source).toBe("slicer");
    expect(r.totalSec).toBe(7250);
  });

  it("%5–15 arasında harmanlar (kalan süre ANİ zıplamaz)", () => {
    const r = resolveEta({ progress: 0.07, elapsedSec: 582, slicerEstimateSec: 7250 });
    expect(r.source).toBe("blend");
    // Elegoo canlı okuması: 582 sn'de %7 → ölçüm 8314 sn, dilimleyici 7250 sn, ağırlık 0.2.
    expect(r.totalSec).toBeGreaterThan(7250);
    expect(r.totalSec).toBeLessThan(8314);
  });

  it("BİLİNMEYEN ≠ SIFIR: hiçbir kaynak yoksa null döner", () => {
    const r = resolveEta({ progress: 0, elapsedSec: null, slicerEstimateSec: null });
    expect(r.remainingSec).toBeNull();
    expect(r.totalSec).toBeNull();
    expect(r.source).toBe("unknown");
  });

  it("geçen süre bilinmiyorsa (Bambu) toplamı yüzdeden türetir", () => {
    const r = resolveEta({ progress: 0.25, elapsedSec: null, printerRemainingSec: 3600 });
    expect(r.totalSec).toBe(4800);
    expect(r.elapsedSec).toBe(1200);
  });
});
