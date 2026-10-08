import { describe, expect, it } from "vitest";

import { SPLASH_MAX_MS, SPLASH_MIN_MS, SPLASH_SORGUSUZ_MS, splashKalksinMi } from "./splash-kurali";

describe("açılış ekranı ne zaman kalkar", () => {
  it("Panel DIŞINDAKİ sayfa: kendi verisi gelince kalkar (eskiden 7 sn bekliyordu)", () => {
    // Siparişler yeniden yüklendi: sorguları başladı ve bitti, Panel sorgusu hiç yok.
    expect(splashKalksinMi({ gecenMs: 900, sorguGoruldu: true, havadaSorgu: 0 })).toBe(true);
  });

  it("veri havadayken bekler", () => {
    expect(splashKalksinMi({ gecenMs: 3000, sorguGoruldu: true, havadaSorgu: 2 })).toBe(false);
  });

  it("logo flaş etmesin: en az kısa bir süre görünür", () => {
    expect(splashKalksinMi({ gecenMs: SPLASH_MIN_MS - 1, sorguGoruldu: true, havadaSorgu: 0 })).toBe(false);
  });

  it("hiç sorgu başlatmayan sayfa da kısa sürede açılır", () => {
    expect(splashKalksinMi({ gecenMs: SPLASH_SORGUSUZ_MS - 1, sorguGoruldu: false, havadaSorgu: 0 })).toBe(false);
    expect(splashKalksinMi({ gecenMs: SPLASH_SORGUSUZ_MS, sorguGoruldu: false, havadaSorgu: 0 })).toBe(true);
  });

  it("veri hiç gelmese de asılı kalmaz", () => {
    expect(splashKalksinMi({ gecenMs: SPLASH_MAX_MS, sorguGoruldu: true, havadaSorgu: 5 })).toBe(true);
  });
});
