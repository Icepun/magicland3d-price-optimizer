import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import {
  Button,
  Count,
  EmptyState,
  FadeInView,
  Glass,
  IconButton,
  Progress,
  Screen,
  ShimmerList,
  SubHeader,
  Tint,
  Txt,
} from "@/components/kit";
import {
  getPrinterSnapshots,
  getRecentCommands,
  sendPrintCommand,
  type PrintAction,
  type PrinterSnapshot,
} from "@/lib/db/printers";
import { thumbUrl } from "@/lib/image";
import { color, radius, space } from "@/theme/tokens";

function brandColor(brand: string): string {
  if (brand === "bambu") return "#2DD4A7";
  if (brand === "snapmaker") return "#5B9BF5";
  if (brand === "elegoo") return "#EF4444";
  return color.accentBright;
}

function fmtRemaining(sec: number | null): string {
  if (sec == null || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}sa ${m}dk`;
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}dk ${s}sn` : `${s}sn`;
}

const STATUS: Record<string, { label: string; color: string }> = {
  printing: { label: "Yazdırıyor", color: color.accentBright },
  paused: { label: "Duraklatıldı", color: color.warn },
  finished: { label: "Tamamlandı", color: color.good },
  idle: { label: "Hazır", color: color.textDim },
  error: { label: "Hata", color: color.bad },
  offline: { label: "Çevrimdışı", color: color.textFaint },
};

const ACTION_LABEL: Record<PrintAction, string> = {
  start: "Başlat",
  pause: "Duraklat",
  resume: "Devam",
  cancel: "İptal",
};

/**
 * YAZICILAR — masaüstü aktarıcısının 4 sn'de bir yazdığı anlık durum + duraklat/devam/iptal.
 * Komut mantığı (iptal onayı, çift gönderim kilidi, 90 sn zaman aşımı) öncekiyle AYNI.
 */
export default function PrintersScreen() {
  const qc = useQueryClient();
  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ["printer-snapshots"],
    queryFn: getPrinterSnapshots,
    refetchInterval: 4000,
  });

  // Relay tazeliğini saymak için periyodik tik — veri değişmese de "X önce" yaşı artsın.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const printing = snapshots.filter((s) => s.status === "printing").length;
  const online = snapshots.filter((s) => s.online).length;

  const lastUpdate = useMemo(() => {
    let max = 0;
    for (const s of snapshots) {
      const t = Date.parse(s.updatedAt);
      if (!Number.isNaN(t) && t > max) max = t;
    }
    return max;
  }, [snapshots]);
  const ageMs = lastUpdate > 0 ? Math.max(0, now - lastUpdate) : 0;
  const stale = lastUpdate > 0 && ageMs > 90_000;

  const [sent, setSent] = useState<{ id: string; label: string; at: number } | null>(null);
  const cmdTimedOut = !!sent && now - sent.at > 90_000;
  const { data: cmds = [] } = useQuery({
    queryKey: ["recent-commands"],
    queryFn: getRecentCommands,
    refetchInterval: sent && !cmdTimedOut ? 3000 : false,
    enabled: !!sent && !cmdTimedOut,
  });
  const sentCmd = sent ? cmds.find((c) => c.id === sent.id) : null;
  const cmdSettled = sentCmd?.status === "done" || sentCmd?.status === "error";
  useEffect(() => {
    if (cmdSettled || cmdTimedOut) {
      const t = setTimeout(() => setSent(null), cmdTimedOut ? 12_000 : 6000);
      return () => clearTimeout(t);
    }
  }, [cmdSettled, cmdTimedOut]);
  // Çift gönderim kilidi: komut beklerken düğmeler pasif.
  const cmdBusy = !!sent && !cmdSettled && !cmdTimedOut;

  const runCommand = (s: PrinterSnapshot, action: PrintAction) => {
    if (cmdBusy) return;
    const send = async () => {
      try {
        const id = await sendPrintCommand(s.printerConfigId, action);
        setSent({ id, label: `${s.name}: ${ACTION_LABEL[action]}`, at: Date.now() });
        qc.invalidateQueries({ queryKey: ["recent-commands"] });
      } catch {
        Alert.alert("Hata", "Komut gönderilemedi (bağlantı sorunu).");
      }
    };
    if (action === "cancel") {
      Alert.alert("Baskıyı iptal et", `${s.name} üzerindeki baskı iptal edilsin mi? Bu işlem geri alınamaz.`, [
        { text: "Vazgeç", style: "cancel" },
        { text: "İptal et", style: "destructive", onPress: send },
      ]);
    } else {
      send();
    }
  };

  const bannerTone = sentCmd?.status === "done" ? color.good : sentCmd?.status === "error" || cmdTimedOut ? color.bad : color.accentBright;

  return (
    <Screen
      header={
        <SubHeader
          title="Yazıcılar"
          subtitle={snapshots.length > 0 ? `${online} çevrimiçi · ${printing} yazdırıyor` : undefined}
          right={
            <IconButton icon="tray.full.fill" onPress={() => router.push("/custom-prints" as never)} accessibilityLabel="Özel baskılar arşivi" />
          }
        />
      }
    >
      {snapshots.length > 0 ? (
        <View style={styles.liveBar}>
          <View style={[styles.liveDot, { backgroundColor: stale ? color.warn : color.good }]} />
          <Txt v="small" tone={stale ? "warn" : "dim"} numberOfLines={1}>
            {stale ? `Canlı değil · ${fmtAge(ageMs)} güncellendi — masaüstü açık mı?` : `Canlı · ${fmtAge(ageMs)} güncellendi`}
          </Txt>
        </View>
      ) : null}

      {sent ? (
        <Tint strong style={[styles.banner, { borderColor: bannerTone + "66" }]}>
          <Txt v="smallStrong" style={{ color: bannerTone }}>
            {sentCmd?.status === "done"
              ? `✓ ${sent.label} uygulandı`
              : sentCmd?.status === "error"
                ? `✕ ${sentCmd.error ?? "Komut başarısız"}`
                : cmdTimedOut
                  ? `⚠ ${sent.label} uygulanmadı — masaüstü kapalı görünüyor.`
                  : `⏳ ${sent.label} gönderildi — masaüstü uyguluyor…`}
          </Txt>
        </Tint>
      ) : null}

      {isLoading ? (
        <ShimmerList count={3} height={150} />
      ) : snapshots.length === 0 ? (
        <EmptyState
          icon="printer"
          title="Henüz veri yok"
          hint="Masaüstü uygulaması açık ve yazıcılar ekli olmalı. Durum birkaç saniyede bir güncellenir."
        />
      ) : (
        snapshots.map((s, i) => (
          <FadeInView key={s.printerConfigId} index={i}>
            <PrinterCard s={s} stale={stale} disabled={cmdBusy} onCommand={(a) => runCommand(s, a)} />
          </FadeInView>
        ))
      )}
    </Screen>
  );
}

