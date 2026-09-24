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

  it("sayfanın gönderdiği mesaj türleri telefonun tanıdıklarıyla aynı", () => {
    const turler = (metin: string, bas: string) => {
      const i = metin.indexOf(bas);
      const govde = metin.slice(i, metin.indexOf("\n\n", i));
      return [...govde.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
    };
    const izleyici = turler(oku("src/lib/gcode-viz/mobil-izleyici.ts"), "type Mesaj =");
    expect(izleyici).toContain("dokunma");
    expect(turler(oku("mobile/src/components/Yazici3B.tsx"), "type SayfaMesaji =")).toEqual(izleyici);
  });
});

/**
 * 3B'DE GEZERKEN SAYFA KAYMAZ, GERİ GİTMEZ — "sahnede gezerken sayfa da aşağı-yukarı kayabiliyor
 * veya geri gidebiliyoruz". WebView içindeki `preventDefault` dıştaki yerel ScrollView'ı
 * DURDURMAZ; sayfa parmağın sahnede olduğunu bildirir, ekran kaydırmayı o sürede kilitler.
 * iOS 26'da geri hareketi ekranın her yerinden başlar → 3B açıkken geri kaydırma kapalı.
 */
describe("3B sahnede dokunma", () => {
  const izleyici = oku("src/lib/gcode-viz/mobil-izleyici.ts");
  const bilesen = oku("mobile/src/components/Yazici3B.tsx");
  const ekran = oku("mobile/src/app/printer/[id].tsx");

  it("sayfa kendi kaydırma/yakınlaştırmasını kapatır ve dokunmayı bildirir", () => {
    expect(izleyici).toContain('tuval.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });');
    expect(izleyici).toContain('tuval.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });');
    expect(izleyici).toContain('gonder({ tur: "dokunma", aktif: true });');
    expect(izleyici).toContain('gonder({ tur: "dokunma", aktif: false });');
    // Sistem hareketi devralsa da kilit bırakılır.
    expect(izleyici).toContain('tuval.addEventListener("pointercancel", birak);');
  });

  it("ekran parmak sahnedeyken kaydırmayı kilitler; görünüm kapanırsa kilit kalmaz", () => {
    expect(ekran).toContain("scrollEnabled={!kaydirmaKilidi}");
    expect(ekran).toContain("onDokunma={setKaydirmaKilidi}");
    expect(bilesen).toContain("if (kilitli.current) sonDokunma.current?.(false);");
    expect(oku("mobile/src/components/kit/Screen.tsx")).toContain("scrollEnabled={scrollEnabled}");
  });

  it("3B açıkken geri kaydırma kapalı (görünümle aynı kural)", () => {
    expect(ekran).toContain('const ucBoyutAcik = gorunum === "3b";');
    expect(ekran).toContain("navigation.setOptions({ gestureEnabled: !ucBoyutAcik });");
  });

  it('"Tamamı" görünümü ilerlemeyi uygulamaz (bitmiş modelin tamamı)', () => {
    expect(izleyici).toContain('if (durum.basiliyor && durum.gorunum !== "tamami") {');
  });
});
