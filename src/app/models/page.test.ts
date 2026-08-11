import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Model Kütüphanesi ekranı, YAPMADIĞI bir şeyi vaat etmemeli.
 *
 * Sayfa parçaları tek tek bastırır; bir parça bitince sıradakini KENDİLİĞİNDEN başlatmaz.
 * Metin "kuyruk"tan/otomatik başlamadan söz ederse kullanıcı yazıcının başından ayrılır ve
 * makine boş bekler. Ne yapılacağının planı Üretim Planı'nda olduğu için sayfa oraya bağlanır.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SAYFA = readFileSync(path.join(REPO_ROOT, "src/app/models/page.tsx"), "utf8");

/** Karşılığı OLMAYAN otomasyon sözleri — geri sızarsa test kırılır. */
const VAAT_EDİLMEYENLER = [
  "otomatik kuyruk",
  "otomatik olarak başlar",
  "otomatik başlar",
  "kuyruğa al",
  "kuyruğa ekle",
  "biri biterken diğerini başlat",
  "sırayla basılır",
];

describe("Model Kütüphanesi verdiği sözü tutar", () => {
  it("olmayan bir otomatik kuyruk vaat etmiyor", () => {
    const kucuk = SAYFA.toLocaleLowerCase("tr-TR");
    const bulunanlar = VAAT_EDİLMEYENLER.filter((ifade) =>
      kucuk.includes(ifade.toLocaleLowerCase("tr-TR"))
    );
    expect(bulunanlar).toEqual([]);
  });

  it("parçaların tek tek basıldığını açıkça söylüyor", () => {
    expect(SAYFA).toContain("Parçalar tek tek basılır");
  });

  it("planlama için Üretim Planı'na bağlanıyor", () => {
    expect(SAYFA).toContain('href="/planner"');
  });

  it("baskı başlatma paylaşılan akıştan çağrılıyor (kopya akış yok)", () => {
    // Bambu/Snapmaker baskısını sürdüren akış print-flow'da; burada kopyası olmamalı.
    expect(SAYFA).toContain('from "@/components/printers/print-flow"');
    expect(SAYFA).toContain("runPrintStream(");
    expect(SAYFA).not.toContain("fetch(\"/api/printers/print\"");
  });
});
