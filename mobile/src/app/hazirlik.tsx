import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { Alert, StyleSheet, View } from "react-native";

import type { PrepItem } from "@core/prep-list";
import { Pill } from "@/components/kit/Chip";
import {
  EmptyState,
  ErrorState,
  FadeInView,
  IconButton,
  Progress,
  Screen,
  ShimmerList,
  SubHeader,
  Txt,
} from "@/components/kit";
import { PressableScale } from "@/components/ui/PressableScale";
import { getAllOrders, ORDERS_STALE_MS, visibleOrders } from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { clearPrepDone, getPrepDone, setPrepDone } from "@/lib/db/prep";
import { formatNumber, formatPercent } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { prepItemsFromOrders } from "@/lib/prep";
import { color, radius, space } from "@/theme/tokens";

/**
 * HAZIRLIK — "bugün rafa gidip neyi kaç adet toplayacağım".
 *
 * Paketleme rafın önünde yapılıyor; işaretler `PrepDone` tablosunda (şema v46) masaüstüyle
 * ORTAK. Dokunuş anında dolar (iyimser güncelleme), yazma düşerse geri alınır.
 */

function PrepRow({ item, done, onToggle }: { item: PrepItem; done: boolean; onToggle: () => void }) {
  const gorsel = thumbUrl(item.image, 160);
  return (
    <PressableScale
      onPress={onToggle}
      haptic="orta"
      style={[styles.row, done ? styles.rowDone : null]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={`${item.name}, ${item.quantity} adet`}
    >
      <View style={[styles.check, done ? styles.checkOn : null]}>
        {done ? <SymbolView name="checkmark" weight="bold" style={{ width: 14, height: 14 }} tintColor={color.bg0} /> : null}
      </View>

      {gorsel ? (
        <Image source={{ uri: gorsel }} style={styles.photo} contentFit="cover" transition={150} recyclingKey={item.key} />
      ) : (
        <View style={[styles.photo, styles.photoBos]}>
          <SymbolView name="cube.box" style={{ width: 18, height: 18 }} tintColor={color.textFaint} />
        </View>
      )}

      <View style={styles.info}>
        <Txt v="bodyStrong" tone={done ? "dim" : "default"} numberOfLines={2} style={done ? styles.nameDone : null}>
          {item.name}
        </Txt>
        <View style={styles.meta}>
          {item.madeToOrder ? <Pill color={color.manual}>Sipariş üzerine</Pill> : null}
          <Txt v="small" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>
            {item.orderNumbers.length > 2
              ? `${item.orderNumbers.slice(0, 2).join(", ")} +${item.orderNumbers.length - 2}`
              : item.orderNumbers.join(", ")}
          </Txt>
        </View>
      </View>

      <Txt v="title" tone={done ? "faint" : "accent"} num>
        {item.quantity}
      </Txt>
    </PressableScale>
  );
}

export default function HazirlikScreen() {
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ["orders"], queryFn: getAllOrders, staleTime: ORDERS_STALE_MS });
  const products = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const done = useQuery({ queryKey: ["prep-done"], queryFn: getPrepDone });

  const items = useMemo(
    () => (orders.data ? prepItemsFromOrders(visibleOrders(orders.data.orders), products.data) : []),
    [orders.data, products.data]
  );

  const doneSet = useMemo(() => new Set(done.data ?? []), [done.data]);
  const kalan = items.filter((i) => !doneSet.has(i.key));
  const toplamAdet = kalan.reduce((t, i) => t + i.quantity, 0);
  const ilerleme = items.length ? (items.length - kalan.length) / items.length : 0;

  const toggle = useMutation({
    mutationFn: ({ key, isaretle }: { key: string; isaretle: boolean }) => setPrepDone(key, isaretle),
    onMutate: async ({ key, isaretle }) => {
      await qc.cancelQueries({ queryKey: ["prep-done"] });
      const onceki = qc.getQueryData<string[]>(["prep-done"]) ?? [];
      qc.setQueryData<string[]>(["prep-done"], isaretle ? [...onceki, key] : onceki.filter((k) => k !== key));
      return { onceki };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(["prep-done"], ctx.onceki);
    },
  });

  const sifirla = useMutation({
    mutationFn: () => clearPrepDone(done.data ?? []),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["prep-done"] });
      const onceki = qc.getQueryData<string[]>(["prep-done"]) ?? [];
      qc.setQueryData<string[]>(["prep-done"], []);
      return { onceki };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(["prep-done"], ctx.onceki);
    },
  });

  const yukleniyor = orders.isLoading || done.isLoading;
  const hata = orders.error ?? done.error;

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <>
          <Stack.Screen options={{ headerShown: false }} />
          <SubHeader
            title="Hazırlık"
            subtitle={
              yukleniyor
                ? "yükleniyor…"
                : items.length === 0
                  ? "hazırlanacak sipariş yok"
                  : `${formatNumber(kalan.length)} ürün · ${formatNumber(toplamAdet)} adet kaldı`
            }
            right={
              doneSet.size > 0 ? (
                <IconButton
                  icon="arrow.counterclockwise"
                  haptic="orta"
                  accessibilityLabel="İşaretleri sıfırla"
                  onPress={() =>
                    Alert.alert("İşaretleri sıfırla", "Tüm hazırlandı işaretleri kaldırılsın mı?", [
                      { text: "Vazgeç", style: "cancel" },
                      { text: "Sıfırla", style: "destructive", onPress: () => sifirla.mutate() },
                    ])
                  }
                />
              ) : undefined
            }
          />
        </>
      }
    >
      {items.length > 0 ? (
        <View style={styles.progress}>
          <Progress value={ilerleme} color={color.good} height={6} style={{ flex: 1 }} />
          <Txt v="label" tone="dim" num>
            {formatPercent(ilerleme, 0)}
          </Txt>
        </View>
      ) : null}

      {hata && !orders.data ? (
        <View style={styles.pad}>
          <ErrorState
            error={hata}
            onRetry={() => {
              void orders.refetch();
              void done.refetch();
            }}
            retrying={orders.isFetching}
          />
        </View>
      ) : yukleniyor ? (
        <View style={styles.pad}>
          <ShimmerList count={6} height={76} />
        </View>
      ) : items.length === 0 ? (
        <EmptyState icon="checkmark.circle" title="Hepsi tamam" hint="Gönderilmeyi bekleyen sipariş yok." />
      ) : (
        <FlashList
          data={items}
          keyExtractor={(i) => i.key}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
          renderItem={({ item, index }) => (
            <FadeInView index={index}>
              <PrepRow
                item={item}
                done={doneSet.has(item.key)}
                onToggle={() => toggle.mutate({ key: item.key, isaretle: !doneSet.has(item.key) })}
              />
            </FadeInView>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.lg },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    minHeight: 76, // eldivenli dokunma hedefi
    backgroundColor: color.tintStrong,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  rowDone: { opacity: 0.6, borderColor: color.good + "88" },
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: color.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: color.good, borderColor: color.good },
  photo: { width: 46, height: 46, borderRadius: radius.sm, backgroundColor: color.tint },
  photoBos: { alignItems: "center", justifyContent: "center" },
  info: { flex: 1, gap: 4, minWidth: 0 },
  nameDone: { textDecorationLine: "line-through" },
  meta: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
});
