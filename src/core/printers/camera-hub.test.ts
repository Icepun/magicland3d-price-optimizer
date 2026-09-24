/**
 * KAMERA YAYIN MERKEZİ — masaüstü penceresi ve telefon aktarıcısı AYNI yazıcıyı izlerken
 * yazıcıya tek bağlantı açılmalı; son izleyici ayrılınca bağlantı kapanmalı (kamera ancak
 * biri izlerken açık kalır — yazıcıya binen yük dersi).
 */
import { describe, expect, it, vi } from "vitest";
import { acikYayinSayisi, kameraAbone, type KameraKaynagi } from "./camera-hub";

/** Elle sürülen sahte kaynak: kaç kez açıldı, durduruldu mu, kare/hata tetikle. */
function sahteKaynak() {
  const d = {
    acilis: 0,
    durdurma: 0,
    kare: null as ((b: Buffer) => void) | null,
    hata: null as ((m: string) => void) | null,
  };
  const kaynak: KameraKaynagi = (onKare, onHata) => {
    d.acilis++;
    d.kare = onKare;
    d.hata = onHata;
    return { durdur: () => { d.durdurma++; } };
  };
  return { d, kaynak };
}

const bekle = () => new Promise((r) => setTimeout(r, 0));

describe("kamera yayın merkezi", () => {
  it("iki izleyici tek kaynak açar, kare ikisine de gider", () => {
    const { d, kaynak } = sahteKaynak();
    const a = vi.fn();
    const b = vi.fn();
    const birakA = kameraAbone("y1", kaynak, { onKare: a, onHata: () => {} });
    const birakB = kameraAbone("y1", kaynak, { onKare: b, onHata: () => {} });
    expect(d.acilis).toBe(1);
    d.kare!(Buffer.from([1]));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    birakA();
    birakB();
  });

  it("son izleyici ayrılınca kaynak kapanır; biri kalırken kapanmaz", () => {
    const { d, kaynak } = sahteKaynak();
    const birakA = kameraAbone("y2", kaynak, { onKare: () => {}, onHata: () => {} });
    const birakB = kameraAbone("y2", kaynak, { onKare: () => {}, onHata: () => {} });
    birakA();
    expect(d.durdurma).toBe(0);
    birakB();
    expect(d.durdurma).toBe(1);
    // İki kez bırakmak ikinci kez durdurmaz.
    birakB();
    expect(d.durdurma).toBe(1);
  });

  it("sonradan katılan izleyici taze son kareyi HEMEN alır", async () => {
    const { d, kaynak } = sahteKaynak();
    const birakA = kameraAbone("y3", kaynak, { onKare: () => {}, onHata: () => {} });
    d.kare!(Buffer.from([7]));
    const b = vi.fn();
    const birakB = kameraAbone("y3", kaynak, { onKare: b, onHata: () => {} });
    expect(b).not.toHaveBeenCalled(); // senkron değil — çağıran önce bırakma fonksiyonunu alır
    await bekle();
    expect(b).toHaveBeenCalledWith(Buffer.from([7]));
    birakA();
    birakB();
  });

  it("kaynak hatası tüm izleyicilere gider ve yayın kapanır; yeni izleyici yeniden açar", async () => {
    const { d, kaynak } = sahteKaynak();
    const ha = vi.fn();
    const hb = vi.fn();
    kameraAbone("y4", kaynak, { onKare: () => {}, onHata: ha });
    kameraAbone("y4", kaynak, { onKare: () => {}, onHata: hb });
    d.hata!("Kamera bağlantısı koptu.");
    await bekle();
    expect(ha).toHaveBeenCalledWith("Kamera bağlantısı koptu.");
    expect(hb).toHaveBeenCalledWith("Kamera bağlantısı koptu.");
    const birak = kameraAbone("y4", kaynak, { onKare: () => {}, onHata: () => {} });
    expect(d.acilis).toBe(2);
    birak();
  });

  it("farklı yazıcılar ayrı yayın", () => {
    const k1 = sahteKaynak();
    const k2 = sahteKaynak();
    const oncesi = acikYayinSayisi();
    const b1 = kameraAbone("y5", k1.kaynak, { onKare: () => {}, onHata: () => {} });
    const b2 = kameraAbone("y6", k2.kaynak, { onKare: () => {}, onHata: () => {} });
    expect(acikYayinSayisi()).toBe(oncesi + 2);
    b1();
    b2();
    expect(acikYayinSayisi()).toBe(oncesi);
  });

  it("kaynak senkron patlarsa hata çağıranın elinde bırakma fonksiyonu varken gelir", async () => {
    const hata = vi.fn();
    const birak = kameraAbone(
      "y7",
      () => {
        throw new Error("Bu yazıcı için erişim kodu girilmemiş.");
      },
      { onKare: () => {}, onHata: hata },
    );
    expect(typeof birak).toBe("function");
    expect(hata).not.toHaveBeenCalled();
    await bekle();
    expect(hata).toHaveBeenCalledWith("Bu yazıcı için erişim kodu girilmemiş.");
  });
});
