import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { slugifyTr } from "@/core/filament-groups";
import { Chip, Pill } from "@/components/kit/Chip";
import {
  Button,
  EmptyState,
  ErrorState,
  FadeInView,
  Glass,
  IconButton,
  Input,
  Progress,
  Screen,
  ShimmerList,
  SubHeader,
  Tint,
  Txt,
} from "@/components/kit";
import { PressableScale } from "@/components/ui/PressableScale";
import {
  consumeSpool,
  createSpool,
  deleteSpool,
  getSpools,
  markSpoolFull,
  spoolStatus,
  updateSpool,
  type Spool,
  type SpoolInput,
} from "@/lib/db/spools";
import { formatNumber } from "@/lib/format";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

const STATUS = {
  empty: { label: "Bitti", color: color.bad },
  low: { label: "Sipariş ver", color: color.warn },
  ok: { label: "Yeterli", color: color.good },
} as const;

const MATERIALS = ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Reçine"];
const SWATCHES = [
  "#FFFFFF", "#E5E7EB", "#9CA3AF", "#4B5563", "#1F2937", "#000000",
  "#FCA5A5", "#EF4444", "#B91C1C", "#FDBA74", "#F97316", "#C2410C",
  "#FDE68A", "#FACC15", "#CA8A04", "#86EFAC", "#22C55E", "#15803D",
  "#67E8F9", "#06B6D4", "#0E7490", "#93C5FD", "#3B82F6", "#1D4ED8",
  "#C4B5FD", "#8B5CF6", "#6D28D9", "#F9A8D4", "#EC4899", "#BE185D",
];

/**
 * FİLAMENT MAKARALARI — iki sütun kart, renk şeridi, doluluk çubuğu, gram düş / dolu işaretle,
 * ekle/düzenle formu. İyimser güncellemeler ve v37 renk adı koruması öncekiyle aynı.
 */
export default function SpoolsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, error, isFetching } = useQuery({ queryKey: ["spools"], queryFn: getSpools });
  const { refreshing, onRefresh } = useManualRefresh(refetch);
  const [consumeTarget, setConsumeTarget] = useState<Spool | null>(null);
  const [formTarget, setFormTarget] = useState<Spool | "new" | null>(null);

  const alertCount = (data ?? []).filter((s) => spoolStatus(s) !== "ok").length;

  const patchSpool = (id: string, patch: Partial<Spool>) =>
    qc.setQueryData<Spool[]>(["spools"], (o) => (o ? o.map((s) => (s.id === id ? { ...s, ...patch } : s)) : o));
  const bumpNotif = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["spools"] });
    bumpNotif();
  };

  const refill = useMutation({
    mutationFn: markSpoolFull,
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ["spools"] });
      const prev = qc.getQueryData<Spool[]>(["spools"]);
      const sp = prev?.find((s) => s.id === id);
      if (sp) patchSpool(id, { remainingGrams: sp.totalGrams });
      bumpNotif();
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["spools"], ctx.prev),
  });

  const consumeMut = useMutation({
    mutationFn: ({ id, grams, note }: { id: string; grams: number; note: string | null }) => consumeSpool(id, grams, { note }),
    onMutate: async ({ id, grams }) => {
      await qc.cancelQueries({ queryKey: ["spools"] });
      const prev = qc.getQueryData<Spool[]>(["spools"]);
      const sp = prev?.find((s) => s.id === id);
      if (sp) patchSpool(id, { remainingGrams: Math.max(0, sp.remainingGrams - grams) });
      bumpNotif();
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["spools"], ctx.prev),
  });

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <SubHeader
          title="Filament"
          subtitle={data ? `${formatNumber(data.length)} makara${alertCount ? ` · ${alertCount} uyarı` : ""}` : undefined}
          right={<IconButton icon="plus" accent onPress={() => setFormTarget("new")} accessibilityLabel="Makara ekle" />}
        />
      }
    >
      {isLoading ? (
        <View style={styles.pad}>
          <ShimmerList count={6} height={150} />
        </View>
      ) : error && !data ? (
        <View style={styles.pad}>
          <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </View>
      ) : (
        <FlashList
          data={data ?? []}
          keyExtractor={(s) => s.id}
          numColumns={2}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.accentBright} />}
          ListHeaderComponent={
            alertCount > 0 ? (
              <Tint strong style={styles.alert}>
                <SymbolView name="exclamationmark.triangle.fill" tintColor={color.warn} style={{ width: 16, height: 16 }} />
                <Txt v="smallStrong" tone="warn" style={{ flex: 1 }}>
                  {alertCount} makara azaldı ya da bitti — sipariş ver
                </Txt>
              </Tint>
            ) : null
          }
          renderItem={({ item, index }) => (
            <FadeInView index={index} style={styles.cell}>
              <SpoolCard
                spool={item}
                onConsume={() => setConsumeTarget(item)}
                onRefill={() => refill.mutate(item.id)}
                onEdit={() => setFormTarget(item)}
              />
            </FadeInView>
          )}
          ListEmptyComponent={
            <EmptyState icon="circle.grid.cross" title="Henüz makara yok" hint="Sağ üstteki artı ile ekle." actionLabel="Makara ekle" onAction={() => setFormTarget("new")} />
          }
        />
      )}

      {consumeTarget ? (
        <ConsumeModal
          key={consumeTarget.id}
          spool={consumeTarget}
          onClose={() => setConsumeTarget(null)}
          onConsume={(grams, note) => {
            consumeMut.mutate({ id: consumeTarget.id, grams, note });
            setConsumeTarget(null);
          }}
        />
      ) : null}
      {formTarget ? (
        <SpoolFormModal
          key={formTarget === "new" ? "new" : formTarget.id}
          target={formTarget}
          onClose={() => setFormTarget(null)}
          onDone={() => {
            setFormTarget(null);
            invalidate();
          }}
        />
      ) : null}
    </Screen>
  );
}

