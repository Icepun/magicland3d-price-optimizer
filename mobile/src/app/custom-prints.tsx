import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import { Button, EmptyState, ErrorState, FadeInView, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import {
  bekleyenKomutuGeriCek, getCustomPrints, getPrinterSnapshots, getCommandStatus, sendPrintCommand, type CustomPrint,
} from "@/lib/db/printers";
import { getSettingsMap } from "@/lib/db/rules";
import { formatNumber } from "@/lib/format";
import { useManualRefresh } from "@/lib/use-refresh";
import { YAZICI_BAYAT_MS, satirYasiMs } from "@/lib/yazici-tazelik";
import { color, radius, space } from "@/theme/tokens";

/**
 * Komut hatası — teknik metin (İngilizce, HTTP kodu…) kullanıcıya gösterilmez. Masaüstünün yazdığı
 * Türkçe nedenler ("Yazıcı bulunamadı", "Zaman aşımı — …") olduğu gibi kalır.
 */
function komutHatasi(hata: string | null | undefined): string {
  if (!hata) return "Başlatılamadı";
  return /HTTP|fetch|Error|ECONN|ETIMEDOUT|undefined|null|Failed|JSON|socket/i.test(hata) ? "Baskı başlatılamadı" : hata;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function fmtDur(min: number | null): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}sa ${m}dk` : `${m}dk`;
}
function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
  } catch {
    return "";
  }
}

/**
 * ÖZEL BASKILAR — masaüstünden yüklenen (ürüne bağlı olmayan) gcode/3mf dosyaları; ait olduğu
 * yazıcıyla tekrar bas. Kapılar (Bambu, bulut, meşgul, çevrimdışı) ve komut izleme öncekiyle aynı.
 */
export default function CustomPrintsScreen() {
  const qc = useQueryClient();
  const { data: items = [], isLoading, isError, error, refetch, isFetching, data: hamListe } = useQuery({
    queryKey: ["custom-prints"],
    queryFn: getCustomPrints,
  });
  const { refreshing, onRefresh } = useManualRefresh(refetch);
  const { data: snaps = [] } = useQuery({ queryKey: ["printer-snapshots"], queryFn: getPrinterSnapshots, refetchInterval: 4000 });
  const snapById = useMemo(() => new Map(snaps.map((s) => [s.printerConfigId, s])), [snaps]);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const relayCaps = settings?.printRelayCaps ?? "";
  // Ayar okunamadıysa "Masaüstünü güncelle" DENMEZ — sorun güncelleme değil, okunamamak.
  const ayarOkundu = settings != null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  // En taze satırın yaşı — Yazıcılar ve Atölye ile ORTAK okuyucu ve eşik.
  const enTazeYas = useMemo(() => {
    let enKucuk: number | null = null;
    for (const s of snaps) {
      const yas = satirYasiMs(s.updatedAt, now);
      if (yas != null && (enKucuk == null || yas < enKucuk)) enKucuk = yas;
    }
    return enKucuk;
  }, [snaps, now]);
  const relayStale = enTazeYas == null || enTazeYas > YAZICI_BAYAT_MS;

  const [sent, setSent] = useState<{ id: string; name: string; at: number } | null>(null);
  const zamanAsimi = !!sent && now - sent.at > 90_000;
  /**
   * Zaman aşımında komut GERİ ÇEKİLİR (Yazıcılar ekranıyla aynı): bekliyorsa iptal edilir, masaüstü
   * sonra uyansa da baskıyı başlatmaz. Masaüstü çoktan almışsa sonucu beklenir.
   */
  const [geriCekme, setGeriCekme] = useState<{ id: string; sonuc: "geri" | "suruyor" } | null>(null);
  const geriCekmeSonucu = geriCekme && sent && geriCekme.id === sent.id ? geriCekme.sonuc : null;
  const bekle = !!sent && (!zamanAsimi || geriCekmeSonucu === "suruyor");
  // Yalnız gönderilen komut — birincil anahtarla (bkz. getCommandStatus).
  const { data: sentCmd = null } = useQuery({
    queryKey: ["command-status", sent?.id ?? ""],
    queryFn: () => getCommandStatus(sent!.id),
    refetchInterval: bekle ? 3000 : false,
    enabled: bekle,
  });
  const cmdSettled = sentCmd?.status === "done" || sentCmd?.status === "error";
  useEffect(() => {
    if (!zamanAsimi || !sent || cmdSettled || geriCekmeSonucu) return;
    const id = sent.id;
    void bekleyenKomutuGeriCek(id)
      .then((geri) => setGeriCekme({ id, sonuc: geri ? "geri" : "suruyor" }))
      .catch(() => setGeriCekme({ id, sonuc: "geri" }));
  }, [zamanAsimi, sent, cmdSettled, geriCekmeSonucu]);
  const cmdTimedOut = zamanAsimi && geriCekmeSonucu === "geri" && !cmdSettled;
  useEffect(() => {
    if (cmdSettled || cmdTimedOut) {
      const t = setTimeout(() => setSent(null), cmdTimedOut ? 12_000 : 6000);
      return () => clearTimeout(t);
    }
  }, [cmdSettled, cmdTimedOut]);
  const cmdBusy = !!sent && !cmdSettled && !cmdTimedOut;

  const doReprint = (it: CustomPrint) => {
    Alert.alert("Tekrar bas", `"${it.originalName}"\n${it.printerName ?? "yazıcı"} üzerinde baskı başlatılsın mı?`, [
      { text: "Vazgeç", style: "cancel" },
      {
        text: "Bas",
        onPress: async () => {
          try {
            const id = await sendPrintCommand(it.printerConfigId, "start", it.id);
            setSent({ id, name: it.originalName, at: Date.now() });
            qc.invalidateQueries({ queryKey: ["command-status", id] });
          } catch {
            Alert.alert("Hata", "Komut gönderilemedi (bağlantı sorunu).");
          }
        },
      },
    ]);
  };

  const bannerTone = sentCmd?.status === "done" ? color.good : sentCmd?.status === "error" || cmdTimedOut ? color.bad : color.accentBright;

  return (
    <Screen
      header={<SubHeader title="Özel baskılar" subtitle={items.length ? `${formatNumber(items.length)} dosya` : undefined} />}
      refreshing={refreshing}
      onRefresh={onRefresh}
    >
      {sent ? (
        <Tint strong style={[styles.banner, { borderColor: bannerTone + "66" }]}>
          <Txt v="smallStrong" style={{ color: bannerTone }}>
            {sentCmd?.status === "done"
              ? `✓ Baskı başladı: ${sent.name}`
              : sentCmd?.status === "error"
                ? `✕ ${komutHatasi(sentCmd.error)}`
                : cmdTimedOut
                  ? "⚠ Uygulanmadı — masaüstü kapalı görünüyor."
                  : "⏳ Komut gönderildi — masaüstü uyguluyor…"}
          </Txt>
        </Tint>
      ) : relayStale && items.length > 0 ? (
        <Tint strong style={[styles.banner, { borderColor: color.warn + "66" }]}>
          <Txt v="small" tone="warn">
            Masaüstü çevrimdışı görünüyor — baskı komutları masaüstü açıkken uygulanır.
          </Txt>
        </Tint>
      ) : null}

      {isLoading ? (
        <ShimmerList count={5} height={92} />
      ) : isError && !hamListe ? (
        // Okunamadı ≠ hiç özel baskı yok.
        <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="tray"
          title="Henüz özel baskı yok"
          hint="Masaüstünden “Özel Baskı” ile yüklediğin (ürüne bağlı olmayan) gcode/3mf dosyaları burada listelenir."
        />
      ) : (
        items.map((it, i) => {
          const snap = snapById.get(it.printerConfigId);
          const printerGone = !it.printerName || !it.printerEnabled;
          const isBambu = it.printerType === "bambu";
          const cloudUnsupported = ayarOkundu && !!it.isCloud && !relayCaps.includes("r2start");
          const online = !!snap?.online && !relayStale;
          const busy = snap?.status === "printing" || snap?.status === "paused";
          let reason = "";
          if (printerGone) reason = "Yazıcı yok";
          else if (isBambu) reason = "Bambu: masaüstünden";
          else if (cloudUnsupported) reason = "Masaüstünü güncelle";
          else if (relayStale) reason = "Masaüstü kapalı";
          else if (!online) reason = "Çevrimdışı";
          else if (busy) reason = "Meşgul";
          else if (cmdBusy) reason = "Komut sürüyor…";
          const canPrint = !reason;
          const meta = [fmtSize(it.sizeBytes), fmtDur(it.estPrintMin), it.gramaj ? `${Math.round(it.gramaj)}g` : "", fmtDate(it.createdAt)].filter(Boolean);

          return (
            <FadeInView key={it.id} index={i}>
              <Tint strong style={styles.row}>
                <View style={styles.fileIcon}>
                  <SymbolView name="doc.fill" tintColor={color.textDim} style={{ width: 18, height: 18 }} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Txt v="bodyStrong" numberOfLines={1}>
                    {it.originalName}
                  </Txt>
                  <View style={styles.metaRow}>
                    <View style={[styles.pDot, { backgroundColor: it.printerAccent || color.textFaint }]} />
                    <Txt v="small" tone="faint" numberOfLines={1} style={{ flex: 1 }}>
                      {it.printerName ?? "yazıcı silinmiş"} · {meta.join(" · ")}
                    </Txt>
                  </View>
                  <Pill color={it.isCloud ? color.accentBright : color.textFaint}>{it.isCloud ? "Bulut" : "Yerel"}</Pill>
                </View>
                <Button
                  label={canPrint ? "Bas" : reason}
                  icon={canPrint ? "printer.fill" : undefined}
                  size="sm"
                  variant={canPrint ? "primary" : "secondary"}
                  disabled={!canPrint}
                  onPress={() => canPrint && doReprint(it)}
                  style={{ maxWidth: 150 }}
                />
              </Tint>
            </FadeInView>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { padding: space.md, borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  fileIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: color.tint, alignItems: "center", justifyContent: "center" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pDot: { width: 7, height: 7, borderRadius: 4 },
});
