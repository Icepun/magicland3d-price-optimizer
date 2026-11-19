/**
 * KARGO ADRESİ ayrıştırıcı — kalıplar canlı veriden (Kas 2026, son 40 Shopify siparişi; `city` ve
 * `province` değerleri gerçek biçimlerdir, ad / sokak / telefon UYDURMADIR).
 */
import { describe, expect, it } from "vitest";
import { adresCoz, mahalleEsle, sade, telefonCoz, type HamAdres, type IlKaydi } from "./adres-coz";

const iller: IlKaydi[] = [
  { ad: "İSTANBUL", ilceler: ["KARTAL", "KAĞITHANE", "ATAŞEHİR", "KADIKÖY", "MALTEPE", "SARIYER", "BEŞİKTAŞ"] },
  { ad: "ANKARA", ilceler: ["ÇANKAYA", "KEÇİÖREN", "ETİMESGUT"] },
  { ad: "İZMİR", ilceler: ["KARABAĞLAR", "BAYRAKLI", "BUCA", "MENEMEN"] },
  { ad: "ZONGULDAK", ilceler: ["MERKEZ", "EREĞLİ"] },
  { ad: "KONYA", ilceler: ["EREĞLİ", "SELÇUKLU"] },
  { ad: "MERSİN", ilceler: ["ANAMUR", "MEZİTLİ"] },
  { ad: "AYDIN", ilceler: ["EFELER"] },
  { ad: "ÇANAKKALE", ilceler: ["MERKEZ", "BİGA"] },
  { ad: "AMASYA", ilceler: ["MERKEZ"] },
  { ad: "BURSA", ilceler: ["MUDANYA", "NİLÜFER"] },
  { ad: "ANTALYA", ilceler: ["MURATPAŞA"] },
];

const adres = (o: Partial<HamAdres>): HamAdres => ({
  ad: "Deneme", soyad: "Müşteri", address1: "Örnek Mah.", address2: "Lale Sok. No:1 D:2",
  city: "", province: "", zip: "", phone: "05321234567", ...o,
});
const coz = (o: Partial<HamAdres>) => adresCoz(adres(o), iller);

describe("il + ilçe city alanında", () => {
  it("city = ilçe, province = il (ASCII yazım)", () => {
    const r = coz({ city: "Kartal", province: "Istanbul" });
    expect(r).toMatchObject({ il: "İSTANBUL", ilce: "KARTAL" });
    expect(r.kontrol).toEqual({});
  });

  it('"İlçe / İl" — province boş olsa da; aynı adlı ilçe doğru ilde aranır', () => {
    expect(coz({ city: "Kağıthane / İstanbul" })).toMatchObject({ il: "İSTANBUL", ilce: "KAĞITHANE", kontrol: {} });
    expect(coz({ city: "Ereğli/ Zonguldak" })).toMatchObject({ il: "ZONGULDAK", ilce: "EREĞLİ", kontrol: {} });
    expect(coz({ city: "Efeler/Aydın", province: "Aydın" })).toMatchObject({ il: "AYDIN", ilce: "EFELER" });
    expect(coz({ city: "Mersin anamur" })).toMatchObject({ il: "MERSİN", ilce: "ANAMUR" });
  });

  it("küçük harf / Türkçe harfsiz yazım", () => {
    expect(coz({ city: "ataşehir", province: "Istanbul" })).toMatchObject({ il: "İSTANBUL", ilce: "ATAŞEHİR" });
    expect(coz({ city: "Cankaya", province: "Ankara" })).toMatchObject({ il: "ANKARA", ilce: "ÇANKAYA" });
  });

  it('city "Merkez" → o ilin Merkez ilçesi', () => {
    expect(coz({ city: "Merkez", province: "Çanakkale" })).toMatchObject({ il: "ÇANAKKALE", ilce: "MERKEZ", kontrol: {} });
  });

  it("adreste tesadüfen geçen başka il adı sonucu bulandırmaz", () => {
    const r = coz({ city: "Merkez", province: "Çanakkale", address2: "Amasya Sok. No:3" });
    expect(r).toMatchObject({ il: "ÇANAKKALE", ilce: "MERKEZ" });
    expect(r.kontrol.ilce).toBeUndefined();
  });
});

