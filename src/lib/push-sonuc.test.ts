import { describe, expect, it } from "vitest";

import type { PushGonderimOzeti } from "./push-notify";
import { OZEL_BASLIK_AZAMI, OZEL_METIN_AZAMI, VARSAYILAN_BASLIK, ozelBildirimOku, pushSonucu } from "./push-sonuc";

function ozet(p: Partial<PushGonderimOzeti>): PushGonderimOzeti {
  return { toplamCihaz: 2, gonderildi: 2, hata: 0, temizlenenKayit: 0, sebepler: [], zaman: "t", ...p };
}

describe("özel bildirim girdisi", () => {
  it("metin zorunlu; boşluk da boş sayılır", () => {
    expect(ozelBildirimOku({ metin: "   " })).toEqual({ tamam: false, hata: "Bildirim metni boş olamaz." });
    expect(ozelBildirimOku(null).tamam).toBe(false);
    expect(ozelBildirimOku("metin").tamam).toBe(false);
  });

  it("başlık boşsa uygulama adı; kenar boşlukları atılır", () => {
    expect(ozelBildirimOku({ baslik: "  ", metin: " Kargo geldi " })).toEqual({
      tamam: true,
      baslik: VARSAYILAN_BASLIK,
      metin: "Kargo geldi",
      cihaz: undefined,
    });
  });

  it("tek telefon hedefi taşınır", () => {
    const g = ozelBildirimOku({ baslik: "Atölye", metin: "U1 bitti", cihaz: "ExponentPushToken[x]" });
    expect(g).toMatchObject({ tamam: true, baslik: "Atölye", cihaz: "ExponentPushToken[x]" });
  });

  it("uzunluk sınırları", () => {
    expect(ozelBildirimOku({ metin: "a".repeat(OZEL_METIN_AZAMI) }).tamam).toBe(true);
    expect(ozelBildirimOku({ metin: "a".repeat(OZEL_METIN_AZAMI + 1) }).tamam).toBe(false);
    expect(ozelBildirimOku({ metin: "a", baslik: "b".repeat(OZEL_BASLIK_AZAMI + 1) }).tamam).toBe(false);
  });
});

describe("gönderim sonucu", () => {
  it("makbuz gelmeden 'ulaştı' denmez", () => {
    expect(pushSonucu(ozet({}), { tekTelefon: false, ne: "Bildirim" }).durum).toBe("basarisiz");
  });

  it("hepsine ulaştı / bir kısmına ulaştı / cihaz yok", () => {
    const tamam = pushSonucu(ozet({ teslim: { basarili: 2, hatali: 0 } }), {
      tekTelefon: false,
      ne: "Bildirim",
    });
    expect(tamam).toMatchObject({ durum: "basarili", mesaj: "Bildirim 2 telefona ulaştı.", teslimEdilen: 2 });
    const kismi = pushSonucu(ozet({ teslim: { basarili: 1, hatali: 1 } }), {
      tekTelefon: false,
      ne: "Bildirim",
    });
    expect(kismi).toMatchObject({ durum: "kismi", hata: 1 });
    expect(pushSonucu(ozet({ toplamCihaz: 0 }), { tekTelefon: true, ne: "Bildirim" }).mesaj).toBe(
      "Bu telefon artık kayıtlı değil."
    );
  });

  it("test düğmesinin metni değişmedi", () => {
    const r = pushSonucu(ozet({ toplamCihaz: 1, teslim: { basarili: 1, hatali: 0 } }), {
      tekTelefon: true,
      ne: "Test bildirimi",
    });
    expect(r.mesaj).toBe("Test bildirimi telefona ulaştı.");
  });
});
