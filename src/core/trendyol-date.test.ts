/**
 * Trendyol siparişleri uygulamada 3 SAAT İLERİ görünüyordu — bu testin koruduğu gerileme.
 *
 * Saha kanıtı (12 Ağu 2026, kullanıcı Trendyol satıcı panelinden doğruladı):
 *   sipariş 11499653852 → uygulamamız "12.08.2026 21:03", Trendyol paneli "18:03".
 *
 * İşaretin YANLIŞ tarafa geçmesi hatayı 3 saatten 6 saate çıkarır ve `orderedAt`
 * Raporlar'ın aylık kovalarını beslediği için ciro/kâr rakamlarını oynatır. Bu yüzden
 * testler yönü açıkça sabitler.
 */
import { describe, expect, it } from "vitest";
import { padTrendyolWindow, trendyolDateToIso, trendyolDateToUtc } from "./trendyol-date";

/** Bir anı Türkiye duvar saatiyle "SS:dd" olarak yaz (arayüzün yaptığının aynısı). */
const trSaat = (d: Date) =>
  new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Istanbul",
  }).format(d);

describe("Trendyol saat çevirisi", () => {
  it("sahadaki gerçek siparişi doğru saate getirir (21:03 → 18:03)", () => {
    // Sipariş GERÇEKTE 18:03'te verildi. Trendyol duvar saatini epoch'a çevirdiği için
    // gönderdiği sayı 18:03 UTC'ye denk gelir.
    const ham = Date.UTC(2026, 7, 12, 18, 3, 0);

    // ÇEVİRİSİZ: arayüz bunu Istanbul'da (+3) biçimleyince 21:03 çıkıyordu — bildirilen hata.
    expect(trSaat(new Date(ham))).toBe("21:03");

    // ÇEVİRİDEN SONRA: Trendyol panelindeki gerçek saat.
    const cevrilmis = trendyolDateToUtc(ham);
    expect(cevrilmis).not.toBeNull();
    expect(trSaat(cevrilmis!)).toBe("18:03");
  });

  it("İLERİ değil GERİ alır — işaret testi", () => {
    const ham = Date.UTC(2026, 7, 12, 12, 0, 0);
    const cevrilmis = trendyolDateToUtc(ham)!;

    // 3 saat GERİ. Yanlış işaret 6 saatlik hataya yol açardı.
    expect(ham - cevrilmis.getTime()).toBe(3 * 60 * 60 * 1000);
    expect(cevrilmis.getTime()).toBeLessThan(ham);
  });

  it("gece yarısına yakın sipariş bir ÖNCEKİ güne taşınır (ay kovası bundan etkilenir)", () => {
    // Sipariş gerçekte 31 Temmuz 22:30'da verildi → Trendyol'un damgası 31 Tem 22:30 UTC.
    // Çevirisiz arayüz bunu 1 Ağustos 01:30 gösteriyor, yani sipariş YANLIŞ AYA düşüyor.
    // Ölçüldü: 127 siparişin 23'ünün günü, 3'ünün AYI değişiyor.
    const ham = Date.UTC(2026, 6, 31, 22, 30, 0);
    expect(
      new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeZone: "Europe/Istanbul" }).format(
        new Date(ham)
      )
    ).toBe("1.08.2026");

    const cevrilmis = trendyolDateToUtc(ham)!;
    const gun = new Intl.DateTimeFormat("tr-TR", {
      dateStyle: "short",
      timeZone: "Europe/Istanbul",
    }).format(cevrilmis);

    expect(gun).toBe("31.07.2026");
  });

  it("eksik/geçersiz değerde null döner — 1970'e düşmez", () => {
    // BİLİNMEYEN ≠ SIFIR: `?? 0` ile beslenirse tüm siparişler 1970'e düşer ve
    // Raporlar'ın tarih filtresi onları sessizce eler.
    expect(trendyolDateToUtc(null)).toBeNull();
    expect(trendyolDateToUtc(undefined)).toBeNull();
    expect(trendyolDateToUtc("")).toBeNull();
    expect(trendyolDateToUtc("abc")).toBeNull();
    expect(trendyolDateToUtc(Number.NaN)).toBeNull();
    expect(trendyolDateToIso(null)).toBeNull();
  });

  it("sayı gibi gelen metni de kabul eder", () => {
    const ham = Date.UTC(2026, 7, 12, 21, 3, 0);
    expect(trendyolDateToIso(String(ham))).toBe(trendyolDateToIso(ham));
  });

  it("çeviri idempotan DEĞİLDİR — iki kez uygulanırsa 6 saat kayar", () => {
    // Bu testin amacı davranışı savunmak değil, TEHLİKEYİ görünür kılmak:
    // çeviri alım yolunda TEK bir yerden geçmeli. İkinci bir çağrı hatayı büyütür.
    const ham = Date.UTC(2026, 7, 12, 21, 3, 0);
    const bir = trendyolDateToUtc(ham)!;
    const iki = trendyolDateToUtc(bir.getTime())!;

    expect(ham - iki.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it("pencere sınırlarını iki uçtan da GENİŞLETİR", () => {
    const t = Date.UTC(2026, 7, 12, 12, 0, 0);
    const uc = 3 * 60 * 60 * 1000;

    // Başlangıç geriye, bitiş ileriye → pencere daralmaz, en yeni siparişler kaçmaz.
    expect(padTrendyolWindow(t, "start")).toBe(t - uc);
    expect(padTrendyolWindow(t, "end")).toBe(t + uc);
    expect(padTrendyolWindow(t, "end")).toBeGreaterThan(padTrendyolWindow(t, "start"));
  });
});
