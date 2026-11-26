import { kimlikCoz, ortakAnahtar, type OrtakEntegrasyon } from "@core/ortak-kimlik";
import { query } from "@/lib/turso";

/**
 * ORTAK ENTEGRASYON BİLGİLERİ — telefon tarafı.
 *
 * Masaüstünde girilen pazaryeri bilgileri veritabanında şifreli durur (`IntegrationSecret`,
 * çözüm `@core/ortak-kimlik`); telefon onları buradan okur. Böylece bir bilgisayarda girilen ya da
 * değiştirilen bilgi telefona YENİ GÜNCELLEME OLMADAN geçer. Ortak kayıt yoksa ya da okunamazsa
 * istemciler uygulamaya gömülü (EXPO_PUBLIC_*) bilgilerle devam eder.
 *
 * Sonuç bellekte 5 dk tutulur (her sipariş çekiminde veritabanına gidilmesin); hata önbelleğe
 * alınmaz, bir sonraki çekim yeniden dener.
 */
const OMUR_MS = 5 * 60_000;
const TOKEN = process.env.EXPO_PUBLIC_TURSO_TOKEN;
const onbellek = new Map<OrtakEntegrasyon, { at: number; deger: Promise<Record<string, string>> }>();

async function oku(ad: OrtakEntegrasyon): Promise<Record<string, string>> {
  if (!TOKEN) return {};
  const satirlar = await query<{ payload: string }>(`SELECT payload FROM IntegrationSecret WHERE name = ?`, [ad]);
  const paket = satirlar[0]?.payload;
  return (paket ? kimlikCoz(String(paket), ortakAnahtar(TOKEN)) : null) ?? {};
}

export function ortakKimlik(ad: OrtakEntegrasyon): Promise<Record<string, string>> {
  const c = onbellek.get(ad);
  if (c && Date.now() - c.at < OMUR_MS) return c.deger;
  const deger = oku(ad).catch(() => {
    onbellek.delete(ad); // tablo yok / ağ yok → gömülü bilgiyle devam, sonra yeniden dene
    return {} as Record<string, string>;
  });
  onbellek.set(ad, { at: Date.now(), deger });
  return deger;
}
