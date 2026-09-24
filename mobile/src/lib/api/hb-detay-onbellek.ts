import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { hbDetayGovdesiniOku, hbDetayGovdesiYaz, type HbDetayKaydi } from "@/lib/api/hb-detay-bicim";
import type { HbDetayDeposu } from "@/lib/api/hepsiburada";

/**
 * HEPSİBURADA SİPARİŞ DETAYI — DİSKTE KALICI ÖNBELLEK.
 *
 * NEDEN: kargoya verilmiş/teslim edilmiş HB siparişlerinin kalemleri paket özetinde gelmiyor;
 * her biri için ayrı detay isteği gerekiyor. Kalemler/tutar/müşteri/sipariş tarihi sipariş
 * verildikten sonra DEĞİŞMEZ, ama önbellek yalnız BELLEKTEYDİ: uygulama her soğuk açılışta
 * aynı ~40 detayı yeniden çekiyordu (ölçüldü: açılıştaki 53 isteğin 41'i HB detayı). Diske
 * yazınca açılışta yalnız YENİ siparişlerin detayı çekilir.
 *
 * Veri aynı: diskten gelen kalem, HB'nin döndürdüğü kalemin birebir kopyası (eşleştirme
 * anahtarları dahil) → kâr hesabı değişmez. Biçim ve doğrulama `hb-detay-bicim.ts`te (saf).
 *
 * ⚠️ Dosya ilk kullanımda açılır (modül yüklenirken değil), web'de hiç açılmaz. Her hata
 * sessiz: bu bir kolaylık, açılışı ya da sipariş listesini engelleme hakkı yok.
 */

let dosya: File | null = null;
function detayDosyasi(): File | null {
  if (Platform.OS === "web") return null;
  if (!dosya) dosya = new File(Paths.cache, "mlhub-hb-detay.json");
  return dosya;
}

function yukle(hedef: Map<string, HbDetayKaydi>): void {
  let f: File | null = null;
  try {
    f = detayDosyasi();
    if (!f || !f.exists) return;
    if (!hbDetayGovdesiniOku(f.textSync(), hedef)) f.delete();
  } catch {
    try {
      f?.delete();
    } catch {
      /* bir sonraki yazma üzerine yazar */
    }
  }
}

function kaydet(kaynak: Map<string, HbDetayKaydi>, enCok: number): void {
  try {
    detayDosyasi()?.write(hbDetayGovdesiYaz(kaynak, enCok, Date.now()));
  } catch {
    /* yazılamadıysa bir sonraki açılış yeniden çeker — veri kaybı yok */
  }
}

/** Uygulama açılışta `hbDetayDeposunuKur(hbDiskDeposu)` ile bağlar (lib/query.tsx). */
export const hbDiskDeposu: HbDetayDeposu = { yukle, kaydet };
