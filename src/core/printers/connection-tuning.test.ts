/**
 * BAĞLANTI PARAMETRELERİ — sahada ölçülen sayılara bağlı, geri alınmasın.
 *
 * 20 Ağu 2026, yazıcılar baskı yaparken ölçüldü:
 *   Neptune 4 Pro  (kablolu): QUERY p50 210-256 ms, p99 ~298 ms, paket kaybı %0
 *   Neptune 4 PLUS (WiFi)   : QUERY p50 193-269 ms, p99 **514-609 ms**, kayıp ~%2
 *   Plus'ta bağlantı kurmanın %3,3'ü SYN kaybına düşüp SABİT +1000 ms ekliyor.
 *
 * Eski 1500 ms bütçe, sağlıklı bir Plus'a ~250 ms pay bırakıyordu: yazıcı çalışırken
 * "çevrimdışı" sayılıyordu. Kullanıcının "sürekli kopuyor" dediği şey buydu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MOONRAKER = readFileSync(join(process.cwd(), "src/core/printers/moonraker.ts"), "utf8");
const CACHE = readFileSync(join(process.cwd(), "src/core/printers/status-cache.ts"), "utf8");

/** Sabitin değerini regex'siz oku — kaçış karakterleri elle yazımda kolayca bozuluyor. */
function sayi(kaynak: string, ad: string): number {
  const i = kaynak.indexOf(`${ad} = `);
  expect(i, `${ad} bulunamadı`).toBeGreaterThan(-1);
  const kuyruk = kaynak.slice(i + ad.length + 3);
  const rakamlar = kuyruk.slice(0, kuyruk.indexOf(";")).replace(/[^0-9]/g, "");
  expect(rakamlar.length, `${ad} sayısı okunamadı`).toBeGreaterThan(0);
  return Number(rakamlar);
}

describe("durum sorgusu zaman aşımı", () => {
  it("ölçülen p99 + SYN kaybını KARŞILIYOR", () => {
    // p99 ~609 ms + 1000 ms SYN yeniden iletimi ≈ 1,6 sn → 1500 ms yetmiyordu.
    const m = /objects\/query\?\$\{QUERY\}`, undefined, (\d+)\)/.exec(MOONRAKER);
    expect(m, "durum sorgusu zaman aşımı bulunamadı").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(3000);
  });
});

describe("önbellek penceresi panelden BÜYÜK", () => {
  it("FRESH_MS panel aralığından (5 sn) büyük", () => {
    /**
     * Küçükse önbellek paneli hiç beslemez ve her tick yeni istek doğurur. Ayrıca 4000 ms
     * undici'nin keep-alive duvarı: aralık onu aşarsa her yoklama YENİ TCP açar ve Plus'ta
     * SYN kaybı riskini yeniden alır (ölçüldü: 5000 ms → 6 istek 6 TCP; 3000 ms → 1 TCP).
     */
    expect(sayi(CACHE, "FRESH_MS")).toBeGreaterThan(5000);
  });
});

describe("çevrimdışı geri çekilme tavanı", () => {
  it("ekranı 2 dakika kilitleyecek kadar uzun DEĞİL", () => {
    // Ekranda görülen kopukluk süresini yazıcının linki değil bu sayı belirliyor.
    expect(sayi(CACHE, "OFFLINE_MAX_MS")).toBeLessThanOrEqual(30_000);
  });
});

describe("gövde okuması zaman aşımıyla korunuyor", () => {
  it("sayaç fetch çözülünce SÖNDÜRÜLMÜYOR", () => {
    /**
     * Eski hâlde `finally { clearTimeout }` yalnız BAŞLIKLAR gelince çalışıyordu; gövde
     * okuması undici varsayılanı olan 305 saniyeye kadar asılı kalabiliyordu. Asılı istek
     * inflight tekilleştirmesi yüzünden tüm çağıranları bekletip paneli donduruyordu.
     */
    expect(MOONRAKER).toContain("mfetchZamanli");
    expect(MOONRAKER).toContain("sonlandir");
    // Eski desen geri gelmemeli.
    expect(MOONRAKER).not.toMatch(/return await fetch\(url, \{ \.\.\.init, signal: ctrl\.signal/);
  });
});

describe("tek yazıcı hatası diğerlerini düşürmüyor", () => {
  it("panel rotasında per-yazıcı koruma var", () => {
    const ROTA = readFileSync(join(process.cwd(), "src/app/api/printers/route.ts"), "utf8");
    expect(ROTA).toContain("cevrimdisiKart");
    expect(ROTA).toMatch(/try \{\s*return await tekYazici\(c, i\);/);
  });
});
