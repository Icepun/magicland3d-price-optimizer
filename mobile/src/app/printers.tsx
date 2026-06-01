import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import {
  getPrinterSnapshots, getPrintableModels, sendPrintCommand, getRecentCommands,
  type PrinterSnapshot, type PrintableModel, type RecentCommand, type PrintAction,
} from "@/lib/db/printers";
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

export default function PrintersScreen() {
  const qc = useQueryClient();
  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ["printer-snapshots"],
    queryFn: getPrinterSnapshots,
    refetchInterval: 4000,
  });
  const { data: commands = [] } = useQuery({
    queryKey: ["recent-commands"],
    queryFn: getRecentCommands,
    refetchInterval: 4000,
  });
  const [picker, setPicker] = useState<PrinterSnapshot | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Yazıcı başına son komut (geri bildirim için)
  const lastCmd = new Map<string, RecentCommand>();
  for (const c of commands) if (!lastCmd.has(c.printerConfigId)) lastCmd.set(c.printerConfigId, c);

  const runCommand = async (printerId: string, action: PrintAction, modelFileId?: string) => {
    setBusyId(printerId);
    try {
      await sendPrintCommand(printerId, action, modelFileId);
      await qc.invalidateQueries({ queryKey: ["recent-commands"] });
    } catch (e) {
      Alert.alert("Komut gönderilemedi", e instanceof Error ? e.message : "Bilinmeyen hata");
    } finally {
      setBusyId(null);
    }
  };

  const printing = snapshots.filter((s) => s.status === "printing").length;
  const online = snapshots.filter((s) => s.online).length;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Yazıcılar" />
      <View style={styles.chips}>
        <Chip text={`${snapshots.length} yazıcı`} />
        <Chip text={`${online} çevrimiçi`} color={ML.green} />
        <Chip text={`${printing} yazdırıyor`} color={ML.accent} />
      </View>

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
              busy={busyId === s.printerConfigId}
              lastCmd={lastCmd.get(s.printerConfigId)}
              onCommand={(action) => runCommand(s.printerConfigId, action)}
              onStart={() => setPicker(s)}
            />
          ))}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      <ModelPicker
        printer={picker}
        onClose={() => setPicker(null)}
        onPick={(fileId) => {
          if (picker) runCommand(picker.printerConfigId, "start", fileId);
          setPicker(null);
        }}
      />
    </SafeAreaView>
  );
}

function PrinterCard({
  s, busy, lastCmd, onCommand, onStart,
}: {
  s: PrinterSnapshot; busy: boolean; lastCmd?: RecentCommand;
  onCommand: (a: PrintAction) => void; onStart: () => void;
}) {
  const accent = brandColor(s.brand);
  const info = STATUS[s.status] ?? STATUS.idle;
  const offline = !s.online || s.status === "offline";
  const pct = Math.round((s.progress || 0) * 100);
  const isPrinting = s.status === "printing";
  const isPaused = s.status === "paused";
  const isBambu = s.brand === "bambu";
  const pending = lastCmd?.status === "pending";

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
              <Image source={{ uri: s.productImage }} style={styles.thumb} contentFit="cover" transition={150} />
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

      {pending && <Text style={styles.cmdNote}>⏳ Komut gönderildi, uygulanıyor…</Text>}
      {lastCmd?.status === "error" && <Text style={styles.cmdErr}>⚠ {lastCmd.error ?? "Komut hatası"}</Text>}

      {!offline && (
        <View style={styles.controls}>
          {isPrinting && <CtrlBtn label="Duraklat" onPress={() => onCommand("pause")} busy={busy} />}
          {isPaused && <CtrlBtn label="Devam" onPress={() => onCommand("resume")} busy={busy} accent={accent} />}
          {(isPrinting || isPaused) && <CtrlBtn label="İptal" onPress={() => onCommand("cancel")} busy={busy} danger />}
          {!isPrinting && !isPaused && !isBambu && <CtrlBtn label="Baskı Başlat" onPress={onStart} busy={busy} accent={accent} />}
          {!isPrinting && !isPaused && isBambu && <Text style={styles.bambuNote}>Bambu’da uygulamadan başlatma yakında</Text>}
        </View>
      )}
    </View>
  );
}

function CtrlBtn({ label, onPress, busy, danger, accent }: { label: string; onPress: () => void; busy: boolean; danger?: boolean; accent?: string }) {
  const color = danger ? "#EF4444" : accent ?? ML.textDim;
  return (
    <Pressable onPress={onPress} disabled={busy} style={[styles.btn, { borderColor: color + "66", opacity: busy ? 0.5 : 1 }]}>
      <Text style={[styles.btnText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function ModelPicker({ printer, onClose, onPick }: { printer: PrinterSnapshot | null; onClose: () => void; onPick: (fileId: string) => void }) {
  const { data: models = [], isLoading } = useQuery({
    queryKey: ["printable-models", printer?.printerConfigId],
    queryFn: () => getPrintableModels(printer!.printerConfigId),
    enabled: !!printer,
  });

  return (
    <Modal visible={!!printer} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>Baskı Başlat — {printer?.name}</Text>
        <Text style={styles.sheetDesc}>Bu yazıcı için eklenmiş modellerden birini seç.</Text>
        {isLoading ? (
          <ActivityIndicator color={ML.accent} style={{ marginVertical: 24 }} />
        ) : models.length === 0 ? (
          <Text style={styles.emptyDesc}>Bu yazıcı için model yok. Masaüstünden ürün sayfasına dosya ekle.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }}>
            {models.map((m: PrintableModel) => (
              <Pressable key={m.fileId} style={styles.modelRow} onPress={() => onPick(m.fileId)}>
                {m.imageUrl ? (
                  <Image source={{ uri: m.imageUrl }} style={styles.modelThumb} contentFit="cover" />
                ) : (
                  <View style={[styles.modelThumb, styles.thumbEmpty]} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.modelName} numberOfLines={1}>{m.productName}{m.label ? ` — ${m.label}` : ""}</Text>
                  <Text style={styles.modelMeta} numberOfLines={1}>{m.originalName}</Text>
                </View>
                <Text style={[styles.startTxt, { color: ML.accent }]}>Bas →</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <Pressable style={styles.closeBtn} onPress={onClose}><Text style={styles.closeTxt}>Kapat</Text></Pressable>
      </View>
    </Modal>
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: ML.card, borderRadius: 999, borderWidth: 1, borderColor: ML.border, paddingHorizontal: 12, paddingVertical: 6 },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
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
  cmdNote: { color: ML.orange, fontSize: 12, fontWeight: "600" },
  cmdErr: { color: "#EF4444", fontSize: 12, fontWeight: "600" },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4 },
  btn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  btnText: { fontSize: 13, fontWeight: "700" },
  bambuNote: { color: ML.textFaint, fontSize: 12, fontStyle: "italic" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: ML.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, gap: 6 },
  sheetTitle: { color: ML.text, fontSize: 16, fontWeight: "700" },
  sheetDesc: { color: ML.textDim, fontSize: 12, marginBottom: 6 },
  modelRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: ML.border },
  modelThumb: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: ML.cardElevated },
  modelName: { color: ML.text, fontSize: 14, fontWeight: "600" },
  modelMeta: { color: ML.textFaint, fontSize: 11 },
  startTxt: { fontSize: 13, fontWeight: "700" },
  closeBtn: { marginTop: 10, alignItems: "center", paddingVertical: 10 },
  closeTxt: { color: ML.textDim, fontSize: 14, fontWeight: "600" },
});
