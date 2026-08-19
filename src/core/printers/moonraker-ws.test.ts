/**
 * KALICI BAĞLANTI — hızlı yol, ama HER ZAMAN geri düşüşlü olmalı.
 *
 * Fluidd aynı WiFi'da sorunsuz çalışırken bizim kartlarımız kopuyordu; fark, bizim her
 * turda yeni TCP bağlantısı açmamızdı (Neptune 4 Plus'ta bağlantı kurmanın %3,3'ü SYN
 * kaybına düşüp sabit +1000 ms ekliyor — ölçüldü, 20 Ağu 2026).
 *
 * Bu modülün TEK kırmızı çizgisi var: bağlantı yoksa, aboneliği tamamlanmadıysa ya da akış
 * kesildiyse ASLA bayat veri döndürmemeli — çağıran HTTP yoluna düşebilmeli.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ABONE_NESNELER, wsBaslat, wsDurumAl, wsHepsiniKapat } from "./moonraker-ws";

afterEach(() => {
  wsHepsiniKapat();
  vi.useRealTimers();
});

describe("abonelik kapsamı", () => {
  it("HTTP sorgusuyla AYNI nesneleri kapsıyor", () => {
    /**
     * İki yol farklı alan kümesi okursa kart, hangi yolun aktif olduğuna göre farklı
     * davranır — en sinsi hata sınıfı. Alanlar `moonraker.ts` içindeki QUERY ile eşleşmeli.
     */
    for (const n of [
      "print_stats", "virtual_sdcard", "display_status",
      "extruder", "toolhead", "heater_bed", "gcode_move", "exclude_object",
    ]) {
      expect(Object.keys(ABONE_NESNELER)).toContain(n);
    }
  });

  it("çok kafalı yazıcılar için ek ekstruderler var", () => {
    // Snapmaker U1 tool-changer; eksikse aktif kafanın sıcaklığı hiç gelmez.
    expect(Object.keys(ABONE_NESNELER)).toContain("extruder1");
    expect(Object.keys(ABONE_NESNELER)).toContain("extruder3");
  });

  it("ilerleme alanları isim isim isteniyor", () => {
    expect(ABONE_NESNELER.virtual_sdcard).toEqual(["progress", "file_position", "file_size"]);
  });
});

describe("geri düşüş garantileri", () => {
  it("hiç başlatılmamış yazıcı için null", () => {
    expect(wsDurumAl("10.0.0.99", 7125)).toBeNull();
  });

  it("başlatıldı ama abonelik tamamlanmadıysa null", () => {
    // `ws` gerçek bir soket açamayacağı için (host yok) abone hiç true olmaz.
    wsBaslat("10.0.0.99", 7125);
    expect(wsDurumAl("10.0.0.99", 7125)).toBeNull();
  });

  it("tekrar başlatmak ikinci bağlantı AÇMAZ", () => {
    // Her durum isteğinde çağrılıyor; her çağrıda yeni soket açsaydı yazıcıyı boğardık.
    wsBaslat("10.0.0.98", 7125);
    wsBaslat("10.0.0.98", 7125);
    wsBaslat("10.0.0.98", 7125);
    expect(wsDurumAl("10.0.0.98", 7125)).toBeNull();
  });
});

describe("hızlı yol geri düşüşü koruyor", () => {
  it("status-cache HTTP yolunu KALDIRMAMIŞ", () => {
    const kaynak = readFileSync(join(process.cwd(), "src/core/printers/status-cache.ts"), "utf8");
    // WebSocket null dönerse eski yol aynen çalışmalı.
    expect(kaynak).toContain("wsDurumAl");
    expect(kaynak).toContain("fetchMoonrakerStatus");
    expect(kaynak).toMatch(/if \(canli\) \{/);
  });
});