describe("ilçe adres metninde — bulunur ama işaretlenir", () => {
  it("city yalnız il; ilçe adresin sonunda ya da ikinci satırda", () => {
    const r = coz({ city: "Ankara", province: "Ankara", address2: "Gül Sok. No:4 Keçiören/Ankara" });
    expect(r).toMatchObject({ il: "ANKARA", ilce: "KEÇİÖREN" });
    expect(r.kontrol.ilce).toMatch(/adres metninden/);
    expect(coz({ city: "Ankara", address2: "ETİMESGUT" })).toMatchObject({ il: "ANKARA", ilce: "ETİMESGUT" });
  });

  it('"Merkez Mah." ilçe sayılmaz; yalnız il yazılmışsa Merkez VARSAYILIR ve söylenir', () => {
    const r = coz({ city: "Zonguldak", address1: "Merkez Mah." });
    expect(r).toMatchObject({ il: "ZONGULDAK", ilce: "MERKEZ" });
    expect(r.kontrol.ilce).toMatch(/varsayıldı/);
    expect(coz({ city: "Amasya", province: "Amasya" }).kontrol.ilce).toMatch(/varsayıldı/);
  });

  it("ilçe hiçbir yerde yoksa tahmin edilmez", () => {
    const r = coz({ city: "Bursa", province: "Bursa" });
    expect(r).toMatchObject({ il: "BURSA", ilce: null });
    expect(r.kontrol.ilce).toMatch(/bulunamadı/);
    // city'ye posta kodu yazılmış (canlıda görüldü)
    expect(coz({ city: "35380", province: "Izmir" })).toMatchObject({ il: "İZMİR", ilce: null });
  });
});

describe("il belirsiz / çelişkili", () => {
  it("province yanlış seçilmiş: adres başka ili gösteriyorsa o alınır ve uyarılır", () => {
    const r = coz({ city: "İstanbul", province: "Amasya", address2: "Deniz Cad. No:7 Sarıyer" });
    expect(r).toMatchObject({ il: "İSTANBUL", ilce: "SARIYER" });
    expect(r.kontrol.il).toMatch(/AMASYA/);
  });

  it("il hiç yazılmamış: ilçe ülkede tekse il ondan çıkar; birden çok ilde varsa çıkmaz", () => {
    const tek = coz({ city: "Kartal" });
    expect(tek).toMatchObject({ il: "İSTANBUL", ilce: "KARTAL" });
    expect(tek.kontrol.il).toMatch(/ilçeden/);
    const cift = coz({ city: "Ereğli" });
    expect(cift).toMatchObject({ il: null, ilce: null });
    expect(cift.kontrol.il).toMatch(/birden çok/);
    expect(coz({ city: "", address2: "No:1" }).kontrol.il).toMatch(/bulunamadı/);
  });
});

describe("telefon, mahalle, adres, ad", () => {
  it("telefon üç biçimden 05xxxxxxxxx'e; cep değilse boş + uyarı", () => {
    for (const t of ["5321234567", "05321234567", "+905321234567", "0090 532 123 45 67", "0 (532) 123-45-67"]) {
      expect(telefonCoz(t)).toBe("05321234567");
    }
    expect(telefonCoz("0212 123 45 67")).toBeNull();
    expect(telefonCoz("")).toBeNull();
    expect(coz({ phone: "123" }).kontrol.telefon).toBeTruthy();
  });

  it("mahalle adayı: kalıptan ya da kısa ilk satırdan; listeyle eşleşme ek / harf farkı gözetmez", () => {
    expect(coz({ address1: "Yenişehir Mah." }).mahalle).toBe("Yenişehir");
    expect(coz({ address1: "Kültür" }).mahalle).toBe("Kültür");
    expect(coz({ address1: "Atatürk Cad. No:5", address2: "Çınar mahallesi 12. sokak" }).mahalle).toBe("Çınar");
    expect(coz({ address1: "Atatürk Cad. No:5", address2: "Kat 2" }).mahalle).toBeNull();
    expect(mahalleEsle("Yenisehir", ["YENİŞEHİR MAH.", "YENİ MAH."])).toBe("YENİŞEHİR MAH.");
    expect(mahalleEsle("29 Ekim", ["29 EKİM", "30 AĞUSTOS"])).toBe("29 EKİM");
    expect(mahalleEsle("Olmayan", ["YENİŞEHİR"])).toBeNull();
    expect(mahalleEsle(null, ["YENİŞEHİR"])).toBeNull();
  });

  it("iki adres satırı birleşir; aynı metin iki kez yazılmışsa yinelenmez", () => {
    expect(coz({ address1: "Örnek Mah.", address2: "Lale Sok. No:1" }).acikAdres).toBe("Örnek Mah. Lale Sok. No:1");
    expect(coz({ address1: "Örnek Mah. Lale Sok. No:1", address2: "örnek mah lale sok no 1" }).acikAdres).toBe("Örnek Mah. Lale Sok. No:1");
    expect(coz({ address1: "Lale Sok.", address2: "Örnek Mah. Lale Sok. No:1 Daire 2" }).acikAdres).toBe("Örnek Mah. Lale Sok. No:1 Daire 2");
    expect(coz({ address1: "A", address2: "" }).kontrol.adres).toBeTruthy();
  });

  it("soyad boşsa ad son sözcükten bölünür", () => {
    expect(coz({ ad: "Ayşe Nur Yılmaz", soyad: "" })).toMatchObject({ ad: "Ayşe Nur", soyad: "Yılmaz" });
    expect(coz({ ad: "Tekad", soyad: "" }).kontrol.ad).toBeTruthy();
  });

  it("sadeleştirme: İ/ı/i tek harfe iner", () => {
    expect(sade("İstanbul")).toBe(sade("ISTANBUL"));
    expect(sade("Çiğli-Şişli")).toBe("CIGLI SISLI");
  });
});
