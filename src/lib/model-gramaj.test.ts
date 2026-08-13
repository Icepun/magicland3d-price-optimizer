/**
 * MODEL DOSYASI GRAMAJI ÜRÜN MALİYETİNE SIZMAMALI — Berke'nin açık şartı.
 *
 * Berke ürünlerin filament maliyetini KENDİ hesaplayıp elle giriyor ("başka şekillerde de
 * hesaplayıp elle girebiliyorum, ortalık karışır"). Modeller sayfasındaki gramaj yalnız
 * yazıcılar arası karşılaştırma içindir: aynı ürünün Snapmaker dosyası 84 gr, Bambu dosyası
 * 61 gr olabilir ve o farkı görmek "hangi makinede basayım" sorusunu cevaplar.
 *
 * İKİ AYRI ALAN, hiç karşılaşmamalı:
 *   `ProductCost.filamentWeight` → elle girilen; kâr/maliyet/"gram başına kazanç" kaynağı
 *   `ProductModelFile.gramaj`    → dosyadan okunan; YALNIZ gösterim
 *
 * Bu test kaynak taramasıyla sızıntıyı kilitler. Tip sistemi bunu yakalayamaz: iki alan da
 * `number | null` ve birinden diğerine atama tamamen geçerli TypeScript'tir.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");

function kaynakDosyalari(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      kaynakDosyalari(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("model dosyası gramajı ↔ ürün maliyeti yalıtımı", () => {
  const dosyalar = kaynakDosyalari(ROOT);

  it("kaynak taraması gerçekten çalışıyor (test kendini kandırmasın)", () => {
    expect(dosyalar.length).toBeGreaterThan(100);
    expect(dosyalar.some((f) => f.endsWith("model-gramaj.ts"))).toBe(true);
  });

  it("`filamentWeight` alanına model dosyasının gramajı ATANMIYOR", () => {
    // Aynı satırda hem `filamentWeight` hem `gramaj` geçiyorsa büyük ihtimalle atama vardır.
    const ihlaller: string[] = [];
    for (const file of dosyalar) {
      const src = fs.readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return; // yorum
        if (/filamentWeight/.test(line) && /\bgramaj\b/.test(line)) {
          ihlaller.push(`${path.relative(ROOT, file)}:${i + 1} → ${line.trim()}`);
        }
      });
    }
    expect(ihlaller).toEqual([]);
  });

  it("gramaj yazan TEK yer model dosyası kaydı — ProductCost'a yazan yok", () => {
    const yazanlar: string[] = [];
    for (const file of dosyalar) {
      const src = fs.readFileSync(file, "utf8");
      // `productCost.update/create/upsert` çağrısının veri gövdesinde `gramaj` geçmemeli.
      if (/productCost\.(update|create|upsert)/.test(src)) {
        const bloklar = src.split(/productCost\.(?:update|create|upsert)/).slice(1);
        for (const blok of bloklar) {
          const gövde = blok.slice(0, 600);
          if (/\bgramaj\b/.test(gövde)) yazanlar.push(path.relative(ROOT, file));
        }
      }
    }
    expect(yazanlar).toEqual([]);
  });

  it("SÜRE de ürün maliyetine sızmıyor — `printTimeHours` ayrı alan", () => {
    // Dosyanın süresi makineye göre değişir (aynı ürün Snapmaker'da 2sa18dk, Bambu'da 2sa27dk).
    // Ürün maliyetindeki süre Berke'nin ELLE girdiği değerdir: hangi makinede basacağı onun
    // kararı. Aynı satırda ikisinin geçmesi büyük ihtimalle atamadır.
    const ihlaller: string[] = [];
    for (const file of dosyalar) {
      const src = fs.readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (/printTimeHours/.test(line) && /estPrintMin/.test(line)) {
          ihlaller.push(`${path.relative(ROOT, file)}:${i + 1} → ${line.trim()}`);
        }
      });
    }
    expect(ihlaller).toEqual([]);
  });

  it("gramaj ucu YALNIZ ProductModelFile güncelliyor", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "app", "api", "models", "[id]", "gramaj", "route.ts"),
      "utf8"
    );
    // Tek yazma çağrısı olmalı ve hedefi ProductModelFile.
    const yazmalar = src.match(/prisma\.\w+\.(update|create|upsert|updateMany)/g) ?? [];
    expect(yazmalar).toEqual(["prisma.productModelFile.update"]);
    expect(src).not.toMatch(/productCost/);
  });

  it("okunamayan gramaj SIFIR olarak kaydedilmiyor", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "app", "api", "models", "[id]", "gramaj", "route.ts"),
      "utf8"
    );
    // BİLİNMEYEN ≠ SIFIR: `?? 0` ile doldurulursa dosya "0 gram" sanılır ve karşılaştırmada
    // en az filament harcayan makine YANLIŞ seçilir. Aynısı süre için de geçerli.
    expect(src).not.toMatch(/gramaj[^\n]*\?\?\s*0/);
    expect(src).not.toMatch(/estPrintMin[^\n]*\?\?\s*0/);
    // Yalnız GERÇEKTEN okunabilen alan yazılır; okunamayan eski değerinde kalır.
    expect(src).toMatch(/olcum\.gramaj != null/);
    expect(src).toMatch(/olcum\.estPrintMin != null/);
  });
});
