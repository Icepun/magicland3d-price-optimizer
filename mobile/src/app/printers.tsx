import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import {
  getPrinterSnapshots,
  getRecentCommands,
  sendPrintCommand,
  type PrintAction,
  type PrinterSnapshot,
} from "@/lib/db/printers";
import { thumbUrl } from "@/lib/image";
import { ML, radius } from "@/theme/colors";

function brandColor(brand: string): string {
  if (brand === "bambu") return "#2DD4A7";
  if (brand === "snapmaker") return "#5B9BF5";
  if (brand === "elegoo") return "#EF4444";
  return ML.accent;
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
  printing: { label: "Yazdırıyor", color: ML.accent },
  paused: { label: "Duraklatıldı", color: ML.orange },
  finished: { label: "Tamamlandı", color: ML.green },
  idle: { label: "Hazır", color: ML.textDim },
  error: { label: "Hata", color: "#EF4444" },
  offline: { label: "Çevrimdışı", color: ML.textFaint },
};

const ACTION_LABEL: Record<PrintAction, string> = {
  start: "Başlat",
  pause: "Duraklat",
  resume: "Devam",
  cancel: "İptal",
};

export default function PrintersScreen() {
  const qc = useQueryClient();
  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ["printer-snapshots"],
    queryFn: getPrinterSnapshots,
    refetchInterval: 4000,
  });

  // Relay tazeliğini saymak için periyodik tik — veri değişmese de "X önce" yaşı artsın
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const printing = snapshots.filter((s) => s.status === "printing").length;
  const online = snapshots.filter((s) => s.online).length;

  // Masaüstü relay'i en son ne zaman yazdı? (en taze updatedAt). Stale ise "masaüstü açık mı?"
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

  // Gönderilen kontrol komutunun (duraklat/devam/iptal) durumu — pending → done/error.
  // 90 sn içinde uygulanmazsa (masaüstü kapalı) zaman aşımı mesajına düşer + yoklama durur.
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
  // Çift gönderim kilidi: komut beklerken butonlar pasif (iki kez "İptal"/"Duraklat" gönderilmesin).
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
      Alert.alert(
        "Baskıyı iptal et",
        `${s.name} üzerindeki baskı iptal edilsin mi? Bu işlem geri alınamaz.`,
        [
          { text: "Vazgeç", style: "cancel" },
          { text: "İptal et", style: "destructive", onPress: send },
        ]
      );
    } else {
      send();
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Yazıcılar" />
      <View style={styles.chips}>
        <Chip text={`${snapshots.length} yazıcı`} />
        <Chip text={`${online} çevrimiçi`} color={ML.green} />
        <Chip text={`${printing} yazdırıyor`} color={ML.accent} />
      </View>

      <Pressable
        onPress={() => router.push("/custom-prints" as never)}
        style={({ pressed }) => [styles.archiveLink, pressed && { backgroundColor: ML.cardElevated }]}
      >
        <SymbolView name="tray.full.fill" tintColor={ML.accent} style={{ width: 17, height: 17 }} />
        <Text style={styles.archiveText}>Özel Baskılar Arşivi</Text>
        <SymbolView name="chevron.right" tintColor={ML.textFaint} style={{ width: 13, height: 13 }} />
      </Pressable>

      {snapshots.length > 0 ? (
        <View style={styles.liveBar}>
          <View style={[styles.liveDot, { backgroundColor: stale ? ML.orange : ML.green }]} />
          <Text style={[styles.liveText, stale && { color: ML.orange }]}>
            {stale
              ? `Canlı değil · ${fmtAge(ageMs)} güncellendi — masaüstü açık mı?`
              : `Canlı · ${fmtAge(ageMs)} güncellendi`}
          </Text>
        </View>
      ) : null}

      {sent ? (
        <View
          style={[
            styles.cmdBanner,
            sentCmd?.status === "done" && { borderColor: ML.green + "66" },
            sentCmd?.status === "error" && { borderColor: ML.red + "66" },
          ]}
        >
          <Text
            style={[
              styles.cmdText,
              sentCmd?.status === "done" && { color: ML.green },
              (sentCmd?.status === "error" || cmdTimedOut) && { color: ML.red },
            ]}
          >
            {sentCmd?.status === "done"
              ? `✓ ${sent.label} uygulandı`
              : sentCmd?.status === "error"
                ? `✕ ${sentCmd.error ?? "Komut başarısız"}`
                : cmdTimedOut
                  ? `⚠ ${sent.label} uygulanmadı — masaüstü kapalı görünüyor.`
                  : `⏳ ${sent.label} gönderildi — masaüstü uyguluyor…`}
          </Text>
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={ML.accent} /></View>
      ) : snapshots.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Henüz veri yok</Text>
          <Text style={styles.emptyDesc}>Masaüstü uygulaması açık ve yazıcılar ekli olmalı. Durum birkaç saniyede bir güncellenir.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {snapshots.map((s) => (
            <PrinterCard
              key={s.printerConfigId}
              s={s}
              stale={stale}
              disabled={cmdBusy}
              onCommand={(a) => runCommand(s, a)}
            />
          ))}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
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
  const accent = brandColor(s.brand);
  const info = STATUS[s.status] ?? STATUS.idle;
  const offline = !s.online || s.status === "offline";
  const pct = Math.round((s.progress || 0) * 100);
  const active = s.status === "printing" || s.status === "paused";
  const showControls = active && !stale && s.online;

  return (
    <View style={[styles.card, { borderColor: accent + "55" }]}>
      <View style={styles.cardHead}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={styles.pName}>{s.name}</Text>
        <View style={[styles.pill, { backgroundColor: info.color + "22" }]}>
          <Text style={[styles.pillText, { color: info.color }]}>{info.label}</Text>
        </View>
      </View>

      {!offline && (s.status === "printing" || s.status === "paused" || s.status === "finished") ? (
        <>
          <View style={styles.body}>
            {s.productImage ? (
              <Image source={{ uri: thumbUrl(s.productImage, 96)! }} style={styles.thumb} contentFit="cover" transition={150} recyclingKey={s.printerConfigId} />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]} />
            )}
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.product} numberOfLines={2}>{s.productName ?? s.currentFilename ?? "Baskı"}</Text>
              <Text style={styles.temp}>🌡 {s.nozzle}° / {s.bed}°</Text>
              <Text style={styles.eta}>{s.status === "finished" ? "Tamamlandı 🎉" : `~${fmtRemaining(s.etaSec)} kaldı`}</Text>
            </View>
          </View>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: accent }]} />
          </View>
          <Text style={[styles.pct, { color: accent }]}>%{pct}</Text>
        </>
      ) : (
        <View style={styles.body}>
          <View style={[styles.thumb, styles.thumbEmpty]} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.product}>{offline ? "Bağlantı yok" : "Hazır"}</Text>
            <Text style={styles.temp}>🌡 {s.nozzle}° / {s.bed}°</Text>
          </View>
        </View>
      )}

      {showControls ? (
        <View style={[styles.controls, disabled && { opacity: 0.45 }]}>
          {s.status === "printing" ? (
            <CtrlBtn label="Duraklat" icon="pause.fill" color={ML.orange} disabled={disabled} onPress={() => onCommand("pause")} />
          ) : (
            <CtrlBtn label="Devam" icon="play.fill" color={ML.green} disabled={disabled} onPress={() => onCommand("resume")} />
          )}
          <CtrlBtn label="İptal" icon="stop.fill" color={ML.red} disabled={disabled} onPress={() => onCommand("cancel")} />
        </View>
      ) : null}
    </View>
  );
}

