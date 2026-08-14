/**
 * Kontrol komutlarının SUNUCU TARAFI sınırları.
 *
 * Neden burada test ediliyor: arayüz düğmeyi kısıtlasa bile aynı uç noktaya telefondan, eski bir
 * sürümden ya da doğrudan istekle serbest değer gelebilir. Baskı sürerken hızın tek adımda
 * %100'den %200'e çıkması titreşim/kayan katman üretir — sınır arayüze GÜVENİLEREK konulamaz.
 */
import { describe, expect, it } from "vitest";
import { SPEED_PRESETS_PCT, validatePauseLayer, validateSpeedChange } from "./controls";

describe("hız değişimi", () => {
  it("hazır kademeyi kabul eder", () => {
    expect(validateSpeedChange(125, 100)).toEqual({ ok: true, value: 125 });
  });

  it("serbest sayı girişini REDDEDER", () => {
    const r = validateSpeedChange(137, 125);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("hazır kademelerden");
  });

  it("tek adımda %25'ten fazla değişimi REDDEDER", () => {
    const r = validateSpeedChange(150, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("en fazla %25");
  });

  it("sınırların dışındaki kademe olamaz", () => {
    expect(SPEED_PRESETS_PCT[0]).toBe(50);
    // BEŞ kademe (kullanıcı kararı): %175/%200 kaldırıldı — hiç kullanılmıyordu.
    expect(SPEED_PRESETS_PCT).toEqual([50, 75, 100, 125, 150]);
    expect(validateSpeedChange(175, 150).ok).toBe(false);
    expect(validateSpeedChange(225, 200).ok).toBe(false);
  });

  it("yazıcının o anki hızı bilinmiyorsa adım sınırı uygulanmaz (ilk ayar)", () => {
    expect(validateSpeedChange(150, null)).toEqual({ ok: true, value: 150 });
  });

  it("sayı olmayan değer sessizce 0'a düşmez", () => {
    expect(validateSpeedChange("hızlı", 100).ok).toBe(false);
  });
});

describe("katmanda duraklat", () => {
  it("ileri bir katmanı kabul eder", () => {
    expect(validatePauseLayer(200, 181, 1333)).toEqual({ ok: true, value: 200 });
  });

  it("GEÇİLMİŞ katmanı reddeder — komut sessizce hiçbir şey yapardı", () => {
    const r = validatePauseLayer(100, 181, 1333);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("182");
  });

  it("baskının toplam katmanını aşamaz", () => {
    expect(validatePauseLayer(2000, 181, 1333).ok).toBe(false);
  });

  it("tam sayı olmayan değeri reddeder", () => {
    expect(validatePauseLayer(12.5, 1, 100).ok).toBe(false);
  });

  it("katman sayısı bilinmiyorsa üst sınır uygulanmaz", () => {
    expect(validatePauseLayer(500, 10, null)).toEqual({ ok: true, value: 500 });
  });
});
