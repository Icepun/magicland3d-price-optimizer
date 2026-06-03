import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import * as Updates from "expo-updates";

import { ML, radius } from "@/theme/colors";

/**
 * Görünür OTA güncelleme akışı (expo-updates v56):
 *  açılışta sunucuyu kontrol et → "yeni güncelleme var" popup'ı → kullanıcı "Güncelle" der →
 *  GERÇEK % progress bar ile indirir (useUpdates.downloadProgress) → otomatik yeniden başlatır.
 *
 * Sadece release build'de çalışır (dev / Expo Go'da gizli). Arka planda native auto-download
 * olsa bile kullanıcı onayı olmadan yeniden başlatmaz (starting bayrağı).
 */
export function UpdateGate() {
  const { isUpdateAvailable, isUpdatePending, isDownloading, downloadProgress } =
    Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);

  // Açılışta sunucuyu kontrol et (native auto-check kapalı/yavaş olsa bile güvence).
  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;
    Updates.checkForUpdateAsync().catch(() => {});
  }, []);

  // Kullanıcı "Güncelle" dedikten sonra indirme bitince uygula (yeniden başlat).
  useEffect(() => {
    if (isUpdatePending && starting) Updates.reloadAsync().catch(() => setStarting(false));
  }, [isUpdatePending, starting]);

  const visible =
    Updates.isEnabled && !__DEV__ && !dismissed && (isUpdateAvailable || isUpdatePending);
  if (!visible) return null;

  const busy = starting || isDownloading;
  const pct = Math.round((downloadProgress ?? 0) * 100);

  const onUpdate = async () => {
    setStarting(true);
    try {
      if (isUpdatePending) await Updates.reloadAsync();
      else await Updates.fetchUpdateAsync();
    } catch {
      setStarting(false);
    }
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {
        if (!busy) setDismissed(true);
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.emoji}>✨</Text>
          <Text style={styles.title}>Yeni güncelleme hazır</Text>

          {busy ? (
            <>
              <Text style={styles.hint}>
                {isUpdatePending ? "Yeniden başlatılıyor…" : "İndiriliyor…"}
              </Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(6, pct)}%` }]} />
              </View>
              <View style={styles.pctRow}>
                <ActivityIndicator color={ML.accent} size="small" />
                <Text style={styles.pct}>%{pct}</Text>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.hint}>Uygulamanın son sürümünü şimdi yükleyelim mi?</Text>
              <View style={styles.btns}>
                <Pressable onPress={() => setDismissed(true)} hitSlop={10}>
                  <Text style={styles.later}>Sonra</Text>
                </Pressable>
                <Pressable onPress={onUpdate} hitSlop={10} style={styles.updateBtn}>
                  <Text style={styles.updateTxt}>Güncelle</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 28,
  },
  card: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    padding: 22,
    borderWidth: 1,
    borderColor: ML.border,
    alignItems: "center",
  },
  emoji: { fontSize: 34, marginBottom: 6 },
  title: { color: ML.text, fontSize: 18, fontWeight: "800", marginBottom: 6 },
  hint: { color: ML.textDim, fontSize: 14, textAlign: "center", marginBottom: 16, lineHeight: 20 },
  track: {
    width: "100%",
    height: 8,
    borderRadius: 4,
    backgroundColor: ML.cardElevated,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 4, backgroundColor: ML.accent },
  pctRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  pct: { color: ML.textDim, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  btns: { flexDirection: "row", alignItems: "center", gap: 24 },
  later: { color: ML.textDim, fontSize: 15, fontWeight: "600" },
  updateBtn: {
    backgroundColor: ML.accent,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: radius.md,
  },
  updateTxt: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
