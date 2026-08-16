import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * REKLAM BÜTÇESİ TELEFONDAN — kâr rakamını değiştiren bir yazma.
 *
 * Korunan üç şey:
 *  1. ESKİ DÖNEM SİLİNMEZ. Geçmiş siparişlerin kârı kendi döneminin oranına bağlı; dönem
 *     silinirse o siparişler bir daha doğru hesaplanamaz.
 *  2. DÖNEMLER İÇ İÇE GEÇMEZ. Geriye tarihli bütçe, eski kaydın bitişini kendi başlangıcından
 *     öne düşürür ve hiç eşleşmeyen ölü kayıt doğar (masaüstündeki 409 koruması).
 *  3. RAPORLAR İLE SİPARİŞLER AYRIŞMAZ. Bütçe girilince donmuş kârlar yeniden yazılmalı;
 *     yoksa Siparişler yeni, Raporlar eski (reklamsız, yüksek) kârı gösterir.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const YAZMA = oku("mobile/src/lib/db/ad-budgets.ts");
const EKRAN = oku("mobile/src/app/rules/ad-budget.tsx");
const FINANS = oku("mobile/src/lib/db/finance.ts");

describe("mobil reklam bütçesi yazması", () => {
  it("DELETE yok — eski dönem asla silinmez", () => {
    expect(YAZMA).not.toMatch(/DELETE\s+FROM\s+AdBudget/i);
  });

  it("dönem sınırı ortak çekirdekten (masaüstüyle aynı 1 ms kuralı)", () => {
    expect(YAZMA).toContain('from "@core/tariff-period"');
    expect(YAZMA).toContain("tarifeDonemSiniri(startsAt)");
  });

  it("geriye tarihli/çakışan dönem reddedilir", () => {
    expect(YAZMA).toContain("AdBudgetOverlapError");
    expect(YAZMA).toMatch(/WHERE platform = \? AND \$\{dbEpochMs\("validFrom"\)\} >= \?/);
  });

  /** SQLite'ta tamsayı metinden önce sıralanır: epoch-ms yazılırsa dönem filtreleri satırı eler. */
  it("tarihler ISO metin yazılır", () => {
    expect(YAZMA).toContain("startsAt.toISOString()");
    expect(YAZMA).toContain("eskiBitis.toISOString()");
    expect(YAZMA).not.toMatch(/args:\s*\[[^\]]*\.getTime\(\)[^\]]*\]\s*,?\s*\}\s*,?\s*\]\s*\)\s*;/);
  });

  it("okuma dbEpochMs üzerinden (karışık biçimli eski kayıtlar da okunur)", () => {
    expect(YAZMA).toContain('dbEpochMs("validFrom")');
  });
});

describe("bütçe değişince donmuş kârlar yeniden yazılır", () => {
  it("zorlama bayrağı senkrona ulaşıyor", () => {
    expect(EKRAN).toContain("syncFinanceFromCache(qc, { zorlaKarYaz: true })");
    expect(oku("mobile/src/lib/finance-sync.ts")).toContain(
      "syncOrderFinanceSnapshots(snapshots, { zorlaKarYaz })"
    );
  });

  it("zorlama, değişmedi diye atlamayı da devre dışı bırakır", () => {
    const sync = oku("mobile/src/lib/finance-sync.ts");
    expect(sync).toContain("!zorla && !zorlaKarYaz && simdi - sonCalisma < MIN_ARALIK_MS");
    expect(sync).toContain("!zorla && !zorlaKarYaz && imza === sonImza");
  });

  /**
   * Trendyol'un GERÇEK komisyonuyla düzeltilmiş kâr bizim hesabımızdan daha doğru;
   * zorlama onu ezmemeli.
   */
  it("platform kaynaklı kâr zorlamada bile korunur", () => {
    expect(FINANS).toContain("const FORCE_PROFIT_SQL");
    const blok = FINANS.slice(FINANS.indexOf("const FORCE_PROFIT_SQL"));
    expect(blok.slice(0, 300)).toContain("<> 'platform'");
  });

  it("zorlama kapalıyken koşul birebir eski hali", () => {
    expect(FINANS).toContain(
      "const replaceSql = zorlaKarYaz ? `(${REPLACE_PROFIT_SQL}) OR (${FORCE_PROFIT_SQL})` : REPLACE_PROFIT_SQL;"
    );
  });
});

describe("ekran erişimi", () => {
  it("Ayarlar menüsünden açılıyor", () => {
    expect(oku("mobile/src/app/settings.tsx")).toContain('href: "/rules/ad-budget"');
  });
});