function PrinterCard({
  s,
  stale,
  disabled,
  onCommand,
}: {
  s: PrinterSnapshot;
  stale: boolean;
  disabled: boolean;
  onCommand: (a: PrintAction) => void;
}) {
  const marka = brandColor(s.brand);
  const info = STATUS[s.status] ?? STATUS.idle;
  const offline = !s.online || s.status === "offline";
  const oran = Math.max(0, Math.min(1, s.progress || 0));
  const active = s.status === "printing" || s.status === "paused";
  const showControls = active && !stale && s.online;
  const busy = !offline && (s.status === "printing" || s.status === "paused" || s.status === "finished");

  return (
    <Glass style={styles.card}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: marka }]} />
        <Txt v="heading" numberOfLines={1} style={{ flex: 1 }}>
          {s.name}
        </Txt>
        <Pill color={info.color}>{info.label}</Pill>
      </View>

      {/* Hata/duraklama NEDENİ — atölyede telefona bakmanın asıl sebebi "neden durdu". */}
      {s.statusMessage && (s.status === "error" || s.status === "paused") ? (
        <Txt v="small" style={{ color: info.color }} numberOfLines={2}>
          {s.statusMessage}
        </Txt>
      ) : null}

      <View style={styles.body}>
        {busy && s.productImage ? (
          <Image
            source={{ uri: thumbUrl(s.productImage, 96)! }}
            alt={s.productName ?? s.currentFilename ?? "Baskı"}
            style={styles.thumb}
            contentFit="cover"
            transition={150}
            recyclingKey={s.printerConfigId}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <SymbolView name={offline ? "wifi.slash" : "printer"} tintColor={color.textFaint} style={{ width: 22, height: 22 }} />
          </View>
        )}
        <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
          <Txt v="bodyStrong" numberOfLines={2}>
            {busy ? (s.productName ?? s.currentFilename ?? "Baskı") : offline ? "Bağlantı yok" : "Hazır"}
          </Txt>
          <View style={styles.rowGap}>
            <SymbolView name="thermometer.medium" tintColor={color.textFaint} style={{ width: 12, height: 14 }} />
            <Count value={s.nozzle} v="small" tone="faint" format={(n) => `${Math.round(n)}°`} />
            <Txt v="small" tone="faint">
              /
            </Txt>
            <Count value={s.bed} v="small" tone="faint" format={(n) => `${Math.round(n)}°`} />
          </View>
          {busy ? (
            <Txt v="smallStrong" tone="dim" num>
              {s.status === "finished" ? "Tamamlandı 🎉" : `~${fmtRemaining(s.etaSec)} kaldı`}
            </Txt>
          ) : null}
        </View>
        {busy ? <Count value={oran * 100} v="title" style={{ color: marka }} format={(n) => `%${Math.round(n)}`} /> : null}
      </View>

      {busy ? <Progress value={oran} color={marka} height={8} /> : null}

      {showControls ? (
        <View style={[styles.controls, disabled ? { opacity: 0.45 } : null]}>
          {s.status === "printing" ? (
            <Button label="Duraklat" icon="pause.fill" variant="secondary" size="sm" disabled={disabled} onPress={() => onCommand("pause")} style={{ flex: 1 }} />
          ) : (
            <Button label="Devam" icon="play.fill" size="sm" disabled={disabled} onPress={() => onCommand("resume")} style={{ flex: 1 }} />
          )}
          <Button label="İptal" icon="stop.fill" variant="danger" size="sm" disabled={disabled} onPress={() => onCommand("cancel")} style={{ flex: 1 }} />
        </View>
      ) : null}
    </Glass>
  );
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 10) return "az önce";
  if (s < 60) return `${s} sn önce`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk önce`;
  return `${Math.floor(m / 60)} sa önce`;
}

const styles = StyleSheet.create({
  liveBar: { flexDirection: "row", alignItems: "center", gap: 7 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  banner: { padding: space.md, borderWidth: 1 },
  card: { gap: space.md },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  body: { flexDirection: "row", gap: space.md, alignItems: "center" },
  rowGap: { flexDirection: "row", alignItems: "center", gap: 4 },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: color.tintStrong },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  controls: { flexDirection: "row", gap: space.sm },
});
