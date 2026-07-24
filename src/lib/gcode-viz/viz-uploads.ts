"use client";
/**
 * Yükleme-aktiflik sayacı — three/WebGL İÇERMEZ (kasıtlı ayrı modül).
 *
 * Arka plan görselleştirme üretimi (viz-pipeline) bu sayaç >0 iken BEKLER; böylece 27MB parse +
 * WebGL render, aktif yükleme/dosya diyaloğuyla yarışıp arayüzü kilitlemez (v0.19.99 donması).
 *
 * Neden ayrı modül: viz-pipeline three-scene'i (→ three, ~539KB) statik import ediyor. Sayaç
 * viz-pipeline içinde kalsaydı, yalnız setUploadsActive kullanan sayfalar (Yazıcılar, Ürün detay)
 * bile three grafiğini initial bundle'a çekerdi. Burada three'ye HİÇ dokunulmadığından güvenli.
 *
 * ⚠️ TEK KAYNAK: uploadsActive/setUploadsActive/waitUploadsIdle yalnız BURADA. viz-pipeline
 * waitUploadsIdle'ı buradan import eder — kopyalarsa iki ayrı sayaç oluşur ve arka plan üretimi
 * yüklemeyi beklemez (donma regresyonu geri gelir).
 */
let uploadsActive = 0;

/** Yükleme başlarken +1, biterken -1. */
export function setUploadsActive(delta: number): void {
  uploadsActive = Math.max(0, uploadsActive + delta);
}

/** Yükleme(ler) bitene kadar bekle — arka plan varlık üretimi bunu bekler. */
export async function waitUploadsIdle(): Promise<void> {
  while (uploadsActive > 0) await new Promise((r) => setTimeout(r, 400));
}
