import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { FlashList } from "@shopify/flash-list";
import { useEffect, useState } from "react";
import {
  Alert,
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { FadeInView } from "@/components/fade-in";
import { ScreenHeader } from "@/components/form";
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
import { useManualRefresh } from "@/lib/use-refresh";
import { ML, radius } from "@/theme/colors";

const STATUS = {
  empty: { label: "Bitti", color: ML.red },
  low: { label: "Sipariş ver", color: ML.orange },
  ok: { label: "Yeterli", color: ML.green },
} as const;

const MATERIALS = ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Reçine"];
// Zengin palet (hex girişi de var → her rengi seçebilirsin)
const SWATCHES = [
  "#FFFFFF", "#E5E7EB", "#9CA3AF", "#4B5563", "#1F2937", "#000000",
  "#FCA5A5", "#EF4444", "#B91C1C", "#FDBA74", "#F97316", "#C2410C",
  "#FDE68A", "#FACC15", "#CA8A04", "#86EFAC", "#22C55E", "#15803D",
  "#67E8F9", "#06B6D4", "#0E7490", "#93C5FD", "#3B82F6", "#1D4ED8",
  "#C4B5FD", "#8B5CF6", "#6D28D9", "#F9A8D4", "#EC4899", "#BE185D",
];

export default function SpoolsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["spools"], queryFn: getSpools });
  const { refreshing, onRefresh } = useManualRefresh(refetch);
  const [consumeTarget, setConsumeTarget] = useState<Spool | null>(null);
  const [formTarget, setFormTarget] = useState<Spool | "new" | null>(null);

  const alertCount = (data ?? []).filter((s) => spoolStatus(s) !== "ok").length;

  // Optimistic: ["spools"] cache'i anında güncellenir, DB arka planda yazılır, hata olursa geri alınır.
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
    mutationFn: ({ id, grams, note }: { id: string; grams: number; note: string | null }) =>
      consumeSpool(id, grams, { note }),
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
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Filament Makaralar" />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <FlashList
          data={data ?? []}
          keyExtractor={(s) => s.id}
          numColumns={2}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />}
          ListHeaderComponent={
            alertCount > 0 ? (
              <View style={styles.alertBox}>
                <Text style={styles.alertText}>⚠ {alertCount} makara azaldı/bitti — sipariş ver</Text>
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            <FadeInView index={index} style={{ flex: 1, margin: 5 }}>
              <SpoolCard
                spool={item}
                onConsume={() => setConsumeTarget(item)}
                onRefill={() => refill.mutate(item.id)}
                onEdit={() => setFormTarget(item)}
              />
            </FadeInView>
          )}
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>
              Henüz makara yok — sağ alttan ekle
            </Text>
          }
        />
      )}

      {/* Ekle (FAB) */}
      <Pressable
        onPress={() => setFormTarget("new")}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] }]}
      >
        <SymbolView name="plus" tintColor="#fff" style={{ width: 26, height: 26 }} />
      </Pressable>

      <ConsumeModal
        spool={consumeTarget}
        onClose={() => setConsumeTarget(null)}
        onConsume={(grams, note) => {
          if (consumeTarget) consumeMut.mutate({ id: consumeTarget.id, grams, note });
          setConsumeTarget(null);
        }}
      />
      <SpoolFormModal target={formTarget} onClose={() => setFormTarget(null)} onDone={() => { setFormTarget(null); invalidate(); }} />
    </SafeAreaView>
  );
}

