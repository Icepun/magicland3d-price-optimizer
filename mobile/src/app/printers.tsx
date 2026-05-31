import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import { getDashboardData } from "@/lib/db/dashboard";
import { ML, radius } from "@/theme/colors";

// Masaüstü simülasyonun mobil karşılığı (oklch → hex). Donanım bağlanınca gerçek veriyle değişir.
interface Cfg {
  id: string;
  name: string;
  model: string;
  accent: string;
  printSec: number;
  finishedSec: number;
  idleSec: number;
  phaseSec: number;
  layerTotal: number;
  seed: number;
}
const PRINTERS: Cfg[] = [
  { id: "bambu-a1", name: "Bambu Lab A1", model: "A1 Combo", accent: "#2DD4A7", printSec: 360, finishedSec: 22, idleSec: 70, phaseSec: 18, layerTotal: 412, seed: 1 },
  { id: "neptune-pro", name: "Elegoo Neptune 4 Pro", model: "Neptune 4 Pro", accent: "#EF4444", printSec: 540, finishedSec: 22, idleSec: 70, phaseSec: 250, layerTotal: 738, seed: 2 },
  { id: "neptune-plus", name: "Elegoo Neptune 4 Plus", model: "Neptune 4 Plus", accent: "#F59E0B", printSec: 480, finishedSec: 22, idleSec: 70, phaseSec: 430, layerTotal: 905, seed: 3 },
  { id: "snapmaker-u1", name: "Snapmaker U1", model: "U1", accent: "#5B9BF5", printSec: 420, finishedSec: 22, idleSec: 70, phaseSec: 120, layerTotal: 560, seed: 4 },
];
const FILAMENTS = [
  { type: "PLA", color: "#EF4444" },
  { type: "PETG", color: "#3B82F6" },
  { type: "PLA", color: "#22C55E" },
  { type: "PLA", color: "#F59E0B" },
  { type: "PETG", color: "#A855F7" },
];
const FALLBACK = ["Mini Vazo", "Telefon Standı", "Kablo Tutucu", "Anahtarlık"];

type Status = "printing" | "finished" | "idle";
interface PrinterState {
  cfg: Cfg;
  status: Status;
  product: string;
  image: string | null;
  filament: { type: string; color: string };
  progress: number; // 0..1
  layer: number;
  remainingSec: number;
  nozzle: number;
  bed: number;
}

