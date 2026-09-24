import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { getRecentCommands, sendPrintCommand, type PrintAction } from "@/lib/db/printers";
import { color } from "@/theme/tokens";

export const KOMUT_ADI: Record<PrintAction, string> = {
  start: "Başlat",
  pause: "Duraklat",
  resume: "Devam",
  cancel: "İptal",
};

/** Masaüstü bu sürede uygulamazsa komut "uygulanmadı" sayılır (masaüstü kapalı/uyuyor). */
const ZAMAN_ASIMI_MS = 90_000;

export interface KomutBandi {
  metin: string;
  renk: string;
}

/**
 * YAZICI KOMUTLARI — Yazıcılar listesi ve yazıcı ekranı AYNI mantığı kullanır: iptal onayı,
 * çift gönderim kilidi (komut beklerken düğmeler pasif), 90 sn zaman aşımı ve sonuç bandı.
 * Komut telefondan veritabanına yazılır, LAN'daki masaüstü ~10 sn içinde uygular.
 *
 * `simdi`: ekranın periyodik saati — zaman aşımı veri gelmese de ilerlesin.
 */
export function useYaziciKomutu(simdi: number) {
  const qc = useQueryClient();
  const [gonderilen, setGonderilen] = useState<{ id: string; ad: string; at: number } | null>(null);
  const zamanAsimi = !!gonderilen && simdi - gonderilen.at > ZAMAN_ASIMI_MS;
  const { data: komutlar = [] } = useQuery({
    queryKey: ["recent-commands"],
    queryFn: getRecentCommands,
    refetchInterval: gonderilen && !zamanAsimi ? 3000 : false,
    enabled: !!gonderilen && !zamanAsimi,
  });
  const komut = gonderilen ? komutlar.find((c) => c.id === gonderilen.id) : null;
  const sonuclandi = komut?.status === "done" || komut?.status === "error";
  useEffect(() => {
    if (!sonuclandi && !zamanAsimi) return;
    const t = setTimeout(() => setGonderilen(null), zamanAsimi ? 12_000 : 6000);
    return () => clearTimeout(t);
  }, [sonuclandi, zamanAsimi]);

  const mesgul = !!gonderilen && !sonuclandi && !zamanAsimi;

  const gonder = (yazici: { printerConfigId: string; name: string }, eylem: PrintAction) => {
    if (mesgul) return;
    const yolla = async () => {
      try {
        const id = await sendPrintCommand(yazici.printerConfigId, eylem);
        setGonderilen({ id, ad: `${yazici.name}: ${KOMUT_ADI[eylem]}`, at: Date.now() });
        qc.invalidateQueries({ queryKey: ["recent-commands"] });
      } catch {
        Alert.alert("Hata", "Komut gönderilemedi (bağlantı sorunu).");
      }
    };
    if (eylem === "cancel") {
      Alert.alert("Baskıyı iptal et", `${yazici.name} üzerindeki baskı iptal edilsin mi? Bu işlem geri alınamaz.`, [
        { text: "Vazgeç", style: "cancel" },
        { text: "İptal et", style: "destructive", onPress: yolla },
      ]);
    } else {
      void yolla();
    }
  };

  let bant: KomutBandi | null = null;
  if (gonderilen) {
    const renk =
      komut?.status === "done" ? color.good : komut?.status === "error" || zamanAsimi ? color.bad : color.accentBright;
    const metin =
      komut?.status === "done"
        ? `✓ ${gonderilen.ad} uygulandı`
        : komut?.status === "error"
          ? `✕ ${komut.error ?? "Komut başarısız"}`
          : zamanAsimi
            ? `⚠ ${gonderilen.ad} uygulanmadı — masaüstü kapalı görünüyor.`
            : `⏳ ${gonderilen.ad} gönderildi — masaüstü uyguluyor…`;
    bant = { metin, renk };
  }

  return { gonder, mesgul, bant };
}
