import { TrendyolClient, TrendyolApiError } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { hamYazdir, yaziciDurumu } from "@/lib/etiket/ham-yazici";
import { trendyolEtiketiGetir } from "@/lib/etiket/trendyol-etiket";
import { hbEtiketiGetir } from "@/lib/etiket/hb-etiket";
import { basildiIsaretle, eskiKopyalariSupur, etiketleriBirlestir } from "@/lib/etiket/kayit";
import { KullaniciHatasi } from "@/lib/etiket/kullanici-hatasi";

/**
 * KARGO ETİKETİNİ BAS — Siparişler ekranındaki düğme (API uçları) ve telefondan gelen istek
 * (`telefon-istekleri`) AYNI yoldan geçer: etiketi al → etiket yazıcısına ham gönder → yerel
 * "basıldı" işareti. Pazaryerinde sipariş/paket durumu DEĞİŞMEZ.
 *
 * Hata her zaman `EtiketBasilamadi` olarak çıkar; mesajı kullanıcıya olduğu gibi gösterilir.
 */
export class EtiketBasilamadi extends Error {
  constructor(
    message: string,
    /** Bu bilgisayarda etiket yazıcısı seçili değil — arayüz yazıcı seçtirir. */
    readonly yaziciGerekli = false
  ) {
    super(message);
    this.name = "EtiketBasilamadi";
  }
}

export interface EtiketBaskisi {
  /** "Basıldı" işaretinin anahtarı (takip/teslimat no, yoksa paket no). */
  anahtar: string;
  basildi: string;
  etiketSayisi: number;
}

async function seciliYazici(): Promise<string> {
  const { secili } = await yaziciDurumu().catch(() => {
    throw new EtiketBasilamadi("Etiket basılamadı. Tekrar dene.");
  });
  if (!secili) throw new EtiketBasilamadi("Etiket yazıcısı seçilmedi.", true);
  return secili;
}

/** Trendyol ortak etiketi (ZPL). */
export async function trendyolEtiketiBas(takipNo: string): Promise<EtiketBaskisi> {
  const yazici = await seciliYazici();
  try {
    const istemci = new TrendyolClient(await getTrendyolCredentials());
    const { etiketler, kaynak } = await trendyolEtiketiGetir(istemci, takipNo);
    await hamYazdir(yazici, etiketleriBirlestir(etiketler));
    const basildi = basildiIsaretle(takipNo);
    eskiKopyalariSupur();
    console.info(`[etiket] ${takipNo} → ${yazici} (${etiketler.length} etiket, ${kaynak})`);
    return { anahtar: takipNo, basildi, etiketSayisi: etiketler.length };
  } catch (error) {
    console.error(`[etiket] ${takipNo} basılamadı:`, error);
    throw new EtiketBasilamadi(trendyolMesaji(error));
  }
}

/** Hepsiburada paket etiketi — 100×150 gelir, kargo kısmı 100×100'e sığdırılır. */
export async function hbEtiketiBas(paketNo: string, takipNo: string | null): Promise<EtiketBaskisi> {
  const yazici = await seciliYazici();
  const anahtar = takipNo ?? paketNo;
  try {
    const istemci = new HepsiburadaClient(await getHepsiburadaCredentials());
    const { etiketler, kaynak } = await hbEtiketiGetir(istemci, paketNo, anahtar);
    await hamYazdir(yazici, etiketleriBirlestir(etiketler));
    const basildi = basildiIsaretle(anahtar);
    eskiKopyalariSupur();
    console.info(`[etiket] HB ${paketNo} → ${yazici} (${etiketler.length} etiket, ${kaynak})`);
    return { anahtar, basildi, etiketSayisi: etiketler.length };
  } catch (error) {
    console.error(`[etiket] HB ${paketNo} basılamadı:`, error);
    throw new EtiketBasilamadi(
      error instanceof KullaniciHatasi
        ? error.message
        : error instanceof Error && /okunamad|eksik/i.test(error.message)
          ? "Hepsiburada bağlantısı kurulmamış."
          : "Etiket basılamadı. Tekrar dene."
    );
  }
}

function trendyolMesaji(error: unknown): string {
  if (error instanceof TrendyolApiError) {
    if (error.status === 401 || error.status === 403) return "Trendyol bağlantı bilgilerini kontrol et.";
    if (error.status === 429) return "Trendyol çok sık istek aldı. Biraz bekleyip tekrar dene.";
    if (error.status === 408) return "Trendyol yanıt vermedi. Tekrar dene.";
    if (error.status === 400 || error.status === 404) {
      return "Trendyol bu gönderi için etiket vermedi. Kargo firması Trendyol Express mi, kontrol et.";
    }
    return "Trendyol'a ulaşılamadı. Tekrar dene.";
  }
  if (error instanceof KullaniciHatasi) return error.message;
  // Trendyol ayarı eksikse ayar okuyucunun hatası gelir (bkz. trendyol-settings).
  if (error instanceof Error && /okunamad|eksik/i.test(error.message)) return "Trendyol bağlantısı kurulmamış.";
  return "Etiket basılamadı. Tekrar dene.";
}
