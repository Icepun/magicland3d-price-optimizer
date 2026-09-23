import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SEKME BAŞLIĞI KİMLİĞİ — "uygulama bozuk görünüyor" hatasının tekrarını engeller.
 *
 * Eski sürümü `AppHeader`'ın piksel ölçülerini (32 punto, 20 boşluk…) kilitliyordu. Mobil
 * arayüz Eylül 2026'da ortak `kit/` diline taşındı; başlık artık `kit/Header` ve ölçüleri
 * bilinçli olarak tasarım jetonlarına bağlı. `AppHeader` silinince bu dosya AÇILIŞTA
 * çöküyordu (okunacak dosya yok) — yani altındaki hiçbir güvence çalışmıyordu.
 *
 * Burada yeni tasarımda hâlâ geçerli olan davranışlar korunur: tazelik damgası satırı, başlık
 * sağında taşma, hazırlık kısayolu ve alt ekranların ortak başlığı.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const HEADER = oku("mobile/src/components/kit/Header.tsx");

describe("sekme başlığı", () => {
  /** Damga kendi satırını alsaydı başlık üç satır olur, her sekme birden uzardı. */
  it("tazelik damgası alt başlıkla AYNI satırda", () => {
    const govde = HEADER.slice(0, HEADER.indexOf("const styles"));
    // JSX kullanımı ("<FreshnessStamp") aranır — içe aktarma satırı değil.
    expect(govde).toContain("styles.subRow");
    expect(govde.indexOf("<FreshnessStamp")).toBeGreaterThan(govde.indexOf("styles.subRow"));
  });

  it("sabit yükseklik dayatması yok (Dinamik Yazı büyütünce kırpılmasın)", () => {
    const stiller = HEADER.slice(HEADER.indexOf("const styles"));
    expect(stiller).not.toMatch(/wrap:\s*\{[^}]*\bheight:/);
  });
});

describe("başlık sağındaki kontroller taşmıyor", () => {
  /**
   * Bir tur Siparişler başlığında "+ Ekle" + "Hazırlık" + zil birlikte duruyordu:
   * iPhone SE'de (375pt) başlık sütununa 127pt kalıyor, "Siparişler" kırpılıyordu.
   * Sağa en fazla TEK ekrana özel düğme.
   */
  it("Siparişler başlığında tek düğme var: manuel sipariş", () => {
    const orders = oku("mobile/src/app/(tabs)/orders.tsx");
    const right = orders.slice(orders.indexOf("right={"), orders.indexOf("/>", orders.indexOf("right={")));
    expect((right.match(/<IconButton/g) ?? []).length).toBe(1);
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
  it("hazırlık ve reklam bütçesi ortak SubHeader kullanıyor", () => {
    for (const ekran of ["mobile/src/app/hazirlik.tsx", "mobile/src/app/rules/ad-budget.tsx"]) {
      const s = oku(ekran);
      expect(s, ekran).toContain("<SubHeader");
      expect(s, `${ekran} kendi geri oku`).not.toContain('name="chevron.left"');
    }
  });
});
