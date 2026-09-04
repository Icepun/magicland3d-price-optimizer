import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { Glass } from "@/components/kit/Glass";
import { Txt } from "@/components/kit/Txt";
import { PressableScale } from "@/components/ui/PressableScale";
import { friendlyError } from "@/lib/format";
import { color, radius, space } from "@/theme/tokens";

/**
 * HATA DURUMU — boş durumdan AYRI. Ağ kopunca "0 uyarı" / "henüz makara yok" gibi yalan
 * boş ekranlar yerine bunu göster; tekrar dene düğmesi her zaman var.
 */
export function ErrorState({
  error,
  onRetry,
  retrying = false,
  title = "Veriler alınamadı",
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  title?: string;
}) {
  return (
    <Glass strong style={styles.box}>
      <View style={[styles.icon, { backgroundColor: color.badSoft }]}>
        <SymbolView name="wifi.exclamationmark" tintColor={color.bad} style={{ width: 24, height: 24 }} />
      </View>
      <Txt v="heading" center>
        {title}
      </Txt>
      <Txt v="small" tone="dim" center>
        {friendlyError(error)}
      </Txt>
      {onRetry ? (
        <PressableScale onPress={onRetry} disabled={retrying} style={styles.btn} accessibilityRole="button">
          {retrying ? (
            <ActivityIndicator color={color.text} />
          ) : (
            <Txt v="bodyStrong">Tekrar dene</Txt>
          )}
        </PressableScale>
      ) : null}
    </Glass>
  );
}

/** BOŞ DURUM — gerçekten veri yok. Bir eylem sunar ki kullanıcı çıkmaza girmesin. */
export function EmptyState({
  icon = "tray",
  title,
  hint,
  actionLabel,
  onAction,
}: {
  icon?: SymbolViewProps["name"];
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={[styles.icon, { backgroundColor: color.tintStrong }]}>
        <SymbolView name={icon} tintColor={color.textDim} style={{ width: 26, height: 26 }} />
      </View>
      <Txt v="heading" center>
        {title}
      </Txt>
      {hint ? (
        <Txt v="small" tone="dim" center>
          {hint}
        </Txt>
      ) : null}
      {actionLabel && onAction ? (
        <PressableScale onPress={onAction} style={styles.btn} accessibilityRole="button">
          <Txt v="bodyStrong">{actionLabel}</Txt>
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", gap: space.sm, marginTop: space.lg },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: space.xxl, paddingHorizontal: space.xl },
  icon: { width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  btn: {
    marginTop: space.sm,
    minHeight: 44,
    minWidth: 140,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: color.accentSoft,
    borderWidth: 1,
    borderColor: color.accent,
  },
});
