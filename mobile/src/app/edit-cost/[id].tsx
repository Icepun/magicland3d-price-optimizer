import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { resolveProductCost } from "@core/product-cost";
import { parsePackagingSettings, type NylonLevel } from "@core/packaging";

import { getProductDetail } from "@/lib/db/product-detail";
import { getFilamentTypes, saveProductCost, setProductDesi } from "@/lib/db/cost-save";
import { getSettingsMap } from "@/lib/db/rules";
import { formatCurrency } from "@/lib/format";
import { ML, radius } from "@/theme/colors";

const NYLON: { key: NylonLevel; label: string }[] = [
  { key: "none", label: "Yok" },
  { key: "low", label: "Az" },
  { key: "medium", label: "Orta" },
  { key: "high", label: "Çok" },
];

export default function EditCostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();

  const { data: product, isLoading } = useQuery({
    queryKey: ["product", id],
    queryFn: () => getProductDetail(id),
  });
  const { data: filaments = [] } = useQuery({ queryKey: ["filaments"], queryFn: getFilamentTypes });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const [filamentTypeId, setFilamentTypeId] = useState<string | null>(null);
  const [weight, setWeight] = useState("");
  const [time, setTime] = useState("");
  const [waste, setWaste] = useState("");
  const [packagingOptionId, setPackagingOptionId] = useState<string | null>(null);
  const [nylonLevel, setNylonLevel] = useState<NylonLevel>("none");
  const [tapeUsed, setTapeUsed] = useState(false);
  const [desi, setDesi] = useState("");
  const [mode, setMode] = useState<"detailed" | "manual">("detailed");
  const [manualCost, setManualCost] = useState("");

  useEffect(() => {
    if (!product) return;
    const c = product.cost;
    setFilamentTypeId(c?.filamentTypeId ?? null);
    setWeight(c?.filamentWeight ? String(c.filamentWeight) : "");
    setTime(c?.printTimeHours ? String(c.printTimeHours) : "");
    setWaste(c?.wasteRate ? String(c.wasteRate * 100) : "");
    setPackagingOptionId(c?.packagingOptionId ?? null);
    setNylonLevel((c?.nylonLevel as NylonLevel) ?? "none");
    setTapeUsed(!!c?.tapeUsed);
    setDesi(product.desi ? String(product.desi) : "");
    setMode((c?.costMode as "detailed" | "manual") === "manual" ? "manual" : "detailed");
    setManualCost(c?.manualCost != null ? String(c.manualCost) : "");
  }, [product]);

  const packagingOptions = settings ? parsePackagingSettings(settings).options : [];
  const costPerGram = filaments.find((f) => f.id === filamentTypeId)?.costPerGram ?? 0;

  // Canlı önizleme — @core resolveProductCost ile (kaydetmeden)
  const preview = settings
    ? resolveProductCost(
        mode === "manual"
          ? {
              costMode: "manual",
              manualCost: parseFloat(manualCost) || 0,
              totalCost: null,
              filamentWeight: 0,
              printTimeHours: 0,
              wasteRate: 0,
              packagingOptionId: null,
              nylonLevel: "none",
              tapeUsed: false,
            }
          : {
              costMode: "detailed",
              manualCost: null,
              totalCost: null,
              filamentWeight: parseFloat(weight) || 0,
              printTimeHours: parseFloat(time) || 0,
              wasteRate: (parseFloat(waste) || 0) / 100,
              packagingOptionId,
              nylonLevel,
              tapeUsed,
            },
        settings,
        costPerGram
      )
    : null;

  const save = useMutation({
    mutationFn: async () => {
      if (mode === "manual") {
        await saveProductCost(id, {
          mode: "manual",
          manualCost: parseFloat(manualCost) || 0,
          filamentTypeId: null,
          filamentWeight: 0,
          printTimeHours: 0,
          wasteRate: 0,
          packagingOptionId: null,
          nylonLevel: "none",
          tapeUsed: false,
        });
      } else {
        await saveProductCost(id, {
          mode: "detailed",
          filamentTypeId,
          filamentWeight: parseFloat(weight) || 0,
          printTimeHours: parseFloat(time) || 0,
          wasteRate: (parseFloat(waste) || 0) / 100,
          packagingOptionId,
          nylonLevel,
          tapeUsed,
        });
      }
      await setProductDesi(id, parseFloat(desi) || null);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ["product", id] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard-data"] });
      router.back();
    },
  });

  if (isLoading || !product) {
    return (
      <SafeAreaView style={styles.safe}>
        <Header />
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.productName} numberOfLines={1}>
          {product.name}
        </Text>

        <Segmented
          items={[
            { key: "detailed", label: "Detaylı" },
            { key: "manual", label: "Manuel" },
          ]}
          selected={mode}
          onSelect={(k) => setMode(k as "detailed" | "manual")}
        />

        {/* Canlı önizleme */}
        <View style={styles.preview}>
          <View>
            <Text style={styles.previewLabel}>TOPLAM MALİYET</Text>
            <Text style={styles.previewValue}>{formatCurrency(preview?.totalCost ?? 0)}</Text>
          </View>
          <View style={{ alignItems: "flex-end", gap: 2 }}>
            <Text style={styles.previewSub}>Üretim {formatCurrency(preview?.productionCost ?? 0)}</Text>
            <Text style={styles.previewSub}>Paketleme {formatCurrency(preview?.packagingCost ?? 0)}</Text>
          </View>
        </View>

        {mode === "manual" && (
          <View style={styles.fieldRow}>
            <NumberField label="Maliyet (₺)" value={manualCost} onChange={setManualCost} />
            <NumberField label="Desi" value={desi} onChange={setDesi} />
          </View>
        )}

        {mode === "detailed" && (
          <>
        {/* Filament */}
        <Label text="FİLAMENT" />
        <ChipRow
          items={filaments.map((f) => ({ key: f.id, label: `${f.name} (₺${f.costPerGram}/g)` }))}
          selected={filamentTypeId}
          onSelect={setFilamentTypeId}
        />

        {/* 3D baskı sayısal */}
        <View style={styles.fieldRow}>
          <NumberField label="Ağırlık (g)" value={weight} onChange={setWeight} />
          <NumberField label="Süre (saat)" value={time} onChange={setTime} />
        </View>
        <View style={styles.fieldRow}>
          <NumberField label="Fire (%)" value={waste} onChange={setWaste} />
          <NumberField label="Desi" value={desi} onChange={setDesi} />
        </View>

        {/* Paketleme */}
        <Label text="POŞET / KOLİ" />
        <ChipRow
          items={packagingOptions.map((o) => ({
            key: o.id,
            label: `${o.name} (₺${o.price})`,
          }))}
          selected={packagingOptionId}
          onSelect={setPackagingOptionId}
        />

        <Label text="NAYLON" />
        <Segmented
          items={NYLON}
          selected={nylonLevel}
          onSelect={(k) => setNylonLevel(k as NylonLevel)}
        />

        <Label text="BANT" />
        <Segmented
          items={[
            { key: "no", label: "Yok" },
            { key: "yes", label: "Var" },
          ]}
          selected={tapeUsed ? "yes" : "no"}
          onSelect={(k) => setTapeUsed(k === "yes")}
        />
          </>
        )}

        <Pressable
          onPress={() => save.mutate()}
          disabled={save.isPending}
          style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}
        >
          {save.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveText}>Kaydet</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function ChipRow({
  items,
  selected,
  onSelect,
}: {
  items: { key: string; label: string }[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      {items.map((it) => {
        const on = it.key === selected;
        return (
          <Pressable
            key={it.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(it.key);
            }}
            style={[styles.chip, on && styles.chipOn]}
          >
            <Text style={[styles.chipText, on && { color: "#fff", fontWeight: "700" }]}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Segmented({
  items,
  selected,
  onSelect,
}: {
  items: { key: string; label: string }[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={styles.segmented}>
      {items.map((it) => {
        const on = it.key === selected;
        return (
          <Pressable
            key={it.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(it.key);
            }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && { color: "#fff", fontWeight: "700" }]}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={ML.textFaint}
        style={styles.field}
      />
    </View>
  );
}

function Label({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

function Header() {
  return (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Maliyet Düzenle</Text>
      <View style={{ width: 32 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, height: 48 },
  back: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  backText: { color: ML.text, fontSize: 34, marginTop: -4 },
  headerTitle: { flex: 1, color: ML.text, fontSize: 17, fontWeight: "700", textAlign: "center" },
  content: { padding: 16, gap: 8, paddingBottom: 60 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  productName: { color: ML.textDim, fontSize: 15, marginBottom: 4 },
  preview: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ML.accentSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.accent,
    padding: 16,
    marginBottom: 8,
  },
  previewLabel: { color: ML.accent, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  previewValue: { color: ML.text, fontSize: 30, fontWeight: "800", marginTop: 2 },
  previewSub: { color: ML.textDim, fontSize: 13 },
  label: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginTop: 14,
    marginBottom: 2,
  },
  chipRow: { gap: 8, paddingVertical: 2, paddingRight: 16 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: ML.card,
    borderWidth: 1,
    borderColor: ML.border,
  },
  chipOn: { backgroundColor: ML.accent, borderColor: ML.accent },
  chipText: { color: ML.textDim, fontSize: 14 },
  fieldRow: { flexDirection: "row", gap: 12, marginTop: 6 },
  fieldLabel: { color: ML.textFaint, fontSize: 12, marginBottom: 6 },
  field: {
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    color: ML.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    fontWeight: "600",
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 4,
    gap: 4,
  },
  segment: { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: "center" },
  segmentOn: { backgroundColor: ML.accent },
  segmentText: { color: ML.textDim, fontSize: 15 },
  saveBtn: {
    backgroundColor: ML.accent,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 24,
  },
  saveText: { color: "#fff", fontSize: 17, fontWeight: "800" },
});
