/**
 * BAĞLANTI TESTİNİN KARARI.
 *
 * NEDEN VAR: panel "Yazıcıya ulaşılamadı — Yazıcı açık ve aynı ağda mı?" diyerek üç ayrı
 * durumu tek torbaya atıyordu. Üçünün çaresi farklı; yanlış çare kullanıcıyı boşuna yazıcıyla
 * uğraştırıyor. Bu testler kararın doğru ÇAREYİ söylediğini kilitler.
 */
import { describe, expect, it } from "vitest";
import { kararVer, olcAdim, type TestAsamasi } from "./diagnose";

const ok = (ad: string): TestAsamasi => ({ ad, durum: "ok", sureMs: 5, aciklama: "Yanıt verdi" });
const hata = (ad: string): TestAsamasi => ({ ad, durum: "hata", sureMs: 3000, aciklama: "Yanıt vermedi" });

describe("bağlantı testi kararı", () => {
  it("hepsi geçerse çalışıyor der", () => {
    const k = kararVer([ok("Yazıcı ağda mı"), ok("Web arayüzü"), ok("Yazıcı yazılımı")]);
    expect(k.sonuc).toBe("calisiyor");
  });

  it("İLK aşama düşerse ağ sorunu — yazıcıyı kapatıp açmak önerilmez", () => {
    const k = kararVer([hata("Yazıcı ağda mı"), ok("Web arayüzü")]);
    expect(k.sonuc).toBe("agda-yok");
    expect(k.oneri).toMatch(/aynı ağda|IP/i);
  });

  it("kutu ayakta ama YAZILIM düşerse yazıcıyı yeniden başlat der", () => {
    const k = kararVer([ok("Yazıcı ağda mı"), ok("Web arayüzü"), hata("Yazıcı yazılımı")]);
    expect(k.sonuc).toBe("yazilim-durmus");
    expect(k.oneri).toMatch(/yazıcıyı kapatıp/i);
  });

  /**
   * Bambu'nun asıl senaryosu: port açık, ama bizim MQTT oturumumuz veri almıyor. Burada
   * yazıcıyı kapatıp açmak boşa iş — sorun uygulamanın bağlantısında.
   */
  it("yalnız VERİ aşaması düşerse sorunun yazıcıda OLMADIĞINI söyler", () => {
    const k = kararVer([ok("Yazıcı ağda mı"), ok("Kontrol kanalı (MQTT)"), hata("Veri geliyor mu")]);
    expect(k.sonuc).toBe("kismi");
    expect(k.baslik).toMatch(/veri gelmiyor/i);
    expect(k.oneri).toMatch(/yazıcıda değil/i);
    expect(k.oneri).not.toMatch(/yazıcıyı kapatıp/i);
  });

  it("veri aşaması düşse bile ÖNCESİNDE başka hata varsa yazıcı suçlanır", () => {
    // Kanal kapalıysa veri gelmemesi doğaldır; çare yine yazıcıda.
    const k = kararVer([ok("Yazıcı ağda mı"), hata("Kontrol kanalı (MQTT)"), hata("Veri geliyor mu")]);
    expect(k.sonuc).toBe("yazilim-durmus");
  });

  it("hiç aşama yoksa test yapılamadı der", () => {
    expect(kararVer([]).baslik).toMatch(/yapılamadı/i);
  });
});

describe("aşama ölçümü", () => {
  it("başarılı adım süreyi kaydeder", async () => {
    const a = await olcAdim("deneme", async () => ({ ok: true, aciklama: "oldu" }));
    expect(a.durum).toBe("ok");
    expect(a.sureMs).toBeGreaterThanOrEqual(0);
  });

  it("HAM hata metni kullanıcıya SIZMAZ — tanıdık kalıba çevrilir", async () => {
    const a = await olcAdim("deneme", async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.13:8883");
    });
    expect(a.durum).toBe("hata");
    expect(a.aciklama).toBe("Bağlantı reddedildi");
    expect(a.aciklama).not.toMatch(/ECONNREFUSED|192\.168/);
  });

  it("zaman aşımı anlaşılır cümleye çevrilir", async () => {
    const a = await olcAdim("deneme", async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    expect(a.aciklama).toBe("Yanıt vermedi");
  });
});
