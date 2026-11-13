import { HepsiburadaApiError } from "@/services/hepsiburada-client";
import { KullaniciHatasi } from "./kullanici-hatasi";
import { kopyaKaydet, kopyaOku } from "./kayit";
import { pngCoz, pngMi } from "./png-coz";
import { etiketeSigdir, zplGrafik } from "./zpl-resim";

/**
 * Hepsiburada kargo etiketi → 100×100 termal etikete sığmış ZPL.
 *
 * HB etiketi 100×150 mm (ölçüldü 13 Kas 2026) → resmi (png) istenir, küçültülüp ZPL grafiğine
 * çevrilir. Trendyol'un ham ZPL'i gibi DOĞRUDAN gönderilemez (iki etikete bölünür).
 * Yalnız paketlenmiş siparişte (paket no) ve HB'nin ortak barkod verdiği firmalarda (HepsiJET,
 * Aras) çalışır. Paketin durumunu değiştirmez.
 */

export interface HbEtiketKaynagi {
  getPackageLabel(paketNo: string, format: "png" | "zpl"): Promise<{ format: string; data: string[] }>;
}

function base64Coz(ham: string): Buffer {
  const veri = ham.startsWith("data:") ? ham.slice(ham.indexOf(",") + 1) : ham;
  return Buffer.from(veri, "base64");
}

function kullaniciMesaji(hata: unknown): KullaniciHatasi | null {
  if (!(hata instanceof HepsiburadaApiError)) return null;
  const metin = `${hata.message} ${JSON.stringify(hata.details ?? "")}`;
  if (/mutual barcode/i.test(metin)) {
    return new KullaniciHatasi("Hepsiburada bu kargo firması için etiket vermiyor.", hata);
  }
  if (hata.status === 401 || hata.status === 403) {
    return new KullaniciHatasi("Hepsiburada bağlantı bilgilerini kontrol et.", hata);
  }
  if (hata.status === 429) return new KullaniciHatasi("Hepsiburada çok sık istek aldı. Biraz bekleyip tekrar dene.", hata);
  if (hata.status === 400 || hata.status === 404) {
    return new KullaniciHatasi("Hepsiburada bu paket için etiket vermedi. Paketlendiğinden emin ol.", hata);
  }
  return new KullaniciHatasi("Hepsiburada'ya ulaşılamadı. Tekrar dene.", hata);
}

export async function hbEtiketiGetir(
  kaynak: HbEtiketKaynagi,
  paketNo: string,
  anahtar: string,
  secenek: { yerelKopyaKullan?: boolean } = {}
): Promise<{ etiketler: string[]; kaynak: "kopya" | "hepsiburada" }> {
  if (secenek.yerelKopyaKullan !== false) {
    const kopya = kopyaOku(anahtar);
    if (kopya) return { etiketler: kopya, kaynak: "kopya" };
  }
  let yanit: { format: string; data: string[] };
  try {
    yanit = await kaynak.getPackageLabel(paketNo, "png");
  } catch (hata) {
    throw kullaniciMesaji(hata) ?? hata;
  }
  if (!yanit.data.length) {
    throw new KullaniciHatasi("Hepsiburada bu paket için etiket vermedi. Paketlendiğinden emin ol.");
  }
  const etiketler = yanit.data.map((parca) => {
    const png = base64Coz(parca);
    if (!pngMi(png)) throw new KullaniciHatasi("Hepsiburada etiketi okunamadı. Tekrar dene.");
    // Berke'nin kararı (13 Kas 2026): yalnız üstteki KARGO etiketi basılır (kesik çizginin
    // altındaki ürün/fatura fişi değil) → ~%97 boyutta, barkodlar net. Çizgi bulunamazsa tamamı sığdırılır.
    return zplGrafik(etiketeSigdir(pngCoz(png), undefined, { yalnizUstKisim: true }));
  });
  kopyaKaydet(anahtar, etiketler);
  return { etiketler, kaynak: "hepsiburada" };
}
