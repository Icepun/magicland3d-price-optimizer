import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TRENDYOL_MAX_WINDOW_MS } from "@/core/trendyol-date";
import { buildTrendyolWindows, windowSpan } from "@/core/trendyol-windows";

/**
 * TELEFON TRENDYOL PENCERELERİ — masaüstüyle AYNI çekirdek fonksiyon.
 *
 * Masaüstü 13 Ağu 2026'da "14 gün + 2×3 saat pay" hatasını düzeltti (Trendyol 2 haftayı aşan
 * aralığı sessizce kırpıp EN YENİ siparişleri atıyor). Düzeltme masaüstüne özel `src/lib`
 * altında kaldığı için telefon 23 Eyl'e kadar tam 14 günlük dilimlerle çekmeye devam etti:
 * canlı ölçümde 22:46 ve 22:57 siparişleri telefonda yoktu. Pencere hesabı artık `src/core`
 * altında ve telefon onu içe aktarıyor.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("telefon pencereleri çekirdekten", () => {
  const kaynak = oku("mobile/src/lib/api/trendyol.ts");

  it("buildTrendyolWindows kullanılıyor", () => {
    expect(kaynak).toContain('from "@core/trendyol-windows"');
    expect(kaynak).toContain("buildTrendyolWindows(Date.now(), cutoff)");
  });

  it("elle kurulmuş 14 günlük dilim KALMADI", () => {
    expect(kaynak).not.toMatch(/14\s*\*\s*86_?400_?000/);
    expect(kaynak).not.toContain("padTrendyolWindow(");
  });

  it("çekirdek kopyası masaüstüyle birebir", () => {
    expect(oku("mobile/src/core/trendyol-windows.ts")).toBe(oku("src/core/trendyol-windows.ts"));
  });
});

describe("telefonun kullandığı 60 günlük çekim sınırı aşmıyor", () => {
  it("her pencere ≤ 14 gün ve en yenisi ŞİMDİ ile biter", () => {
    const simdi = Date.parse("2026-09-23T21:21:04.877Z");
    const kesim = (Math.floor(simdi / 86_400_000) - 60) * 86_400_000;
    const pencereler = buildTrendyolWindows(simdi, kesim);
    for (const w of pencereler) expect(windowSpan(w)).toBeLessThanOrEqual(TRENDYOL_MAX_WINDOW_MS);
    // En yeni pencere şimdiye (3 saat payla) uzanır: son saatlerin siparişi dışarıda kalamaz.
    expect(pencereler[0].endDate).toBe(simdi + 3 * 3600_000);
  });
});