function fmtRemaining(sec: number): string {
  if (sec <= 0) return "0sn";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}dk ${s}sn` : `${s}sn`;
}

export default function PrintersScreen() {
  const { data: products } = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const pool = useMemo(() => {
    const withImg = (products ?? []).filter((p) => p.imageUrl).map((p) => ({ name: p.name, image: p.imageUrl }));
    if (withImg.length >= 4) return withImg;
    return [...withImg, ...FALLBACK.map((name) => ({ name, image: null as string | null }))];
  }, [products]);

  const states = useMemo<PrinterState[]>(() => {
    const nowSec = now / 1000;
    return PRINTERS.map((c) => {
      const cycle = c.printSec + c.finishedSec + c.idleSec;
      const t = nowSec - c.phaseSec;
      const cycleIndex = Math.floor(t / cycle);
      const rel = ((t % cycle) + cycle) % cycle;
      const product = pool[Math.abs(cycleIndex * 3 + c.seed) % Math.max(1, pool.length)] ?? { name: "—", image: null };
      const filament = FILAMENTS[Math.abs(cycleIndex + c.seed) % FILAMENTS.length];
      const hot = filament.type === "PETG" ? 240 : 210;
      const bedHot = filament.type === "PETG" ? 80 : 60;

      if (rel < c.printSec) {
        const progress = rel / c.printSec;
        return {
          cfg: c, status: "printing", product: product.name, image: product.image, filament,
          progress, layer: Math.floor(progress * c.layerTotal),
          remainingSec: c.printSec - rel, nozzle: hot, bed: bedHot,
        };
      }
      if (rel < c.printSec + c.finishedSec) {
        return {
          cfg: c, status: "finished", product: product.name, image: product.image, filament,
          progress: 1, layer: c.layerTotal, remainingSec: 0, nozzle: Math.round(hot * 0.5), bed: Math.round(bedHot * 0.6),
        };
      }
      return {
        cfg: c, status: "idle", product: product.name, image: product.image, filament,
        progress: 0, layer: 0, remainingSec: 0, nozzle: 25, bed: 24,
      };
    });
  }, [now, pool]);

  const printing = states.filter((s) => s.status === "printing").length;
  const ready = states.filter((s) => s.status === "idle").length;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Yazıcılar" />
      <View style={styles.chips}>
        <Chip text={`${states.length} yazıcı`} />
        <Chip text={`${printing} yazdırıyor`} color={ML.accent} />
        <Chip text={`${ready} hazır`} color={ML.green} />
        <Chip text="Demo" color={ML.orange} />
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {states.map((s) => (
          <PrinterCard key={s.cfg.id} s={s} />
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const STATUS_INFO: Record<Status, { label: string; color: string }> = {
  printing: { label: "Yazdırıyor", color: ML.accent },
  finished: { label: "Tamamlandı", color: ML.green },
  idle: { label: "Hazır", color: ML.textDim },
};

function PrinterCard({ s }: { s: PrinterState }) {
  const info = STATUS_INFO[s.status];
  return (
    <View style={[styles.card, { borderColor: s.cfg.accent + "55" }]}>
      <View style={styles.cardHead}>
        <View style={[styles.accentDot, { backgroundColor: s.cfg.accent }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.pName}>{s.cfg.name}</Text>
          <Text style={styles.pModel}>{s.cfg.model}</Text>
        </View>
        <View style={[styles.statusPill, { backgroundColor: info.color + "22" }]}>
          <Text style={[styles.statusText, { color: info.color }]}>{info.label}</Text>
        </View>
      </View>

      <View style={styles.cardBody}>
        {s.image ? (
          <Image source={{ uri: s.image }} style={styles.thumb} contentFit="cover" transition={150} />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]} />
        )}
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.product} numberOfLines={1}>
            {s.status === "idle" ? "Beklemede" : s.product}
          </Text>
          {s.status !== "idle" && (
            <Text style={styles.layer}>
              Katman {s.layer}/{s.cfg.layerTotal}
            </Text>
          )}
          <View style={styles.filRow}>
            <View style={[styles.filDot, { backgroundColor: s.filament.color }]} />
            <Text style={styles.filText}>{s.filament.type}</Text>
            <Text style={styles.temp}>🌡 {s.nozzle}° / {s.bed}°</Text>
          </View>
        </View>
      </View>

      {s.status !== "idle" && (
        <>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.round(s.progress * 100)}%`, backgroundColor: s.cfg.accent }]} />
          </View>
          <View style={styles.progRow}>
            <Text style={[styles.pct, { color: s.cfg.accent }]}>%{Math.round(s.progress * 100)}</Text>
            <Text style={styles.remaining}>
              {s.status === "finished" ? "Tamamlandı 🎉" : `~${fmtRemaining(s.remainingSec)} kaldı`}
            </Text>
          </View>
        </>
      )}
    </View>
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
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ML.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ML.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
  list: { padding: 16, gap: 12 },
  card: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  accentDot: { width: 10, height: 10, borderRadius: 5 },
  pName: { color: ML.text, fontSize: 15, fontWeight: "700" },
  pModel: { color: ML.textFaint, fontSize: 12 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  statusText: { fontSize: 12, fontWeight: "700" },
  cardBody: { flexDirection: "row", gap: 12, alignItems: "center" },
  thumb: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: ML.cardElevated },
  thumbEmpty: { borderWidth: 1, borderColor: ML.border },
  product: { color: ML.text, fontSize: 14, fontWeight: "600" },
  layer: { color: ML.textDim, fontSize: 12, fontVariant: ["tabular-nums"] },
  filRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  filDot: { width: 8, height: 8, borderRadius: 4 },
  filText: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
  temp: { color: ML.textFaint, fontSize: 12, marginLeft: 4 },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: ML.cardElevated, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  progRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pct: { fontSize: 14, fontWeight: "800" },
  remaining: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
});