function SpoolCard({ spool, onConsume, onRefill, onEdit }: { spool: Spool; onConsume: () => void; onRefill: () => void; onEdit: () => void }) {
  const st = STATUS[spoolStatus(spool)];
  const oran = Math.max(0, Math.min(1, spool.remainingGrams / Math.max(1, spool.totalGrams)));
  return (
    <Tint strong padded={false} style={styles.card}>
      <View style={[styles.stripe, { backgroundColor: spool.colorHex }]} />
      <View style={styles.cardBody}>
        <View style={styles.rowBetween}>
          <Txt v="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
            {spool.name}
          </Txt>
          <IconButton icon="pencil" size={28} onPress={onEdit} haptic="yok" accessibilityLabel="Makarayı düzenle" />
        </View>
        <Txt v="small" tone="faint" numberOfLines={1}>
          {spool.material}
          {spool.brand ? ` · ${spool.brand}` : ""}
        </Txt>
        <Progress value={oran} color={st.color} height={7} style={{ marginTop: 4 }} />
        <View style={styles.rowBetween}>
          <Txt v="bodyStrong" num>
            {Math.round(spool.remainingGrams)}
            <Txt v="small" tone="faint" num>
              {" "}/ {Math.round(spool.totalGrams)}g
            </Txt>
          </Txt>
          <Pill color={st.color}>{st.label}</Pill>
        </View>
        <View style={styles.actions}>
          <Button label="Düş" size="sm" onPress={onConsume} style={{ flex: 1 }} />
          <Button label="Dolu" size="sm" variant="secondary" onPress={onRefill} style={{ flex: 1 }} />
        </View>
      </View>
    </Tint>
  );
}

