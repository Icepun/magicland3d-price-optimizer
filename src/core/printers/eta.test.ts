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

/**
 * GERİ SAYIM ZIPLAMASI — kullanıcı "baskının bitiş süresi tahmini çok değişken" dedi.
 *
 * Sebep ölçüldü: ilerleme M73'ten %1'lik ADIMLARLA gelir, süre ise sürekli akar. İki adım
 * arasında payda sabitken `geçen/ilerleme` şişer, yani KALAN SÜRE ARTAR; sonraki adımda geri
 * düşer. İki saatlik baskının benzetiminde kalan süre 1149 kez artıyor, toplam 157 dakika
 * yanlış yöne gidiyor, en büyük tek sıçrama 448 saniyeydi.
 */
describe("geri sayım düzgün akar (dondurulmuş hız)", () => {
  /** Gerçek koşul: %1 adımlı ilerleme, 5 saniyede bir örnek. */
  function kosu(donmusHizKullan: boolean) {
    const TOPLAM = 2 * 3600;
    let hafiza: { progress: number; totalSec: number } | null = null;
    let onceki: number | null = null;
    let artis = 0;
    let enBuyukSicrama = 0;
    for (let t = 0; t <= TOPLAM; t += 5) {
      const progress = Math.floor((t / TOPLAM) * 100) / 100;
      const r = resolveEta({
        progress, elapsedSec: t, slicerEstimateSec: TOPLAM,
        prev: donmusHizKullan ? hafiza : null,
      });
      if (r.totalSec != null) hafiza = { progress, totalSec: r.totalSec };
      if (r.remainingSec == null) continue;
      if (onceki != null) {
        const fark = r.remainingSec - onceki;
        if (fark > 0) artis++;
        enBuyukSicrama = Math.max(enBuyukSicrama, Math.abs(fark + 5));
      }
      onceki = r.remainingSec;
    }
    return { artis, enBuyukSicrama };
  }

  it("dondurulmuş hız ZIPLAMAYI neredeyse tamamen bitirir", () => {
    const eski = kosu(false);
    const yeni = kosu(true);
    // Ölçülen: 1149 → 19 artış, 448sn → 19sn en büyük sıçrama.
    expect(eski.artis).toBeGreaterThan(500);
    expect(yeni.artis).toBeLessThan(50);
    expect(yeni.enBuyukSicrama).toBeLessThan(60);
    expect(yeni.artis).toBeLessThan(eski.artis / 10);
  });

  it("ilerleme İLERLEYİNCE hız yeniden ölçülür (donmuş değer yapışmaz)", () => {
    // %20'de (harman bölgesinin üstünde) ölçüm esastır: 1800sn / 0,20 = 9000sn.
    const ilk = resolveEta({ progress: 0.2, elapsedSec: 1800, slicerEstimateSec: 6000 });
    expect(ilk.totalSec).toBe(9000);
    // İlerleme arttı → YENİ ölçüm esas alınır, donmuş toplam yapışmaz: 3000 / 0,30 = 10000.
    const sonra = resolveEta({
      progress: 0.3, elapsedSec: 3000, slicerEstimateSec: 6000,
      prev: { progress: 0.2, totalSec: 9000 },
    });
    expect(sonra.totalSec).toBe(10000);
  });

  it("ilerleme GERİ giderse (yeni dosya) donmuş hız BIRAKILIR", () => {
    const r = resolveEta({
      progress: 0.02, elapsedSec: 60, slicerEstimateSec: 3600,
      prev: { progress: 0.9, totalSec: 20000 },
    });
    // 0,02 ile 0,9 arası fark çok büyük → eski hız taşınmamalı.
    expect(r.totalSec).not.toBe(20000);
  });

  it("yazıcının KENDİ kalan süresi varsa donmuş hız devreye girmez (Bambu)", () => {
    const r = resolveEta({
      progress: 0.5, elapsedSec: 1800, printerRemainingSec: 1200,
      prev: { progress: 0.5, totalSec: 99999 },
    });
    expect(r.source).toBe("printer");
    expect(r.remainingSec).toBe(1200);
  });
});
