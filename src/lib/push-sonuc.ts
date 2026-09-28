import type { PushGonderimOzeti } from "@/lib/push-notify";

/**
 * Elle gönderilen bildirimin (ayarlardaki "Test" ve "Özel bildirim") ekrana dönen sonucu.
 * Teslim makbuzuna bakar: Expo'nun kabul etmesi telefona düştüğü anlamına gelmiyor.
 */
export type PushDurumu = "basarili" | "kismi" | "basarisiz" | "cihaz-yok";

export interface PushSonucu {
  durum: PushDurumu;
  mesaj: string;
  toplamCihaz: number;
  gonderildi: number;
  teslimEdilen: number;
  hata: number;
  temizlenenKayit: number;
  sebepler: string[];
  zaman: string;
}

export function pushSonucu(
  ozet: PushGonderimOzeti,
  secenek: { tekTelefon: boolean; ne: string }
): PushSonucu {
  const teslimEdilen = ozet.teslim?.basarili ?? 0;
  const durum: PushDurumu =
    ozet.toplamCihaz === 0
      ? "cihaz-yok"
      : teslimEdilen > 0 && ozet.hata === 0 && (ozet.teslim?.hatali ?? 0) === 0
        ? "basarili"
        : teslimEdilen > 0
          ? "kismi"
          : "basarisiz";

  const { ne } = secenek;
  const mesaj = secenek.tekTelefon
    ? durum === "cihaz-yok"
      ? "Bu telefon artık kayıtlı değil."
      : durum === "basarili"
        ? `${ne} telefona ulaştı.`
        : `${ne} telefona ulaşmadı.`
    : durum === "cihaz-yok"
      ? "Kayıtlı telefon yok. Telefondaki uygulamayı açıp bildirim iznini verin."
      : durum === "basarili"
        ? `${ne} ${teslimEdilen} telefona ulaştı.`
        : durum === "kismi"
          ? `${teslimEdilen} telefona ulaştı, bazılarına ulaşmadı.`
          : "Hiçbir telefona ulaşmadı.";

  return {
    durum,
    mesaj,
    toplamCihaz: ozet.toplamCihaz,
    gonderildi: ozet.gonderildi,
    teslimEdilen,
    hata: ozet.hata + (ozet.teslim?.hatali ?? 0),
    temizlenenKayit: ozet.temizlenenKayit,
    sebepler: ozet.sebepler,
    zaman: ozet.zaman,
  };
}

/** Özel bildirim sınırları — iOS kilit ekranı ~4 satır gösteriyor; uzun metin kesilir. */
export const OZEL_BASLIK_AZAMI = 60;
export const OZEL_METIN_AZAMI = 300;
export const VARSAYILAN_BASLIK = "Magicland 3D Hub";

export type OzelBildirim =
  | { tamam: true; baslik: string; metin: string; cihaz: string | undefined }
  | { tamam: false; hata: string };

/** Ayarlardaki "Özel bildirim gönder" isteğini doğrula. Başlık boşsa uygulama adı. */
export function ozelBildirimOku(govde: unknown): OzelBildirim {
  const g = (govde && typeof govde === "object" ? govde : {}) as Record<string, unknown>;
  const baslik = typeof g.baslik === "string" ? g.baslik.trim() : "";
  const metin = typeof g.metin === "string" ? g.metin.trim() : "";
  const cihaz = typeof g.cihaz === "string" && g.cihaz ? g.cihaz : undefined;
  if (!metin) return { tamam: false, hata: "Bildirim metni boş olamaz." };
  if (metin.length > OZEL_METIN_AZAMI) return { tamam: false, hata: `Metin en fazla ${OZEL_METIN_AZAMI} karakter olabilir.` };
  if (baslik.length > OZEL_BASLIK_AZAMI) return { tamam: false, hata: `Başlık en fazla ${OZEL_BASLIK_AZAMI} karakter olabilir.` };
  return { tamam: true, baslik: baslik || VARSAYILAN_BASLIK, metin, cihaz };
}
