import * as Updates from "expo-updates";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, View } from "react-native";

import { Button } from "@/components/kit/Button";
import { Glass } from "@/components/kit/Glass";
import { Progress } from "@/components/kit/Progress";
import { Txt } from "@/components/kit/Txt";
import { color, radius, space } from "@/theme/tokens";

/**
 * Görünür OTA güncelleme akışı (expo-updates v56):
 *  açılışta sunucuyu kontrol et → "yeni güncelleme var" cam pencere → kullanıcı "Güncelle" der →
 *  GERÇEK % ilerleme çubuğuyla indirir (useUpdates.downloadProgress) → otomatik yeniden başlatır.
 *
 * Sadece release build'de çalışır (dev / Expo Go'da gizli). Arka planda native auto-download
 * olsa bile kullanıcı onayı olmadan yeniden başlatmaz (starting bayrağı).
 */
export function UpdateGate() {
  const { isUpdateAvailable, isUpdatePending, isDownloading, downloadProgress } = Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;
    Updates.checkForUpdateAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (isUpdatePending && starting) Updates.reloadAsync().catch(() => setStarting(false));
  }, [isUpdatePending, starting]);

  const visible = Updates.isEnabled && !__DEV__ && !dismissed && (isUpdateAvailable || isUpdatePending);
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
        <Glass strong style={styles.card}>
          <View style={styles.icon}>
            <SymbolView name="sparkles" tintColor={color.accentBright} style={{ width: 26, height: 26 }} />
          </View>
          <Txt v="heading" center>
            Yeni güncelleme hazır
          </Txt>

          {busy ? (
            <>
              <Txt v="small" tone="dim" center>
                {isUpdatePending ? "Yeniden başlatılıyor…" : "İndiriliyor…"}
              </Txt>
              <Progress value={Math.max(0.06, pct / 100)} height={8} style={{ marginTop: space.xs }} />
              <View style={styles.pctRow}>
                <ActivityIndicator color={color.accentBright} size="small" />
                <Txt v="smallStrong" tone="dim" num>
                  %{pct}
                </Txt>
              </View>
            </>
          ) : (
            <>
              <Txt v="small" tone="dim" center>
                Uygulamanın son sürümünü şimdi yükleyelim mi?
              </Txt>
              <View style={styles.btns}>
                <Button label="Sonra" variant="secondary" size="sm" onPress={() => setDismissed(true)} style={{ flex: 1 }} />
                <Button label="Güncelle" icon="arrow.down.circle.fill" size="sm" onPress={onUpdate} style={{ flex: 1 }} />
              </View>
            </>
          )}
        </Glass>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: space.xl },
  card: { alignItems: "center", gap: space.sm },
  icon: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: color.accentSoft, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  pctRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.xs },
  btns: { flexDirection: "row", gap: space.sm, marginTop: space.sm, alignSelf: "stretch" },
});