function SpoolCard({ spool, onConsume, onRefill, onEdit }: { spool: Spool; onConsume: () => void; onRefill: () => void; onEdit: () => void }) {
  const st = STATUS[spoolStatus(spool)];
  const pct = Math.max(0, Math.min(100, (spool.remainingGrams / Math.max(1, spool.totalGrams)) * 100));
  return (
    <View style={styles.card}>
      <View style={[styles.stripe, { backgroundColor: spool.colorHex }]} />
      <Pressable onPress={onEdit} hitSlop={6} style={styles.editIcon}>
        <SymbolView name="pencil" tintColor={ML.textFaint} style={{ width: 16, height: 16 }} />
      </Pressable>
      <View style={styles.cardBody}>
        <Text style={styles.name} numberOfLines={1}>{spool.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {spool.material}{spool.brand ? ` · ${spool.brand}` : ""}
        </Text>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: st.color }]} />
        </View>
        <View style={styles.gramRow}>
          <Text style={styles.gram}>
            {Math.round(spool.remainingGrams)}
            <Text style={styles.gramTotal}> / {Math.round(spool.totalGrams)}g</Text>
          </Text>
          <View style={[styles.pill, { backgroundColor: st.color + "22" }]}>
            <Text style={[styles.pillText, { color: st.color }]}>{st.label}</Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]} onPress={onConsume}>
            <Text style={styles.btnText}>Düş</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.7 }]} onPress={onRefill}>
            <Text style={styles.btnGhostText}>Dolu</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ConsumeModal({ spool, onClose, onConsume }: { spool: Spool | null; onClose: () => void; onConsume: (grams: number, note: string | null) => void }) {
  const [grams, setGrams] = useState("");
  const [note, setNote] = useState("");
  const g = Number(grams.replace(",", "."));
  const valid = g > 0;

  function submit() {
    if (!spool || !valid) return;
    onConsume(g, note.trim() || null);
    setGrams("");
    setNote("");
  }

  return (
    <Modal visible={!!spool} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>{spool?.name} — gram düş</Text>
          <Text style={styles.modalSub}>Kalan: {spool ? Math.round(spool.remainingGrams) : 0}g</Text>
          <TextInput value={grams} onChangeText={setGrams} keyboardType="decimal-pad" placeholder="Kaç gram?" placeholderTextColor={ML.textFaint} style={styles.input} autoFocus />
          <TextInput value={note} onChangeText={setNote} placeholder="Not (opsiyonel)" placeholderTextColor={ML.textFaint} style={styles.input} />
          <View style={styles.modalActions}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}><Text style={styles.btnGhostText}>İptal</Text></Pressable>
            <Pressable style={[styles.modalBtn, !valid && { opacity: 0.4 }]} onPress={submit} disabled={!valid}>
              <Text style={styles.btnText}>Düş</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SpoolFormModal({ target, onClose, onDone }: { target: Spool | "new" | null; onClose: () => void; onDone: () => void }) {
  const editing = target !== "new" && target !== null;
  const [name, setName] = useState("");
  const [material, setMaterial] = useState("PLA");
  const [brand, setBrand] = useState("");
  const [colorHex, setColorHex] = useState(SWATCHES[0]);
  const [total, setTotal] = useState("1000");
  const [remaining, setRemaining] = useState("1000");
  const [reorder, setReorder] = useState("200");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target && target !== "new") {
      setName(target.name); setMaterial(target.material); setBrand(target.brand ?? "");
      setColorHex(target.colorHex); setTotal(String(target.totalGrams));
      setRemaining(String(target.remainingGrams)); setReorder(String(target.reorderGrams));
      setCost(target.spoolCost != null ? String(target.spoolCost) : "");
    } else if (target === "new") {
      setName(""); setMaterial("PLA"); setBrand(""); setColorHex(SWATCHES[0]);
      setTotal("1000"); setRemaining("1000"); setReorder("200"); setCost("");
    }
  }, [target]);

  const num = (s: string) => Number(s.replace(",", ".")) || 0;
  const valid = name.trim().length > 0 && num(total) > 0;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    const payload: SpoolInput = {
      name: name.trim(), material, colorName: null, colorHex,
      brand: brand.trim() || null, totalGrams: num(total),
      remainingGrams: num(remaining || total), reorderGrams: num(reorder),
      spoolCost: cost.trim() ? num(cost) : null,
    };
    try {
      if (editing) await updateSpool(target.id, payload);
      else await createSpool(payload);
      onDone();
    } catch {
      Alert.alert("Hata", "Makara kaydedilemedi (bağlantıyı kontrol et).");
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    try { await deleteSpool(target.id); onDone(); }
    catch { Alert.alert("Hata", "Makara silinemedi (bağlantıyı kontrol et).");
    } finally { setBusy(false); }
  }

  return (
    <Modal visible={!!target} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.formWrap}>
        <View style={styles.formSheet}>
          <View style={styles.formHandle} />
          <Text style={styles.modalTitle}>{editing ? "Makarayı Düzenle" : "Yeni Makara"}</Text>
          <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
            <Field label="İsim">
              <TextInput value={name} onChangeText={setName} placeholder="ör. Kırmızı PLA" placeholderTextColor={ML.textFaint} style={styles.input} />
            </Field>
            <Field label="Materyal">
              <View style={styles.chipRow}>
                {MATERIALS.map((m) => (
                  <Pressable key={m} onPress={() => setMaterial(m)} style={[styles.chip, material === m && styles.chipOn]}>
                    <Text style={[styles.chipText, material === m && { color: "#fff", fontWeight: "700" }]}>{m}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>
            <Field label="Renk">
              <View style={styles.colorRow}>
                <View style={[styles.colorPreview, { backgroundColor: colorHex }]} />
                <TextInput
                  value={colorHex}
                  onChangeText={(t) => {
                    const v = t.startsWith("#") ? t : "#" + t;
                    setColorHex(v.toUpperCase().slice(0, 7));
                  }}
                  placeholder="#RRGGBB"
                  placeholderTextColor={ML.textFaint}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={7}
                  style={[styles.input, { flex: 1 }]}
                />
              </View>
              <View style={[styles.chipRow, { marginTop: 8 }]}>
                {SWATCHES.map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setColorHex(c)}
                    style={[
                      styles.swatch,
                      { backgroundColor: c },
                      colorHex.toUpperCase() === c.toUpperCase() && styles.swatchOn,
                    ]}
                  />
                ))}
              </View>
            </Field>
            <Field label="Marka (opsiyonel)">
              <TextInput value={brand} onChangeText={setBrand} placeholder="ör. eSUN" placeholderTextColor={ML.textFaint} style={styles.input} />
            </Field>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Field label="Toplam (g)" flex>
                <TextInput value={total} onChangeText={setTotal} keyboardType="decimal-pad" style={styles.input} />
              </Field>
              <Field label="Kalan (g)" flex>
                <TextInput value={remaining} onChangeText={setRemaining} keyboardType="decimal-pad" style={styles.input} />
              </Field>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Field label="Uyarı eşiği (g)" flex>
                <TextInput value={reorder} onChangeText={setReorder} keyboardType="decimal-pad" style={styles.input} />
              </Field>
              <Field label="Maliyet (₺, ops.)" flex>
                <TextInput value={cost} onChangeText={setCost} keyboardType="decimal-pad" style={styles.input} />
              </Field>
            </View>
            {editing && (
              <Pressable onPress={remove} disabled={busy} style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]}>
                <Text style={styles.deleteText}>Makarayı Sil</Text>
              </Pressable>
            )}
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}><Text style={styles.btnGhostText}>İptal</Text></Pressable>
            <Pressable style={[styles.modalBtn, (!valid || busy) && { opacity: 0.4 }]} onPress={submit} disabled={!valid || busy}>
              <Text style={styles.btnText}>{busy ? "..." : "Kaydet"}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, children, flex }: { label: string; children: React.ReactNode; flex?: boolean }) {
  return (
    <View style={flex ? { flex: 1, gap: 6 } : { gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: { color: ML.textDim, fontSize: 14 },
  list: { paddingHorizontal: 11, paddingTop: 11, paddingBottom: 90 },
  alertBox: { backgroundColor: ML.orangeSoft, borderRadius: radius.md, borderWidth: 1, borderColor: ML.orange, padding: 12, marginBottom: 10 },
  alertText: { color: ML.orange, fontSize: 13, fontWeight: "600" },
  card: { flex: 1, backgroundColor: ML.card, borderRadius: radius.lg, borderWidth: 1, borderColor: ML.borderSoft, overflow: "hidden" },
  stripe: { height: 6, width: "100%" },
  editIcon: { position: "absolute", top: 12, right: 10, padding: 4, zIndex: 2 },
  cardBody: { padding: 12, gap: 6 },
  name: { color: ML.text, fontSize: 14, fontWeight: "700", paddingRight: 20 },
  meta: { color: ML.textFaint, fontSize: 12 },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: ML.cardElevated, overflow: "hidden", marginTop: 4 },
  barFill: { height: "100%", borderRadius: 4 },
  gramRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  gram: { color: ML.text, fontSize: 14, fontWeight: "800", fontVariant: ["tabular-nums"] },
  gramTotal: { color: ML.textFaint, fontSize: 12, fontWeight: "400" },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  btn: { flex: 1, backgroundColor: ML.accent, borderRadius: radius.md, paddingVertical: 8, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  btnGhost: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: ML.border, paddingVertical: 8, alignItems: "center" },
  btnGhostText: { color: ML.textDim, fontSize: 13, fontWeight: "600" },
  fab: {
    position: "absolute", bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28,
    backgroundColor: ML.accent, alignItems: "center", justifyContent: "center",
    // RN 0.83/Expo 56 boxShadow'u native + web'de destekler; eski shadow* prop'ları
    // Expo web/SSR sırasında deprecation uyarısı üretiyordu.
    boxShadow: "0 4px 8px rgba(0, 0, 0, 0.3)",
    elevation: 6,
  },
  modalWrap: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.6)" },
  modal: { backgroundColor: ML.card, borderRadius: radius.lg, borderWidth: 1, borderColor: ML.border, padding: 18, gap: 10 },
  modalTitle: { color: ML.text, fontSize: 16, fontWeight: "700" },
  modalSub: { color: ML.textDim, fontSize: 13 },
  input: { backgroundColor: ML.bg, borderRadius: radius.md, borderWidth: 1, borderColor: ML.border, color: ML.text, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 6 },
  modalBtnGhost: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: ML.border, paddingVertical: 12, alignItems: "center" },
  modalBtn: { flex: 1, backgroundColor: ML.accent, borderRadius: radius.md, paddingVertical: 12, alignItems: "center" },
  formWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  formSheet: { backgroundColor: ML.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: ML.border, padding: 18, gap: 12, maxHeight: "88%" },
  formHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: ML.border, marginBottom: 4 },
  fieldLabel: { color: ML.textFaint, fontSize: 12, fontWeight: "600" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: ML.bg, borderWidth: 1, borderColor: ML.border },
  chipOn: { backgroundColor: ML.accent, borderColor: ML.accent },
  chipText: { color: ML.textDim, fontSize: 13 },
  colorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  colorPreview: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: ML.border },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: "transparent" },
  swatchOn: { borderColor: ML.text },
  deleteBtn: { borderRadius: radius.md, borderWidth: 1, borderColor: ML.red, paddingVertical: 12, alignItems: "center", marginTop: 4 },
  deleteText: { color: ML.red, fontSize: 14, fontWeight: "700" },
});
