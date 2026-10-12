import { describe, expect, it } from "vitest";
import { kisaNeden, klipperMesajiCevir, uyariKisalt, uyariParcala } from "./yazici-uyari";

describe("uyariParcala — ne oldu / ne yapmalı", () => {
  it("ilk cümle başlık, kalanı ayrıntı olur", () => {
    expect(uyariParcala("AMS lite yuva 2'deki filament tükendi; lütfen yeni bir filament takın.")).toEqual({
      baslik: "AMS lite yuva 2'deki filament tükendi",
      aciklama: "Lütfen yeni bir filament takın.",
    });
    expect(
      uyariParcala("Kablosuz donanım hatası: Lütfen Wi-Fi'yi kapatıp tekrar açın veya cihazınızı yeniden başlatın.")
    ).toMatchObject({ baslik: "Kablosuz donanım hatası" });
  });

  it("tek cümlede ayrıntı yoktur, sondaki nokta atılır", () => {
    expect(uyariParcala("İş iptal edildi.")).toEqual({ baslik: "İş iptal edildi", aciklama: null });
  });

  it("ondalık sayı cümle sonu sayılmaz", () => {
    expect(uyariParcala("Nozul çapı 0.4 mm olarak ayarlı ama dosya 0.6 mm istiyor. Dosyayı kontrol edin.").baslik).toBe(
      "Nozul çapı 0.4 mm olarak ayarlı ama dosya 0.6 mm istiyor"
    );
  });

  it("boş metinde çökmeden boş döner", () => {
    expect(uyariParcala(null)).toEqual({ baslik: "", aciklama: null });
  });
});

describe("uyariKisalt", () => {
  it("kısa metne dokunmaz, uzun metinde başlığa iner", () => {
    expect(uyariKisalt("İş iptal edildi.")).toBe("İş iptal edildi.");
    const uzun = `Püskürtme ucu sıcaklığı anormal. ${"Lütfen kabloyu kontrol edin ".repeat(12)}`;
    expect(uyariKisalt(uzun, 80)).toBe("Püskürtme ucu sıcaklığı anormal");
  });
});

describe("kisaNeden — bildirim başlığı", () => {
  it.each([
    ["AMS lite yuva 2'deki filament tükendi; lütfen yeni bir filament takın.", "Filament bitti"],
    ["AMS lite yuva 1 boş; lütfen yeni bir filament takın.", "Filament bitti"],
    ["Harici makaradaki filament tükendi; lütfen yeni filament yükleyin.", "Filament bitti"],
    // "tükendi … sıkışıp sıkışmadığını" → önce BİTTİ'ye uymalı.
    [
      "AMS A yuva 4 filamenti tükendi ve eski filamentin temizlenmesi sırasında bir anormallik oluştu; lütfen filamentin takım kafasında sıkışıp sıkışmadığını kontrol edin.",
      "Filament bitti",
    ],
    ["AMS lite yuva 1 filamenti PTFE borunun içinde kopmuş olabilir.", "Filament koptu"],
    ["2. kafa filamenti çekemiyor — makara bitmiş ya da filament takılmış olabilir", "Filament beslenemiyor"],
    ["Baskı tablası algılanmadı. Lütfen baskı tablasını doğru şekilde yerleştirin.", "Tablayı kontrol et"],
    ["Baskı dağılmış olabilir (spagetti algılandı)", "Baskı dağılmış olabilir"],
    ["İş iptal edildi.", "Baskı iptal edildi"],
    ["Püskürtme ucu sıcaklığı anormal; ısıtıcıda kısa devre olabilir.", "Isıtma sorunu"],
    ["Filament bitti", "Filament bitti"],
  ])("%s → %s", (metin, beklenen) => {
    expect(kisaNeden(metin)).toBe(beklenen);
  });

  it("tanımadığı metinde ad uydurmaz", () => {
    expect(kisaNeden("X ekseninin rezonans frekansı son kalibrasyondan farklı.")).toBeNull();
    expect(kisaNeden("")).toBeNull();
  });
});

describe("klipperMesajiCevir — Snapmaker U1 / Klipper ham mesajları", () => {
  it("geçmişte görülen ham mesajlar anlaşılır Türkçeye çevrilir (kafa dizini sıfırdan başlar)", () => {
    expect(klipperMesajiCevir("extruder[2]: state: load_feeding, error: wheel_speed!raw msg:logic error!")).toBe(
      "3. kafa filamenti çekemiyor — makara bitmiş ya da filament takılmış olabilir"
    );
    expect(klipperMesajiCevir("extruder[3]: state: load_feeding, error: ok!raw msg:logic error!")).toBe(
      "4. kafaya filament yüklenemedi"
    );
    expect(klipperMesajiCevir("detected noodle")).toBe("Baskı dağılmış olabilir (spagetti algılandı)");
    expect(klipperMesajiCevir("detected dirty bed")).toBe("Tabla temiz değil — üzerinde parça ya da kalıntı var");
  });

  it("JSON biçimli hata: yalnız mesaj okunur, kafa adı kullanıcıya çevrilir", () => {
    const ham =
      '{"coded": "0002-0523-   1-0042", "oneshot": 0, "msg":"Extruder extruder1 malfunction after parking, extruder1 failed to return to park position. state: ACTIVATE [FTT]", "action": "pause"}';
    expect(klipperMesajiCevir(ham)).toBe("2. kafa park yerine dönemedi");
    // Kesik gelmiş JSON da çözülür.
    expect(klipperMesajiCevir(ham.slice(0, 150))).toBe("2. kafa park yerine dönemedi");
  });

  it("Klipper'ın genel hataları", () => {
    expect(klipperMesajiCevir("Heater heater_bed not heating at expected rate")).toMatch(/^Tabla beklenen hızda ısınmıyor/);
    expect(klipperMesajiCevir("Heater extruder1 not heating at expected rate")).toMatch(/^Nozul beklenen hızda ısınmıyor/);
    expect(klipperMesajiCevir("ADC out of range")).toMatch(/Sıcaklık sensörü okunamıyor/);
  });

  it("tanınmayan mesaj uydurulmaz, olduğu gibi kalır; boşsa null", () => {
    expect(klipperMesajiCevir("Probe triggered prior to movement")).toBe("Probe triggered prior to movement");
    expect(klipperMesajiCevir('{"msg": "Unknown thing happened"}')).toBe("Unknown thing happened");
    expect(klipperMesajiCevir("   ")).toBeNull();
  });
});
