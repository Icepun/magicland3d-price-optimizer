import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MotiView } from "moti";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import {
  consumeSpool,
  getSpools,
  markSpoolFull,
  spoolStatus,
  type Spool,
} from "@/lib/db/spools";
import { ML, radius } from "@/theme/colors";

const STATUS = {
  empty: { label: "Bitti", color: ML.red },
  low: { label: "Sipariş ver", color: ML.orange },
  ok: { label: "Yeterli", color: ML.green },
} as const;

export default function SpoolsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["spools"],
    queryFn: getSpools,
  });
  const [consumeTarget, setConsumeTarget] = useState<Spool | null>(null);

  const alertCount = (data ?? []).filter((s) => spoolStatus(s) !== "ok").length;

  const refill = useMutation({
    mutationFn: (id: string) => markSpoolFull(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spools"] }),
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Filament Makaralar" />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(s) => s.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 10 }}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ML.accent} />
          }
          ListHeaderComponent={
            alertCount > 0 ? (
              <View style={styles.alertBox}>
                <Text style={styles.alertText}>
                  ⚠ {alertCount} makara azaldı/bitti — sipariş vermeyi unutma
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            <MotiView
              from={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "timing", duration: 240, delay: Math.min(index, 10) * 22 }}
              style={{ flex: 1 }}
            >
              <SpoolCard
                spool={item}
                onConsume={() => setConsumeTarget(item)}
                onRefill={() => refill.mutate(item.id)}
              />
            </MotiView>
          )}
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>
              Makara yok — masaüstünden ekleyebilirsin
            </Text>
          }
        />
      )}

      <ConsumeModal
        spool={consumeTarget}
        onClose={() => setConsumeTarget(null)}
        onDone={() => {
          setConsumeTarget(null);
          qc.invalidateQueries({ queryKey: ["spools"] });
          qc.invalidateQueries({ queryKey: ["notifications"] });
        }}
      />
    </SafeAreaView>
  );
}

function SpoolCard({
  spool,
  onConsume,
  onRefill,
}: {
  spool: Spool;
  onConsume: () => void;
  onRefill: () => void;
}) {
  const st = STATUS[spoolStatus(spool)];
  const pct = Math.max(0, Math.min(100, (spool.remainingGrams / Math.max(1, spool.totalGrams)) * 100));
  return (
    <View style={styles.card}>
      <View style={[styles.stripe, { backgroundColor: spool.colorHex }]} />
      <View style={styles.cardBody}>
        <Text style={styles.name} numberOfLines={1}>
          {spool.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {spool.material}
          {spool.brand ? ` · ${spool.brand}` : ""}
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
          <Pressable
            style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.7 }]}
            onPress={onRefill}
          >
            <Text style={styles.btnGhostText}>Dolu</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ConsumeModal({
  spool,
  onClose,
  onDone,
}: {
  spool: Spool | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [grams, setGrams] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const g = Number(grams.replace(",", "."));
  const valid = g > 0;

  async function submit() {
    if (!spool || !valid) return;
    setBusy(true);
    try {
      await consumeSpool(spool.id, g, { note: note.trim() || null });
      setGrams("");
      setNote("");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={!!spool} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modalWrap}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>{spool?.name} — gram düş</Text>
          <Text style={styles.modalSub}>Kalan: {spool ? Math.round(spool.remainingGrams) : 0}g</Text>
          <TextInput
            value={grams}
            onChangeText={setGrams}
            keyboardType="decimal-pad"
            placeholder="Kaç gram?"
            placeholderTextColor={ML.textFaint}
            style={styles.input}
            autoFocus
          />
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Not (opsiyonel)"
            placeholderTextColor={ML.textFaint}
            style={styles.input}
          />
          <View style={styles.modalActions}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.btnGhostText}>İptal</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtn, (!valid || busy) && { opacity: 0.4 }]}
              onPress={submit}
              disabled={!valid || busy}
            >
              <Text style={styles.btnText}>{busy ? "..." : "Düş"}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: { color: ML.textDim, fontSize: 14 },
  list: { padding: 16, gap: 10, paddingBottom: 24 },
  alertBox: {
    backgroundColor: ML.orangeSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.orange,
    padding: 12,
    marginBottom: 10,
  },
  alertText: { color: ML.orange, fontSize: 13, fontWeight: "600" },
  card: {
    flex: 1,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    overflow: "hidden",
  },
  stripe: { height: 6, width: "100%" },
  cardBody: { padding: 12, gap: 6 },
  name: { color: ML.text, fontSize: 14, fontWeight: "700" },
  meta: { color: ML.textFaint, fontSize: 12 },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: ML.cardElevated,
    overflow: "hidden",
    marginTop: 4,
  },
  barFill: { height: "100%", borderRadius: 4 },
  gramRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  gram: { color: ML.text, fontSize: 14, fontWeight: "800", fontVariant: ["tabular-nums"] },
  gramTotal: { color: ML.textFaint, fontSize: 12, fontWeight: "400" },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  btn: {
    flex: 1,
    backgroundColor: ML.accent,
    borderRadius: radius.md,
    paddingVertical: 8,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  btnGhost: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    paddingVertical: 8,
    alignItems: "center",
  },
  btnGhostText: { color: ML.textDim, fontSize: 13, fontWeight: "600" },
  modalWrap: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.6)" },
  modal: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 18,
    gap: 10,
  },
  modalTitle: { color: ML.text, fontSize: 16, fontWeight: "700" },
  modalSub: { color: ML.textDim, fontSize: 13 },
  input: {
    backgroundColor: ML.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    color: ML.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtnGhost: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalBtn: {
    flex: 1,
    backgroundColor: ML.accent,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: "center",
  },
});
