import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SEKME BAŞLIĞI KİMLİĞİ — "uygulama bozuk görünüyor" hatasının tekrarını engeller.
 *
 * NE OLDU: beş sekmenin başlığı ortak `AppHeader`'a taşınırken ölçek jetonlarına bağlandı.
 * Jetonlar var olan tasarımdan KÜÇÜKTÜ; Panel, Siparişler, Ürünler ve Daha'nın başlığı bir
 * anda 32→26 punto düştü, yatay boşluk 20→16'ya çekilip altındaki listeyle hizası kaydı,
 * gövde 8px aşağı itildi. Kod derleniyor, testler geçiyor, lint temiz — ama uygulama
 * kullanıcının gözünde bozulmuştu. Görsel kimliğin tek savunması bu tür ölçü testleri.
 *
 * Değerler DEĞİŞTİRİLEBİLİR; ama bilinçli bir tasarım kararıyla, bu testi de güncelleyerek.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const HEADER = oku("mobile/src/components/AppHeader.tsx");
const TEMA = oku("mobile/src/theme/colors.ts");

describe("başlık ölçüleri sekmelerin özgün tasarımıyla aynı", () => {
  it("ekran başlığı 32 punto ve -0.5 harf aralığı", () => {
    expect(TEMA).toMatch(/title:\s*\{\s*fontSize:\s*32,\s*fontWeight:\s*"800",\s*letterSpacing:\s*-0\.5\s*\}/);
  });

  it("yatay boşluk 20 — ölçek jetonu (16) DEĞİL", () => {
    const blok = HEADER.slice(HEADER.indexOf("  header: {"), HEADER.indexOf("  textCol:"));
    expect(blok).toContain("paddingHorizontal: 20");
    expect(blok).not.toContain("paddingHorizontal: space.lg");
  });

  it("dikey boşluk 8 / 4 ve sabit yükseklik dayatması yok", () => {
    const blok = HEADER.slice(HEADER.indexOf("  header: {"), HEADER.indexOf("  textCol:"));
    expect(blok).toContain("paddingTop: 8");
    expect(blok).toContain("paddingBottom: 4");
    expect(blok).not.toContain("minHeight");
  });

  it("alt başlık 14 punto", () => {
    expect(HEADER).toMatch(/subtitle:\s*\{[^}]*fontSize:\s*14/);
  });

  /** Damga kendi satırını alsaydı başlık üç satır olur, her sekme birden uzardı. */
  it("tazelik damgası alt başlıkla AYNI satırda", () => {
    const govde = HEADER.slice(0, HEADER.indexOf("const styles"));
    // JSX kullanımı ("<FreshnessStamp") aranır — içe aktarma satırı değil.
    expect(govde).toContain("styles.subRow");
    expect(govde.indexOf("<FreshnessStamp")).toBeGreaterThan(govde.indexOf("styles.subRow"));
  });
});

describe("başlık sağındaki kontroller taşmıyor", () => {
  /**
   * Bir tur Siparişler başlığında "+ Ekle" + "Hazırlık" + zil birlikte duruyordu:
   * ~74 + ~58 + 40 + boşluklar ≈ 208pt. iPhone SE'de (375pt) başlık sütununa 127pt kalıyor,
   * "Siparişler" (32 punto ≈ 168pt) kırpılıyordu. Sağa en fazla TEK ekrana özel düğme.
   */
  it("Siparişler başlığında zil dışında tek düğme var", () => {
    const orders = oku("mobile/src/app/(tabs)/orders.tsx");
    const right = orders.slice(orders.indexOf("right={"), orders.indexOf("/>", orders.indexOf("right={")));
    expect((right.match(/<PressableScale/g) ?? []).length).toBe(1);
    expect(right).toContain("manual-order/new");
    expect(right).not.toContain("/hazirlik");
  });

  it("hazırlık kısayolu Atölye'de, bekleyen sayısıyla", () => {
    const atolye = oku("mobile/src/app/(tabs)/atolye.tsx");
    expect(atolye).toContain('href="/hazirlik"');
    expect(atolye).toContain("count={prepKalan}");
  });
});

describe("alt ekranlar tek tip başlık kullanır", () => {
  /** Kendi başlığını yazan ekran, uygulamayı derme çatma gösteriyor. */
  it("bugün eklenen ekranlar da ScreenHeader kullanıyor", () => {
    for (const ekran of ["mobile/src/app/hazirlik.tsx", "mobile/src/app/rules/ad-budget.tsx"]) {
      const s = oku(ekran);
      expect(s, ekran).toContain("<ScreenHeader title=");
      expect(s, `${ekran} kendi geri oku`).not.toContain('name="chevron.left"');
    }
  });
});
