import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { PrepItem } from "@core/prep-list";
import { AnimatedBar, FadeInView } from "@/components/fade-in";
import { ConnectionError } from "@/components/ConnectionError";
import { ScreenHeader } from "@/components/form";
import { EmptyState, Pill, SkeletonList } from "@/components/ui";
import { PressableScale } from "@/components/ui/PressableScale";
import { getAllOrders, ORDERS_STALE_MS, visibleOrders } from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { clearPrepDone, getPrepDone, setPrepDone } from "@/lib/db/prep";
import { thumbUrl } from "@/lib/image";
import { prepItemsFromOrders } from "@/lib/prep";
import { ML, radius, space, tabular, type } from "@/theme/colors";

/**
 * HAZIRLIK — "bugün rafa gidip neyi kaç adet toplayacağım".
 *
 * NEDEN TELEFONDA: paketleme masa başında değil, rafın önünde yapılıyor. Masaüstünde aynı liste
 * zaten vardı ama kullanıcı elinde ürünle bilgisayara koşuyordu.
 *
 * İŞARETLER ORTAK: `PrepDone` tablosu (şema v46). Masaüstünde işaretlenen ürün burada da
 * işaretli gelir; masada başlayıp atölyede bitirebilirsin.
 *
 * DOKUNUŞ ANINDA DOLAR: kutucuk ağı beklemez (iyimser güncelleme) — elinde kutuyla bekleyen
 * kullanıcı için yarım saniye bile uzun.
 */

function PrepRow({
  item,
  done,
  onToggle,
}: {
  item: PrepItem;
  done: boolean;
  onToggle: () => void;
}) {
  const gorsel = thumbUrl(item.image, 160);
  return (
    <PressableScale
      onPress={onToggle}
      haptic="orta"
      style={[styles.row, done && styles.rowDone]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={`${item.name}, ${item.quantity} adet`}
    >
      <View style={[styles.check, done && styles.checkOn]}>
        {done ? <SymbolView name="checkmark" style={{ width: 15, height: 15 }} tintColor={ML.bg} /> : null}
      </View>

      {gorsel ? (
        <Image source={{ uri: gorsel }} style={styles.photo} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.photo, styles.photoBos]}>
          <SymbolView name="cube.box" style={{ width: 18, height: 18 }} tintColor={ML.textFaint} />
        </View>
      )}

      <View style={styles.info}>
        <Text style={[styles.name, done && styles.nameDone]} numberOfLines={2}>
          {item.name}
        </Text>
        <View style={styles.meta}>
          {item.madeToOrder ? <Pill color={ML.manual}>Sipariş üzerine</Pill> : null}
          <Text style={styles.orders} numberOfLines={1}>
            {item.orderNumbers.length > 2
              ? `${item.orderNumbers.slice(0, 2).join(", ")} +${item.orderNumbers.length - 2}`
              : item.orderNumbers.join(", ")}
          </Text>
        </View>
      </View>

      <Text style={[styles.qty, tabular, done && styles.qtyDone]}>{item.quantity}</Text>
    </PressableScale>
  );
}

export default function HazirlikScreen() {
  const qc = useQueryClient();
  const orders = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
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

  /**
   * İyimser işaretleme: önbellek ANINDA güncellenir, yazma arkada gider. Yazma düşerse
   * önbellek geri alınır — kullanıcı yanlışlıkla "hazırlandı" sanmasın.
   */
  const toggle = useMutation({
    mutationFn: ({ key, isaretle }: { key: string; isaretle: boolean }) => setPrepDone(key, isaretle),
    onMutate: async ({ key, isaretle }) => {
      await qc.cancelQueries({ queryKey: ["prep-done"] });
      const onceki = qc.getQueryData<string[]>(["prep-done"]) ?? [];
      qc.setQueryData<string[]>(
        ["prep-done"],
        isaretle ? [...onceki, key] : onceki.filter((k) => k !== key)
      );
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
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Başlık çubuğu diğer TÜM alt ekranlarla aynı (ScreenHeader): geri oku solda, ad ortada.
          Kendi başlığını yazan tek ekran olmak, uygulamayı derme çatma gösteriyordu. */}
      <ScreenHeader title="Hazırlık" />

      <View style={styles.durum}>
        <Text style={styles.durumText}>
          {yukleniyor
            ? "yükleniyor…"
            : items.length === 0
              ? "hazırlanacak sipariş yok"
              : `${kalan.length} ürün · ${toplamAdet} adet kaldı`}
        </Text>
        {doneSet.size > 0 ? (
          <PressableScale
            onPress={() =>
              Alert.alert("İşaretleri sıfırla", "Tüm hazırlandı işaretleri kaldırılsın mı?", [
                { text: "Vazgeç", style: "cancel" },
                { text: "Sıfırla", style: "destructive", onPress: () => sifirla.mutate() },
              ])
            }
            haptic="orta"
            style={styles.reset}
            accessibilityRole="button"
            accessibilityLabel="İşaretleri sıfırla"
          >
            <SymbolView name="arrow.counterclockwise" style={{ width: 15, height: 15 }} tintColor={ML.textDim} />
            <Text style={styles.resetText}>Sıfırla</Text>
          </PressableScale>
        ) : null}
      </View>

      {items.length > 0 ? (
        <View style={styles.progress}>
          <AnimatedBar percent={Math.round(ilerleme * 100)} color={ML.green} height={6} />
        </View>
      ) : null}

      {hata && !orders.data ? (
        <ConnectionError
          error={hata}
          onRetry={() => {
            void orders.refetch();
            void done.refetch();
          }}
          retrying={orders.isFetching}
        />
      ) : yukleniyor ? (
        <SkeletonList count={6} height={72} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="checkmark.circle"
          title="Hepsi tamam"
          hint="Gönderilmeyi bekleyen sipariş yok."
        />
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  durum: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    paddingHorizontal: 20,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  durumText: { ...type.body, color: ML.textDim, flex: 1 },
  reset: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
  },
  resetText: { ...type.small, color: ML.textDim, fontWeight: "700" },
  progress: { paddingHorizontal: 20, paddingBottom: space.md },
  list: { paddingHorizontal: 20, paddingBottom: space.xl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    minHeight: 72, // eldivenli dokunma hedefi
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
  },
  rowDone: { opacity: 0.55, borderColor: ML.green },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: ML.borderSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: ML.green, borderColor: ML.green },
  photo: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: ML.cardElevated },
  photoBos: { alignItems: "center", justifyContent: "center" },
  info: { flex: 1, gap: 3 },
  name: { ...type.body, color: ML.text, fontWeight: "600" },
  nameDone: { textDecorationLine: "line-through", color: ML.textDim },
  meta: { flexDirection: "row", alignItems: "center", gap: space.xs },
  orders: { ...type.small, color: ML.textFaint, flexShrink: 1 },
  qty: { ...type.title, color: ML.accent },
  qtyDone: { color: ML.textFaint },
});
