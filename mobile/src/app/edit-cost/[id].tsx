import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
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

import { getProductDetail, getVariantGroup } from "@/lib/db/product-detail";
import { getFilamentTypes, saveProductCostBatch, type CostInput } from "@/lib/db/cost-save";
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
  const { data: variantGroup } = useQuery({
    queryKey: ["variant-group", product?.variantGroupId],
    queryFn: () => getVariantGroup(product!.variantGroupId!),
    enabled: !!product?.variantGroupId,
  });

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
  const [applyAll, setApplyAll] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const baselineRef = useRef<string | null>(null);

  useEffect(() => {
    if (!product) return;
    const c = product.cost;
    // Yüklenen değerleri tek nesnede topla → baseline (mount/hydration auto-save'i TETİKLEMESİN;
    // yalnızca kullanıcı bir şey değiştirince kaydedilir). Key sırası `formKey` ile birebir aynı olmalı.
    const v = {
      mode: ((c?.costMode as "detailed" | "manual") === "manual" ? "manual" : "detailed") as "detailed" | "manual",
      filamentTypeId: c?.filamentTypeId ?? null,
      weight: c?.filamentWeight ? String(c.filamentWeight) : "",
      time: c?.printTimeHours ? String(c.printTimeHours) : "",
      waste: c?.wasteRate ? String(c.wasteRate * 100) : "",
      packagingOptionId: c?.packagingOptionId ?? null,
      nylonLevel: ((c?.nylonLevel as NylonLevel) ?? "none") as NylonLevel,
      tapeUsed: !!c?.tapeUsed,
      desi: product.desi ? String(product.desi) : "",
      manualCost: c?.manualCost != null ? String(c.manualCost) : "",
      applyAll: false,
    };
    setMode(v.mode);
    setFilamentTypeId(v.filamentTypeId);
    setWeight(v.weight);
    setTime(v.time);
    setWaste(v.waste);
    setPackagingOptionId(v.packagingOptionId);
    setNylonLevel(v.nylonLevel);
    setTapeUsed(v.tapeUsed);
    setDesi(v.desi);
    setManualCost(v.manualCost);
    setApplyAll(false);
    baselineRef.current = JSON.stringify(v);
    setStatus("idle");
  }, [product]);

  const formKey = JSON.stringify({
    mode,
    filamentTypeId,
    weight,
    time,
    waste,
    packagingOptionId,
    nylonLevel,
    tapeUsed,
    desi,
    manualCost,
    applyAll,
  });

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

  const buildInput = (): CostInput =>
    mode === "manual"
      ? {
          mode: "manual",
          manualCost: parseFloat(manualCost) || 0,
          filamentTypeId: null,
          filamentWeight: 0,
          printTimeHours: 0,
          wasteRate: 0,
          packagingOptionId: null,
          nylonLevel: "none",
          tapeUsed: false,
        }
      : {
          mode: "detailed",
          filamentTypeId,
          filamentWeight: parseFloat(weight) || 0,
          printTimeHours: parseFloat(time) || 0,
          wasteRate: (parseFloat(waste) || 0) / 100,
          packagingOptionId,
          nylonLevel,
          tapeUsed,
        };

  const save = useMutation({
    // TEK batch round-trip: maliyet + desi + varyant kopyaları (eski hali 2..(2+N) ardışık çağrıydı;
    // 700ms auto-save ile birleşince her yazma molası ~300ms-1.2sn tutuyordu).
    mutationFn: () =>
      saveProductCostBatch(
        id,
        buildInput(),
        parseFloat(desi) || null,
        // "Tüm varyantlara uygula" açıksa aynı maliyeti grubun diğer üyelerine de yaz (desi hariç → fiziksel boyut varyanta özel).
        applyAll && variantGroup ? variantGroup.members.map((m) => m.id) : []
      ),
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStatus("saved");
    },
  });

  // Otomatik kaydet — form baseline'dan farklıysa 700ms debounce ile kaydet (Kaydet butonu yok).
  useEffect(() => {
    if (!product || baselineRef.current == null || formKey === baselineRef.current) return;
    setStatus("saving");
    const t = setTimeout(() => {
      save.mutate(undefined, { onSuccess: () => { baselineRef.current = formKey; } });
    }, 700);
    return () => clearTimeout(t);
  }, [formKey, product, save.mutate]);

  // Ağır listeleri EKRANDAN ÇIKARKEN bir kez tazele (eski hali: her 700ms auto-save'de
  // 424 ürünlük dashboard-data yeniden çekiliyordu — yazma molası başına boş yere).
  useEffect(() => {
    return () => {
      qc.invalidateQueries({ queryKey: ["product"] });
      qc.invalidateQueries({ queryKey: ["dashboard-data"] });
      qc.invalidateQueries({ queryKey: ["match-products"] });
    };
  }, [qc]);

  // Çıkışta bekleyen değişikliği hemen kaydet (debounce dolmadan geri basılırsa kaybolmasın).
  const handleBack = () => {
    if (baselineRef.current != null && formKey !== baselineRef.current) {
      baselineRef.current = formKey;
      save.mutate();
    }
    router.back();
  };

  if (isLoading || !product) {
    return (
      <SafeAreaView style={styles.safe}>
        <Header onBack={handleBack} />
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header onBack={handleBack} />
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

        {variantGroup && variantGroup.members.length > 1 ? (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              setApplyAll((v) => !v);
            }}
            style={styles.applyAllRow}
          >
            <View style={[styles.checkbox, applyAll && styles.checkboxOn]}>
              {applyAll ? <Text style={styles.checkboxTick}>✓</Text> : null}
            </View>
            <Text style={styles.applyAllText}>
              Bu maliyeti tüm varyantlara uygula ({variantGroup.members.length} ürün)
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.statusRow}>
          {status === "saving" ? (
            <>
              <ActivityIndicator color={ML.textDim} size="small" />
              <Text style={styles.statusText}>Kaydediliyor…</Text>
            </>
          ) : status === "saved" ? (
            <Text style={[styles.statusText, { color: ML.green }]}>✓ Otomatik kaydedildi</Text>
          ) : (
            <Text style={styles.statusText}>Değişiklikler otomatik kaydedilir</Text>
          )}
        </View>
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

function Header({ onBack }: { onBack?: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack ?? (() => router.back())} hitSlop={12} style={styles.back}>
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
  applyAllRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 22, paddingVertical: 4 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: ML.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: ML.accent, borderColor: ML.accent },
  checkboxTick: { color: "#fff", fontSize: 15, fontWeight: "900" },
  applyAllText: { color: ML.text, fontSize: 14, fontWeight: "600", flex: 1 },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 16, height: 22 },
  statusText: { color: ML.textDim, fontSize: 13, fontWeight: "600" },
});
