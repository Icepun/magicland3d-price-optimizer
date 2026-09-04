import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";

import { resolveProductCost } from "@core/product-cost";
import { parsePackagingSettings, type NylonLevel } from "@core/packaging";

import { Chip } from "@/components/kit/Chip";
import { Button, ErrorState, Glass, Input, Money, Screen, Segmented, Shimmer, SubHeader, Tint, Txt } from "@/components/kit";
import { getProductDetail, getVariantGroup } from "@/lib/db/product-detail";
import { getFilamentTypes, saveProductCostBatch, type CostInput } from "@/lib/db/cost-save";
import { getSettingsMap } from "@/lib/db/rules";
import { parseTrNumber } from "@/lib/number";
import { color, radius, space } from "@/theme/tokens";

/** Formdaki rakamlar her tuşta değişir: kısa akış. */
const FORM_TWEEN = 340;

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
      <Screen header={<SubHeader title="Maliyet düzenle" />}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View key={i} style={{ gap: space.sm }}>
            <Shimmer width="35%" height={11} delay={i * 70} />
            <Shimmer width="100%" height={46} radius={radius.md} delay={i * 70 + 60} />
          </View>
        ))}
      </Screen>
    );
  }

  if (productFailed || !product) {
    return (
      <Screen header={<SubHeader title="Maliyet düzenle" />}>
        <ErrorState
          title="Ürün yüklenemedi"
          error={productError ?? new Error("Ürün bulunamadı.")}
          onRetry={() => void refetchProduct()}
          retrying={productRefetching}
        />
      </Screen>
    );
  }

  return (
    <Screen header={<SubHeader title="Maliyet düzenle" subtitle={product.name} />}>
      <Segmented
        options={[
          { value: "detailed", label: "Detaylı hesap" },
          { value: "manual", label: "Elle gir" },
        ]}
        value={mode}
        onChange={(k) => setMode(k)}
      />

      {/* Canlı önizleme — @core resolveProductCost, kaydetmeden */}
      <Glass style={styles.preview}>
        <View style={{ flex: 1 }}>
          <Txt v="label" tone="accent" style={styles.kicker}>
            TOPLAM MALİYET
          </Txt>
          <Money value={preview?.totalCost ?? 0} v="hero" durationMs={FORM_TWEEN} />
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Txt v="label" tone="faint">
            ÜRETİM
          </Txt>
          <Money value={preview?.productionCost ?? 0} v="bodyStrong" durationMs={FORM_TWEEN} />
          <Txt v="label" tone="faint" style={{ marginTop: space.xs }}>
            PAKETLEME
          </Txt>
          <Money value={preview?.packagingCost ?? 0} v="bodyStrong" durationMs={FORM_TWEEN} />
        </View>
      </Glass>

      {mode === "manual" ? (
        <Tint strong style={styles.card}>
          <View style={styles.twoCol}>
            <NumberField label="Maliyet" suffix="₺" value={manualCost} onChange={setManualCost} />
            <NumberField label="Desi" value={desi} onChange={setDesi} />
          </View>
        </Tint>
      ) : null}

      {mode === "detailed" ? (
        <>
          <Tint strong style={styles.card}>
            <Etiket>FİLAMENT</Etiket>
            <ChipRow
              items={filaments.map((f) => ({ key: f.id, label: `${f.name} · ₺${f.costPerGram}/g` }))}
              selected={filamentTypeId}
              onSelect={setFilamentTypeId}
            />
            <View style={styles.twoCol}>
              <NumberField label="Ağırlık" suffix="g" value={weight} onChange={setWeight} />
              <NumberField label="Süre" suffix="saat" value={time} onChange={setTime} />
            </View>
            <View style={styles.twoCol}>
              <NumberField label="Fire" suffix="%" value={waste} onChange={setWaste} />
              <NumberField label="Desi" value={desi} onChange={setDesi} />
            </View>
          </Tint>

          <Tint strong style={styles.card}>
            <Etiket>POŞET / KOLİ</Etiket>
            <ChipRow
              items={packagingOptions.map((o) => ({ key: o.id, label: `${o.name} · ₺${o.price}` }))}
              selected={packagingOptionId}
              onSelect={setPackagingOptionId}
            />
            <Etiket>NAYLON</Etiket>
            <Segmented
              options={NYLON.map((n) => ({ value: n.key, label: n.label }))}
              value={nylonLevel}
              onChange={(k) => setNylonLevel(k)}
            />
            <Etiket>BANT</Etiket>
            <Segmented
              options={[
                { value: "no", label: "Yok" },
                { value: "yes", label: "Var" },
              ]}
              value={tapeUsed ? "yes" : "no"}
              onChange={(k) => setTapeUsed(k === "yes")}
            />
          </Tint>
        </>
      ) : null}

      {variantGroup && variantGroup.members.length > 1 ? (
        <Tint
          strong
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            setApplyAll((v) => !v);
          }}
          style={styles.applyAll}
          accessibilityLabel="Bu maliyeti tüm varyantlara uygula"
        >
          <View style={[styles.checkbox, applyAll ? styles.checkboxOn : null]}>
            {applyAll ? <SymbolView name="checkmark" weight="bold" tintColor={color.onAccent} style={{ width: 13, height: 13 }} /> : null}
          </View>
          <Txt v="bodyStrong" style={{ flex: 1 }}>
            Bu maliyeti tüm varyantlara uygula ({variantGroup.members.length} ürün)
          </Txt>
        </Tint>
      ) : null}

      <View style={styles.statusRow}>
        {status === "saving" ? (
          <>
            <ActivityIndicator color={color.textDim} size="small" />
            <Txt v="small" tone="dim">
              Kaydediliyor…
            </Txt>
          </>
        ) : status === "saved" ? (
          <Txt v="smallStrong" tone="good">
            ✓ Otomatik kaydedildi
          </Txt>
        ) : status === "error" ? (
          <>
            <Txt v="smallStrong" tone="bad" center>
              ⚠ {saveError ?? parsedForm.error ?? "Kaydetme başarısız."}
            </Txt>
            {saveError && currentPayload ? (
              <Button label="Tekrar dene" size="sm" variant="secondary" onPress={() => enqueueSave(currentPayload)} />
            ) : null}
          </>
        ) : (
          <Txt v="small" tone="faint">
            Değişiklikler otomatik kaydedilir
          </Txt>
        )}
      </View>
    </Screen>
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chipRow}>
      {items.map((it) => (
        <Chip
          key={it.key}
          label={it.label}
          selected={it.key === selected}
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            onSelect(it.key);
          }}
        />
      ))}
    </ScrollView>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
}) {
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <Txt v="label" tone="faint" style={styles.kicker}>
        {label.toLocaleUpperCase("tr-TR")}
      </Txt>
      <Input value={value} onChangeText={onChange} numeric placeholder="0" suffix={suffix} />
    </View>
  );
}

function Etiket({ children }: { children: string }) {
  return (
    <Txt v="label" tone="faint" style={styles.kicker}>
      {children}
    </Txt>
  );
}

const styles = StyleSheet.create({
  kicker: { letterSpacing: 1 },
  preview: { flexDirection: "row", alignItems: "center", gap: space.md },
  card: { gap: space.md },
  twoCol: { flexDirection: "row", gap: space.sm },
  chipRow: { gap: space.sm, paddingRight: space.xs },
  applyAll: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: color.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: color.accent, borderColor: color.accent },
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    marginTop: space.sm,
    minHeight: 24,
  },
});
