import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { parseTrNumber } from "@/lib/number";
import { ML, radius } from "@/theme/colors";

const NYLON: { key: NylonLevel; label: string }[] = [
  { key: "none", label: "Yok" },
  { key: "low", label: "Az" },
  { key: "medium", label: "Orta" },
  { key: "high", label: "Çok" },
];

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface SavePayload {
  key: string;
  input: CostInput;
  desi: number | null;
  alsoProductIds: string[];
}

type SaveWaiter = (success: boolean) => void;

/** Boş maliyet alanları 0 kabul edilir; dolu fakat geçersiz alanlar null döner. */
function costNumber(value: string): number | null {
  return value.trim() ? parseTrNumber(value) : 0;
}

export default function EditCostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const navigation = useNavigation();

  const {
    data: product,
    error: productError,
    isLoading,
    isError: productFailed,
    isRefetching: productRefetching,
    refetch: refetchProduct,
  } = useQuery({
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
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const activeSaveRef = useRef<SavePayload | null>(null);
  const queuedSaveRef = useRef<SavePayload | null>(null);
  const latestPayloadRef = useRef<SavePayload | null>(null);
  const latestFormKeyRef = useRef("");
  const latestValidationErrorRef = useRef<string | null>(null);
  const waitersRef = useRef(new Map<string, SaveWaiter[]>());
  const allowNextRemoveRef = useRef(false);
  const leavingRef = useRef(false);

  const seededProductIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!product || seededProductIdRef.current === product.id) return;
    seededProductIdRef.current = product.id;
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
    setSaveError(null);
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
  });

  const packagingOptions = settings ? parsePackagingSettings(settings).options : [];
  const costPerGram = filaments.find((f) => f.id === filamentTypeId)?.costPerGram ?? 0;

  const parsedForm = useMemo(() => {
    const parsedManualCost = costNumber(manualCost);
    const parsedWeight = costNumber(weight);
    const parsedTime = costNumber(time);
    const parsedWaste = costNumber(waste);
    const parsedDesi = desi.trim() ? parseTrNumber(desi) : null;

    let error: string | null = null;
    if (desi.trim() && parsedDesi === null) error = "Desi için geçerli bir sayı girin.";
    else if (parsedDesi != null && parsedDesi < 0) error = "Desi negatif olamaz.";
    else if (mode === "manual" && parsedManualCost === null)
      error = "Maliyet için geçerli bir sayı girin.";
    else if (mode === "manual" && parsedManualCost != null && parsedManualCost < 0)
      error = "Maliyet negatif olamaz.";
    else if (mode === "detailed" && parsedWeight === null)
      error = "Ağırlık için geçerli bir sayı girin.";
    else if (mode === "detailed" && parsedWeight != null && parsedWeight < 0)
      error = "Ağırlık negatif olamaz.";
    else if (mode === "detailed" && parsedTime === null)
      error = "Süre için geçerli bir sayı girin.";
    else if (mode === "detailed" && parsedTime != null && parsedTime < 0)
      error = "Süre negatif olamaz.";
    else if (mode === "detailed" && parsedWaste === null)
      error = "Fire oranı için geçerli bir sayı girin.";
    else if (
      mode === "detailed" &&
      parsedWaste != null &&
      (parsedWaste < 0 || parsedWaste > 100)
    )
      error = "Fire oranı 0 ile 100 arasında olmalı.";

    const input: CostInput | null = error
      ? null
      : mode === "manual"
        ? {
            mode: "manual",
            manualCost: parsedManualCost ?? 0,
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
            filamentWeight: parsedWeight ?? 0,
            printTimeHours: parsedTime ?? 0,
            wasteRate: (parsedWaste ?? 0) / 100,
            packagingOptionId,
            nylonLevel,
            tapeUsed,
          };

    return {
      input,
      desi: parsedDesi,
      error,
      previewManualCost: Math.max(0, parsedManualCost ?? 0),
      previewWeight: Math.max(0, parsedWeight ?? 0),
      previewTime: Math.max(0, parsedTime ?? 0),
      previewWaste: Math.min(100, Math.max(0, parsedWaste ?? 0)),
    };
  }, [
    desi,
    filamentTypeId,
    manualCost,
    mode,
    nylonLevel,
    packagingOptionId,
    tapeUsed,
    time,
    waste,
    weight,
  ]);

  const alsoProductIds = useMemo(
    () => (applyAll && variantGroup ? variantGroup.members.map((member) => member.id) : []),
    [applyAll, variantGroup],
  );

  const currentPayload = useMemo<SavePayload | null>(
    () =>
      parsedForm.input
        ? {
            key: formKey,
            input: parsedForm.input,
            desi: parsedForm.desi,
            alsoProductIds,
          }
        : null,
    [alsoProductIds, formKey, parsedForm],
  );

  // Canlı önizleme — @core resolveProductCost ile (kaydetmeden)
  const preview = settings
    ? resolveProductCost(
        mode === "manual"
          ? {
              costMode: "manual",
              manualCost: parsedForm.previewManualCost,
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
              filamentWeight: parsedForm.previewWeight,
              printTimeHours: parsedForm.previewTime,
              wasteRate: parsedForm.previewWaste / 100,
              packagingOptionId,
              nylonLevel,
              tapeUsed,
            },
        settings,
        costPerGram
      )
    : null;

  const resolveWaiters = useCallback((key: string, success: boolean) => {
    const waiters = waitersRef.current.get(key) ?? [];
    waitersRef.current.delete(key);
    for (const resolve of waiters) resolve(success);
  }, []);

  const drainSaveQueue = useCallback(async () => {
    if (activeSaveRef.current) return;

    while (queuedSaveRef.current) {
      const payload = queuedSaveRef.current;
      queuedSaveRef.current = null;
      activeSaveRef.current = payload;
      if (mountedRef.current) {
        setStatus("saving");
        setSaveError(null);
      }

      try {
        // Tek batch round-trip: maliyet + desi + seçildiyse varyant kopyaları.
        await saveProductCostBatch(
          id,
          payload.input,
          payload.desi,
          payload.alsoProductIds,
        );
        baselineRef.current = payload.key;
        resolveWaiters(payload.key, true);
        if (
          mountedRef.current &&
          !queuedSaveRef.current &&
          latestFormKeyRef.current === payload.key
        ) {
          setStatus("saved");
          setSaveError(null);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Maliyet kaydedilemedi.";
        resolveWaiters(payload.key, false);
        if (mountedRef.current) {
          setStatus("error");
          setSaveError(message);
        }
      } finally {
        activeSaveRef.current = null;
      }
    }
  }, [id, resolveWaiters]);

  const enqueueSave = useCallback(
    (payload: SavePayload) => {
      const active = activeSaveRef.current;
      const queued = queuedSaveRef.current;
      if (baselineRef.current === payload.key && !active && !queued) {
        resolveWaiters(payload.key, true);
        return;
      }
      if (active?.key === payload.key && !queued) return;
      if (queued && queued.key !== payload.key) resolveWaiters(queued.key, false);
      queuedSaveRef.current = payload;
      if (mountedRef.current) {
        setStatus("saving");
        setSaveError(null);
      }
      void drainSaveQueue();
    },
    [drainSaveQueue, resolveWaiters],
  );

  const saveAndWait = useCallback(
    (payload: SavePayload) => {
      const active = activeSaveRef.current;
      const queued = queuedSaveRef.current;
      if (baselineRef.current === payload.key && !active && !queued) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const waiters = waitersRef.current.get(payload.key) ?? [];
        waiters.push(resolve);
        waitersRef.current.set(payload.key, waiters);
        enqueueSave(payload);
      });
    },
    [enqueueSave],
  );

  useEffect(() => {
    latestFormKeyRef.current = formKey;
    latestPayloadRef.current = currentPayload;
    latestValidationErrorRef.current = parsedForm.error;
  }, [currentPayload, formKey, parsedForm.error]);

  // Otomatik kaydet — form baseline'dan farklıysa 700ms debounce ile kaydet (Kaydet butonu yok).
  useEffect(() => {
    if (!product || baselineRef.current == null) return;
    const activeKey = activeSaveRef.current?.key;
    const queuedKey = queuedSaveRef.current?.key;
    const formIsSettled = formKey === baselineRef.current && !activeKey && !queuedKey;
    const statusTimer = setTimeout(() => {
      if (!mountedRef.current) return;
      setSaveError(null);
      setStatus(formIsSettled ? "idle" : parsedForm.error ? "error" : "saving");
    }, 0);
    if (formIsSettled || parsedForm.error) return () => clearTimeout(statusTimer);

    const saveTimer = setTimeout(() => {
      const payload = latestPayloadRef.current;
      if (payload && payload.key === formKey) enqueueSave(payload);
    }, 700);
    return () => {
      clearTimeout(statusTimer);
      clearTimeout(saveTimer);
    };
  }, [enqueueSave, formKey, parsedForm.error, product]);

  // Header, Android geri tuşu ve iOS geri hareketi: son geçerli yazma bitmeden ekrandan çıkma.
  useEffect(() => {
    return navigation.addListener("beforeRemove", (event) => {
      if (allowNextRemoveRef.current) {
        allowNextRemoveRef.current = false;
        return;
      }

      // Yükleme/hata ekranındaki boş form gerçek ürün verisi değildir. Baseline aynı ürün için
      // kurulmadan geri çıkışı engellemek varsayılan sıfırları maliyet olarak yazabilirdi.
      if (seededProductIdRef.current !== id || baselineRef.current == null) return;

      const formIsSettled =
        baselineRef.current === latestFormKeyRef.current &&
        !activeSaveRef.current &&
        !queuedSaveRef.current;
      if (formIsSettled) return;

      event.preventDefault();
      if (leavingRef.current) return;

      const payload = latestPayloadRef.current;
      if (!payload) {
        Alert.alert(
          "Değişiklik kaydedilemedi",
          latestValidationErrorRef.current ?? "Lütfen geçersiz alanları düzeltin.",
        );
        return;
      }

      leavingRef.current = true;
      void saveAndWait(payload).then((success) => {
        if (!success) {
          leavingRef.current = false;
          Alert.alert("Değişiklik kaydedilemedi", "Bağlantıyı kontrol edip tekrar deneyin.");
          return;
        }
        allowNextRemoveRef.current = true;
        navigation.dispatch(event.data.action);
      });
    });
  }, [id, navigation, saveAndWait]);

  // Ağır listeleri EKRANDAN ÇIKARKEN bir kez tazele (eski hali: her 700ms auto-save'de
  // 424 ürünlük dashboard-data yeniden çekiliyordu — yazma molası başına boş yere).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const payload = latestPayloadRef.current;
      if (
        seededProductIdRef.current === id &&
        baselineRef.current != null &&
        payload &&
        (baselineRef.current !== payload.key || activeSaveRef.current || queuedSaveRef.current)
      ) {
        enqueueSave(payload);
      }
      void qc.invalidateQueries({ queryKey: ["product"] });
      void qc.invalidateQueries({ queryKey: ["dashboard-data"] });
      void qc.invalidateQueries({ queryKey: ["match-products"] });
    };
  }, [enqueueSave, id, qc]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <Header />
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (productFailed || !product) {
    return (
      <SafeAreaView style={styles.safe}>
        <Header />
        <View style={[styles.center, styles.errorBox]}>
          <Text style={styles.errorText}>
            {productError instanceof Error ? productError.message : "Ürün yüklenemedi."}
          </Text>
          <Pressable
            onPress={() => void refetchProduct()}
            disabled={productRefetching}
            style={styles.retryButton}
          >
            <Text style={styles.retryButtonText}>
              {productRefetching ? "Yenileniyor…" : "Tekrar dene"}
            </Text>
          </Pressable>
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
          ) : status === "error" ? (
            <>
              <Text style={styles.statusError}>
                ⚠ {saveError ?? parsedForm.error ?? "Kaydetme başarısız."}
              </Text>
              {saveError && currentPayload ? (
                <Pressable onPress={() => enqueueSave(currentPayload)} hitSlop={8}>
                  <Text style={styles.statusRetry}>Tekrar dene</Text>
                </Pressable>
              ) : null}
            </>
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
  errorBox: { padding: 24, gap: 14 },
  errorText: { color: ML.textDim, fontSize: 14, textAlign: "center" },
  retryButton: {
    backgroundColor: ML.accent,
    borderRadius: radius.md,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryButtonText: { color: "#fff", fontSize: 14, fontWeight: "700" },
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
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    minHeight: 22,
  },
  statusText: { color: ML.textDim, fontSize: 13, fontWeight: "600" },
  statusError: { color: ML.red, fontSize: 13, fontWeight: "600", textAlign: "center" },
  statusRetry: { color: ML.accent, fontSize: 13, fontWeight: "800" },
});
