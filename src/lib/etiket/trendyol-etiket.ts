import { TrendyolApiError } from "@/services/trendyol-client";
import { KullaniciHatasi } from "./kullanici-hatasi";
import { kopyaKaydet, kopyaOku } from "./kayit";

/**
 * Trendyol kargo etiketini (ortak etiket, ZPL) getirir — önce yerel kopya, sonra Trendyol.
 *
 * Akış: yerel kopya → GET (daha önce oluşturulduysa yeniden OLUŞTURMA) → yoksa POST create
 * → etiket hazırlanana dek kısa aralıklarla GET. Oluşturma isteği pakete durum yazmaz.
 */

export interface EtiketKaynagi {
  createCommonLabel(takipNo: string, koliAdedi?: number): Promise<void>;
  getCommonLabel(takipNo: string): Promise<string[]>;
}

/**
 * Hesapta servis kapalı mı? Ölçüldü 13 Kas 2026 (Berke'nin hesabı): 400
 * `COMMON_LABEL_NOT_ALLOWED` "Bu servisi kullanmak için yetkiniz bulunmamaktadır. Kategori
 * sorumlunuz ile iletişime geçiniz." → Trendyol açana dek hiçbir etiket alınamaz; yeniden
 * deneme ya da oluşturma anlamsız.
 */
export const SERVIS_KAPALI_MESAJI =
  "Trendyol bu hesapta etiket servisini açmamış. Kategori sorumlundan açmasını iste.";

function servisKapali(hata: unknown): boolean {
  if (!(hata instanceof TrendyolApiError)) return false;
  return /COMMON_LABEL_NOT_ALLOWED/i.test(`${hata.message} ${JSON.stringify(hata.details ?? "")}`);
}

/** GET'in "henüz yok" cevabı mı (yeniden denenir) yoksa gerçek hata mı (kullanıcıya gider)? */
function henuzYok(hata: unknown): boolean {
  return (
    hata instanceof TrendyolApiError && (hata.status === 400 || hata.status === 404) && !servisKapali(hata)
  );
}

const bekle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function trendyolEtiketiGetir(
  kaynak: EtiketKaynagi,
  takipNo: string,
  secenek: { yerelKopyaKullan?: boolean; bekleme?: (ms: number) => Promise<void>; deneme?: number; aralikMs?: number } = {}
): Promise<{ etiketler: string[]; kaynak: "kopya" | "trendyol" }> {
  const uyku = secenek.bekleme ?? bekle;
  if (secenek.yerelKopyaKullan !== false) {
    const kopya = kopyaOku(takipNo);
    if (kopya) return { etiketler: kopya, kaynak: "kopya" };
  }

  const getir = async (): Promise<string[]> => {
    try {
      return await kaynak.getCommonLabel(takipNo);
    } catch (hata) {
      if (servisKapali(hata)) throw new KullaniciHatasi(SERVIS_KAPALI_MESAJI, hata);
      if (henuzYok(hata)) return [];
      throw hata;
    }
  };

  let etiketler = await getir();
  if (!etiketler.length) {
    try {
      await kaynak.createCommonLabel(takipNo, 1);
    } catch (hata) {
      if (servisKapali(hata)) throw new KullaniciHatasi(SERVIS_KAPALI_MESAJI, hata);
      throw hata;
    }
    const deneme = secenek.deneme ?? 8;
    for (let i = 0; i < deneme && !etiketler.length; i++) {
      await uyku(secenek.aralikMs ?? 1500);
      etiketler = await getir();
    }
  }
  if (!etiketler.length) {
    throw new KullaniciHatasi("Trendyol etiketi henüz hazırlamadı. Birkaç saniye sonra tekrar dene.");
  }
  kopyaKaydet(takipNo, etiketler);
  return { etiketler, kaynak: "trendyol" };
}
