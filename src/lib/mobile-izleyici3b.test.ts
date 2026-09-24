import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { izleyiciyiDerle } from "../../scripts/mobil-3b-paketle.mjs";

/**
 * TELEFONDAKİ 3B İZLEYİCİ — masaüstünün sahne kodu tek betiğe paketlenip telefona metin olarak
 * gider (`mobile/src/lib/izleyici3b/paket.generated.ts`).
 *
 * Korunanlar:
 *  • PAKET GÜNCEL: sahne kodu (kart-sahne, boncuk-ortak, canli-konum, viz-pack, mobil-izleyici)
 *    değişip paket yeniden üretilmezse telefon eski 3B'yi gösterir — bu test aynı derlemeyi
 *    yapıp özeti karşılaştırır. Kırmızıysa: `node scripts/mobil-3b-paketle.mjs`.
 *  • OTA İLE GİDEBİLİR: Expo DOM bileşeni (`'use dom'`) yalnız native derlemeye gömülüyor; onun
 *    yerine derlemede zaten bulunan `@expo/dom-webview` kullanılır.
 *  • Dosya kurulumu modül yüklenirken yapılmaz (`eas update`'in web adımı bunda düşmüştü).
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("3B izleyici paketi", () => {
  it("telefondaki paket sahne kodunun GÜNCEL derlemesi", async () => {
    const { ozet } = await izleyiciyiDerle();
    const uretilen = oku("mobile/src/lib/izleyici3b/paket.generated.ts");
    const kayitli = /export const IZLEYICI_OZETI = "([0-9a-f]+)"/.exec(uretilen)?.[1];
    expect(kayitli, "paket eski — kökten `node scripts/mobil-3b-paketle.mjs` çalıştır").toBe(ozet);
  }, 60_000);

  it("paket telefonu şişirmeyecek boyutta (three.js dahil)", () => {
    const boyut = fs.statSync(path.join(ROOT, "mobile/src/lib/izleyici3b/paket.generated.ts")).size;
    expect(boyut).toBeLessThan(1_000_000);
  });
});

describe("telefon tarafı OTA ile gidebilir", () => {
  it("DOM bileşeni değil, derlemedeki yerel WebView", () => {
    const bilesen = oku("mobile/src/components/Yazici3B.tsx");
    expect(bilesen).toContain('from "@expo/dom-webview"');
    expect(bilesen).not.toMatch(/^['"]use dom['"]/m);
    // @expo/dom-webview mobil package.json'da DOĞRUDAN yok (expo'nun bağımlılığı) — eklenirse
    // parmak izi değişebilir; bu test onu da bekçiler.
    const paket = JSON.parse(oku("mobile/package.json")) as { dependencies?: Record<string, string> };
    expect(Object.keys(paket.dependencies ?? {})).not.toContain("@expo/dom-webview");
  });

  it("dosyalar ilk kullanımda yazılır, modül yüklenirken değil", () => {
    const sayfa = oku("mobile/src/lib/izleyici3b/sayfa.ts");
    // Yorumlar ayıklanır (açıklamada `new File(...)` geçiyor); yalnız kod satırlarına bakılır.
    const govdeDisi = sayfa
      .slice(0, sayfa.indexOf("export function izleyiciAdresi"))
      .split("\n")
      .filter((satir) => !/^\s*(\*|\/\*|\/\/)/.test(satir))
      .join("\n");
    expect(govdeDisi).not.toMatch(/new (File|Directory)\(/);
    expect(sayfa).toContain('if (Platform.OS === "web") return (hazirAdres = null);');
  });

  it("yazıcı ekranı 3B sekmesini yalnız paket hazırken gösterir", () => {
    const ekran = oku("mobile/src/app/printer/[id].tsx");
    expect(ekran).toContain("const ucBoyutVar = isVar && !!d?.viz;");
    expect(ekran).toContain('...(ucBoyutVar ? [{ value: "3b" as const, label: "3B" }] : [])');
  });

  it("sayfanın beklediği durum alanları telefonun gönderdikleriyle aynı", () => {
    const izleyici = oku("src/lib/gcode-viz/mobil-izleyici.ts");
    const bilesen = oku("mobile/src/components/Yazici3B.tsx");
    const alanlar = (metin: string) => {
      const bas = metin.indexOf("interface IzleyiciDurumu {");
      const govde = metin.slice(bas, metin.indexOf("}", bas));
      return [...govde.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    };
    expect(alanlar(bilesen)).toEqual(alanlar(izleyici));
    expect(alanlar(izleyici).length).toBeGreaterThan(8);
  });
});