function ConsumeModal({ spool, onClose, onConsume }: { spool: Spool; onClose: () => void; onConsume: (grams: number, note: string | null) => void }) {
  const [grams, setGrams] = useState("");
  const [note, setNote] = useState("");
  const g = Number(grams.replace(",", "."));
  const valid = g > 0;

  function submit() {
    if (!valid) return;
    onConsume(g, note.trim() || null);
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Glass strong style={{ gap: space.sm }}>
          <Txt v="heading">{spool.name} — gram düş</Txt>
          <Txt v="small" tone="dim" num>
            Kalan: {Math.round(spool.remainingGrams)}g
          </Txt>
          <Input value={grams} onChangeText={setGrams} numeric placeholder="Kaç gram?" suffix="g" autoFocus />
          <Input value={note} onChangeText={setNote} placeholder="Not (isteğe bağlı)" />
          <View style={styles.modalActions}>
            <Button label="İptal" variant="secondary" size="sm" onPress={onClose} style={{ flex: 1 }} />
            <Button label="Düş" size="sm" onPress={submit} disabled={!valid} style={{ flex: 1 }} />
          </View>
        </Glass>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SpoolFormModal({ target, onClose, onDone }: { target: Spool | "new"; onClose: () => void; onDone: () => void }) {
  const initial = target === "new" ? null : target;
  const editing = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [material, setMaterial] = useState(initial?.material ?? "PLA");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [colorHex, setColorHex] = useState(initial?.colorHex ?? SWATCHES[0]);
  // v37: renk ADI envanter gruplamasının ekseni — form tutmazsa masaüstünde girilen ad silinir.
  const [colorName, setColorName] = useState(initial?.colorName ?? "");
  const [total, setTotal] = useState(initial ? String(initial.totalGrams) : "1000");
  const [remaining, setRemaining] = useState(initial ? String(initial.remainingGrams) : "1000");
  const [reorder, setReorder] = useState(initial ? String(initial.reorderGrams) : "200");
  const [cost, setCost] = useState(initial?.spoolCost != null ? String(initial.spoolCost) : "");
  const [busy, setBusy] = useState(false);

  const num = (s: string) => Number(s.replace(",", ".")) || 0;
  const valid = name.trim().length > 0 && num(total) > 0;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    const payload: SpoolInput = {
      name: name.trim(),
      material,
      colorName: colorName.trim() || null,
      colorHex,
      colorKey: colorName.trim() ? slugifyTr(colorName.trim()) : (initial?.colorKey ?? null),
      brand: brand.trim() || null,
      totalGrams: num(total),
      remainingGrams: num(remaining || total),
      reorderGrams: num(reorder),
      spoolCost: cost.trim() ? num(cost) : null,
    };
    try {
      if (initial) await updateSpool(initial.id, payload);
      else await createSpool(payload);
      onDone();
    } catch {
      Alert.alert("Hata", "Makara kaydedilemedi (bağlantıyı kontrol et).");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial) return;
    setBusy(true);
    try {
      await deleteSpool(initial.id);
      onDone();
    } catch {
      Alert.alert("Hata", "Makara silinemedi (bağlantıyı kontrol et).");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={!!target} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.formWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.formSheet}>
          <View style={styles.formHandle} />
          <Txt v="heading">{editing ? "Makarayı düzenle" : "Yeni makara"}</Txt>
          <ScrollView contentContainerStyle={{ gap: space.md, paddingBottom: space.sm }} keyboardShouldPersistTaps="handled">
            <Alan label="İsim">
              <Input value={name} onChangeText={setName} placeholder="ör. Kırmızı PLA" />
            </Alan>
            <Alan label="Materyal">
              <View style={styles.chipRow}>
                {MATERIALS.map((m) => (
                  <Chip key={m} label={m} selected={material === m} onPress={() => setMaterial(m)} />
                ))}
              </View>
            </Alan>
            <Alan label="Renk">
              <View style={styles.colorRow}>
                <View style={[styles.colorPreview, { backgroundColor: colorHex }]} />
                <Input
                  value={colorHex}
                  onChangeText={(t) => {
                    const v = t.startsWith("#") ? t : "#" + t;
                    setColorHex(v.toUpperCase().slice(0, 7));
                  }}
                  placeholder="#RRGGBB"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={7}
                  style={{ flex: 1 }}
                />
              </View>
              <View style={[styles.chipRow, { marginTop: space.sm }]}>
                {SWATCHES.map((c) => (
                  <PressableScale
                    key={c}
                    onPress={() => setColorHex(c)}
                    haptic="yok"
                    accessibilityLabel={c}
                    style={[styles.swatch, { backgroundColor: c }, colorHex.toUpperCase() === c.toUpperCase() ? styles.swatchOn : null]}
                  />
                ))}
              </View>
            </Alan>
            <Alan label="Renk adı (gruplama için)">
              <Input value={colorName} onChangeText={setColorName} placeholder="Siyah, Yeşil, Koyu Yeşil…" />
            </Alan>
            <Alan label="Marka (isteğe bağlı)">
              <Input value={brand} onChangeText={setBrand} placeholder="ör. eSUN" />
            </Alan>
            <View style={styles.twoCol}>
              <Alan label="Toplam" flex>
                <Input value={total} onChangeText={setTotal} numeric suffix="g" />
              </Alan>
              <Alan label="Kalan" flex>
                <Input value={remaining} onChangeText={setRemaining} numeric suffix="g" />
              </Alan>
            </View>
            <View style={styles.twoCol}>
              <Alan label="Uyarı eşiği" flex>
                <Input value={reorder} onChangeText={setReorder} numeric suffix="g" />
              </Alan>
              <Alan label="Maliyet (isteğe bağlı)" flex>
                <Input value={cost} onChangeText={setCost} numeric suffix="₺" />
              </Alan>
            </View>
            {editing ? <Button label="Makarayı sil" variant="danger" onPress={remove} disabled={busy} /> : null}
          </ScrollView>
          <View style={styles.modalActions}>
            <Button label="İptal" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button label="Kaydet" onPress={submit} loading={busy} disabled={!valid} style={{ flex: 1 }} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Alan({ label, children, flex }: { label: string; children: React.ReactNode; flex?: boolean }) {
  return (
    <View style={flex ? { flex: 1, gap: 6 } : { gap: 6 }}>
      <Txt v="label" tone="faint" style={{ letterSpacing: 1 }}>
        {label.toLocaleUpperCase("tr-TR")}
      </Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.lg },
  list: { paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.xxl },
  cell: { flex: 1, margin: space.xs },
  alert: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, margin: space.xs, marginBottom: space.sm, borderColor: color.warn + "66" },
  card: { flex: 1, overflow: "hidden" },
  stripe: { height: 5, width: "100%" },
  cardBody: { padding: space.md, gap: 4 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  modalWrap: { flex: 1, justifyContent: "center", padding: space.xl, backgroundColor: "rgba(0,0,0,0.6)" },
  modalActions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  formWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  formSheet: {
    backgroundColor: color.glassStrong,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    padding: space.lg,
    gap: space.md,
    maxHeight: "90%",
  },
  formHandle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: color.lineStrong },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  colorRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  colorPreview: { width: 46, height: 46, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: "transparent" },
  swatchOn: { borderColor: color.text },
  twoCol: { flexDirection: "row", gap: space.sm },
});
