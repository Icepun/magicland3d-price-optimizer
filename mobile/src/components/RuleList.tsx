import { router, type Href } from "expo-router";
import { StyleSheet, Switch, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import { Button, EmptyState, ErrorState, FadeInView, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import { color, space } from "@/theme/tokens";

export interface RuleListItem {
  id: string;
  name: string;
  subtitle: string;
  badge?: string;
  isActive: boolean;
}

/**
 * KURAL LİSTESİ — komisyon / kargo / gider ekranları bu bileşeni paylaşır: başlıkta Ekle,
 * satırda ad + açıklama + rozet + aç/kapa anahtarı. Hata dalı tek yerde (ağ koptuğunda
 * "kural yok" izlenimi verilmez).
 */
export function RuleList({
  title,
  note,
  addHref,
  editHrefBase,
  items,
  isLoading,
  onToggle,
  error,
  onRetry,
  retrying = false,
}: {
  title: string;
  note: string;
  addHref: Href;
  editHrefBase: string;
  items: RuleListItem[] | undefined;
  isLoading: boolean;
  onToggle: (id: string, active: boolean) => void;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Screen
      header={
        <SubHeader
          title={title}
          subtitle={items ? `${items.length} kural · ${items.filter((r) => r.isActive).length} aktif` : undefined}
          right={<Button label="Ekle" icon="plus" size="sm" variant="secondary" onPress={() => router.push(addHref)} />}
        />
      }
    >
      {error && !items ? (
        <ErrorState error={error} onRetry={onRetry ?? (() => {})} retrying={retrying} />
      ) : isLoading ? (
        <ShimmerList count={5} height={80} />
      ) : (
        <>
          <Txt v="small" tone="faint" style={{ marginHorizontal: space.xs }}>
            {note}
          </Txt>
          {(items ?? []).map((r, i) => (
            <FadeInView key={r.id} index={i}>
              <Tint strong onPress={() => router.push(`${editHrefBase}/${r.id}` as Href)} style={styles.row} accessibilityLabel={r.name}>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <View style={styles.top}>
                    {r.badge ? <Pill>{r.badge}</Pill> : null}
                    <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {r.name}
                    </Txt>
                  </View>
                  <Txt v="small" tone="dim" numberOfLines={1}>
                    {r.subtitle}
                  </Txt>
                </View>
                <Switch
                  value={r.isActive}
                  onValueChange={(v) => onToggle(r.id, v)}
                  trackColor={{ true: color.accent, false: color.tintStrong }}
                  thumbColor="#fff"
                  ios_backgroundColor={color.tintStrong}
                />
              </Tint>
            </FadeInView>
          ))}
          {(items ?? []).length === 0 ? (
            <EmptyState icon="slider.horizontal.3" title="Henüz kural yok" hint="Sağ üstteki Ekle ile oluştur." actionLabel="Kural ekle" onAction={() => router.push(addHref)} />
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  top: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