function CtrlBtn({
  label,
  icon,
  color,
  disabled,
  onPress,
}: {
  label: string;
  icon: SymbolViewProps["name"];
  color: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.ctrlBtn,
        { borderColor: color + "55" },
        pressed && !disabled && { backgroundColor: color + "1A" },
      ]}
    >
      <SymbolView name={icon} tintColor={color} style={{ width: 13, height: 13 }} />
      <Text style={[styles.ctrlText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Chip({ text, color }: { text: string; color?: string }) {
  return (
    <View style={[styles.chip, color && { borderColor: color + "55" }]}>
      {color ? <View style={[styles.chipDot, { backgroundColor: color }]} /> : null}
      <Text style={styles.chipText}>{text}</Text>
    </View>
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
  safe: { flex: 1, backgroundColor: ML.bg },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: ML.card, borderRadius: 999, borderWidth: 1, borderColor: ML.border, paddingHorizontal: 12, paddingVertical: 6 },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
  archiveLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  archiveText: { color: ML.text, fontSize: 14, fontWeight: "700", flex: 1 },
  liveBar: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 16, paddingBottom: 10 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
  cmdBanner: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    backgroundColor: ML.card,
  },
  cmdText: { color: ML.textDim, fontSize: 12.5, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  emptyTitle: { color: ML.text, fontSize: 16, fontWeight: "700" },
  emptyDesc: { color: ML.textDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  list: { padding: 16, gap: 12 },
  card: { backgroundColor: ML.card, borderRadius: radius.lg, borderWidth: 1, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pName: { color: ML.text, fontSize: 15, fontWeight: "700", flex: 1 },
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "700" },
  body: { flexDirection: "row", gap: 12, alignItems: "center" },
  thumb: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: ML.cardElevated },
  thumbEmpty: { borderWidth: 1, borderColor: ML.border },
  product: { color: ML.text, fontSize: 14, fontWeight: "600" },
  temp: { color: ML.textFaint, fontSize: 12 },
  eta: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: ML.cardElevated, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  pct: { fontSize: 14, fontWeight: "800" },
  controls: { flexDirection: "row", gap: 8, paddingTop: 2 },
  ctrlBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 9,
  },
  ctrlText: { fontSize: 13, fontWeight: "700" },
});
