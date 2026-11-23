import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { bekleyenKomutuGeriCek, getCommandStatus, sendPrintCommand, type PrintAction } from "@/lib/db/printers";
import { color } from "@/theme/tokens";

export const KOMUT_ADI: Record<PrintAction, string> = {
  start: "Başlat",
  pause: "Duraklat",
  resume: "Devam",
  cancel: "İptal",
  exclude: "Parça iptali",
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
  /**
   * Zaman aşımında komut GERİ ÇEKİLİR: "geri" = beklerken iptal edildi (masaüstü artık uygulamaz);
   * "suruyor" = masaüstü çoktan almış → sonucu beklemeye devam edilir.
   */
  const [geriCekme, setGeriCekme] = useState<{ id: string; sonuc: "geri" | "suruyor" } | null>(null);
  const geriCekmeSonucu = geriCekme && gonderilen && geriCekme.id === gonderilen.id ? geriCekme.sonuc : null;
  const bekle = !!gonderilen && (!zamanAsimi || geriCekmeSonucu === "suruyor");
  const { data: komut = null } = useQuery({
    queryKey: ["command-status", gonderilen?.id ?? ""],
    queryFn: () => getCommandStatus(gonderilen!.id),
    refetchInterval: bekle ? 3000 : false,
    enabled: bekle,
  });
  const sonuclandi = komut?.status === "done" || komut?.status === "error";
  useEffect(() => {
    if (!zamanAsimi || !gonderilen || sonuclandi || geriCekmeSonucu) return;
    const id = gonderilen.id;
    void bekleyenKomutuGeriCek(id)
      .then((geri) => setGeriCekme({ id, sonuc: geri ? "geri" : "suruyor" }))
      .catch(() => setGeriCekme({ id, sonuc: "geri" }));
  }, [zamanAsimi, gonderilen, sonuclandi, geriCekmeSonucu]);
  const vazgecildi = zamanAsimi && geriCekmeSonucu === "geri" && !sonuclandi;
  useEffect(() => {
    if (!sonuclandi && !vazgecildi) return;
    const t = setTimeout(() => setGonderilen(null), vazgecildi ? 12_000 : 6000);
    return () => clearTimeout(t);
  }, [sonuclandi, vazgecildi]);

  const mesgul = !!gonderilen && !sonuclandi && !vazgecildi;

  /**
   * `param`: parça iptalinde yazıcıdaki parça adı. Parça iptalinin onayı seçim kartında sorulur
   * (hangi parça olduğu orada görünüyor) — burada ikinci kez sorulmaz.
   */
  const gonder = (yazici: { printerConfigId: string; name: string }, eylem: PrintAction, param?: string) => {
    if (mesgul) return;
    const yolla = async () => {
      try {
        const id = await sendPrintCommand(yazici.printerConfigId, eylem, undefined, param);
        setGonderilen({ id, ad: `${yazici.name}: ${KOMUT_ADI[eylem]}`, at: Date.now() });
        qc.invalidateQueries({ queryKey: ["command-status", id] });
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
      komut?.status === "done" ? color.good : komut?.status === "error" || vazgecildi ? color.bad : color.accentBright;
    const metin =
      komut?.status === "done"
        ? `✓ ${gonderilen.ad} uygulandı`
        : komut?.status === "error"
          ? `✕ ${komut.error ?? "Komut başarısız"}`
          : vazgecildi
            ? `⚠ ${gonderilen.ad} uygulanmadı — masaüstü kapalı görünüyor.`
            : `⏳ ${gonderilen.ad} gönderildi — masaüstü uyguluyor…`;
    bant = { metin, renk };
  }

  return { gonder, mesgul, bant };
}
