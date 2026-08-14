/**
 * SÜREÇ GENELİ TEK ÖRNEK — Bambu "sürekli bağlantı gidiyor" arızasının kök nedeni buradaydı.
 *
 * ÖLÇÜLEN ARIZA (14 Ağu 2026): tek uygulama süreci yazıcıya SÜREKLİ 2 MQTT soketi açık
 * tutuyordu (`netstat`, 12 dakika boyunca sabit 2). Sebep: Next, `instrumentation.ts`'i
 * (relay) API rotalarından ayrı derliyor ve `bambu.ts` iki pakete birden kopyalanmıştı —
 * derlenmiş çıktıda `mg3d_` istemci kimliği hem chunk 9525'te hem 1046'da vardı. İki kopya,
 * iki `conns` haritası, iki MQTT istemcisi. Bambu firmware'i raporları yalnız EN SON bağlanana
 * gönderdiği için (BambuStudio#2404) iki kopya birbirini susturuyor, susan taraf bekçisiyle
 * yeniden bağlanıp diğerini susturuyordu → sonsuz gel-git.
 *
 * Bu testler hem yardımcının kendisini hem de "yazıcı tarafında modül-düzeyi durum bırakma"
 * kuralını kilitler. Kural bozulursa arıza YERELDE görünmez (tek pakette tek kopya olur);
 * ilk belirti kullanıcının yazıcısının kopması olur.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { processSingleton, resetProcessSingleton } from "./process-singleton";

describe("processSingleton", () => {
  beforeEach(() => resetProcessSingleton("test_ornek"));

  it("aynı ad İKİNCİ kez istendiğinde AYNI nesneyi döndürür", () => {
    const a = processSingleton("test_ornek", () => new Map<string, number>());
    a.set("x", 1);
    // İkinci çağrı, modülün ikinci kopyasını temsil eder: kendi fabrikasını verir ama
    // zaten kayıtlı nesneyi almalıdır.
    const b = processSingleton("test_ornek", () => new Map<string, number>());
    expect(b).toBe(a);
    expect(b.get("x")).toBe(1);
  });

  it("durum globalThis üzerinde tutulur — modül kapsamında değil", () => {
    processSingleton("test_ornek", () => new Set<string>());
    expect("__mlhub_test_ornek" in (globalThis as Record<string, unknown>)).toBe(true);
  });

  it("farklı adlar birbirine karışmaz", () => {
    resetProcessSingleton("test_a");
    resetProcessSingleton("test_b");
    const a = processSingleton("test_a", () => new Map<string, number>());
    const b = processSingleton("test_b", () => new Map<string, number>());
    expect(a).not.toBe(b);
  });
});

describe("yazıcı modüllerinde modül-düzeyi durum kalmadı", () => {
  const dizin = __dirname;
  const dosyalar = readdirSync(dizin).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("hiçbir yazıcı dosyası modül kapsamında `new Map()/new Set()` tutmuyor", () => {
    const suclular: string[] = [];
    for (const dosya of dosyalar) {
      const src = readFileSync(join(dizin, dosya), "utf8");
      src.split("\n").forEach((satir, i) => {
        // Modül kapsamı = satır girintisiz başlıyor. Fonksiyon içindeki yerel Map/Set serbest.
        if (/^(?:const|let|var) \w+ = new (?:Map|Set)\b/.test(satir)) {
          suclular.push(`${dosya}:${i + 1}  ${satir.trim()}`);
        }
      });
    }
    expect(suclular, `processSingleton ile sarmalanmalı:\n${suclular.join("\n")}`).toEqual([]);
  });

  it("Bambu bağlantı havuzu GERÇEKTEN süreç geneli", () => {
    const src = readFileSync(join(dizin, "bambu.ts"), "utf8");
    expect(src).toMatch(/const conns = processSingleton\(\s*"bambuConns"/);
  });

  it("baskı kilidi süreç geneli — masaüstü + telefon çakışmasını gerçekten engeller", () => {
    const src = readFileSync(join(dizin, "print-lock.ts"), "utf8");
    expect(src).toMatch(/const active = processSingleton\(\s*"printLock"/);
  });
});
