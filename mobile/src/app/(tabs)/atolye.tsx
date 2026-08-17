import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { buildFilamentAlerts, groupSpools } from "@core/filament-groups";
import { AnimatedBar, AnimatedNumber, FadeInView } from "@/components/fade-in";
import { AppHeader } from "@/components/AppHeader";
import { ConnectionError } from "@/components/ConnectionError";
import { Card, Pill, SectionLabel, SkeletonList } from "@/components/ui";
import { PressableScale } from "@/components/ui/PressableScale";
import { getAllOrders, ORDERS_STALE_MS, visibleOrders } from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getPrepDone } from "@/lib/db/prep";
import { getPrinterSnapshots } from "@/lib/db/printers";
import { prepItemsFromOrders } from "@/lib/prep";
import { getSpools } from "@/lib/db/spools";
import { useManualRefresh } from "@/lib/use-refresh";
import { ML, radius, space, tabular, type } from "@/theme/colors";

/**
 * ATÖLYE — sahada en çok bakılan şeyler TEK sekmede.
 *
 * NEDEN VAR: Yazıcılar, Makaralar, Plan ve Özel Baskılar "Daha" ekranının içinde 2-3 dokunuş
 * derindeydi; masa başı işi olan Raporlar ise tam bir sekme tutuyordu. Kullanıcı telefona gün
 * içinde 20 kez bakıyor ve baktığı şey "ne basılıyor, filamentim var mı" — bu ekran o iki
 * soruyu ilk 3 saniyede cevaplıyor, altındaki kısayollar da derinliği bir dokunuşa indiriyor.
 * (Raporlar sekmeden çıktı ama KAYBOLMADI: "Daha" ekranından açılıyor. Aylık geçmişi yazan
 * senkron da o ekrandan ayrılıp uygulama köküne taşındı — bkz. lib/finance-sync.ts.)
 */

const DURUM: Record<string, { label: string; color: string }> = {
  printing: { label: "Yazdırıyor", color: ML.green },
  paused: { label: "Duraklatıldı", color: ML.orange },
  error: { label: "Hata", color: ML.red },
  finished: { label: "Bitti", color: ML.accent },
  idle: { label: "Boşta", color: ML.textDim },
  offline: { label: "Çevrimdışı", color: ML.textFaint },
};

function Kisayol({
  icon,
  label,
  href,
  tint,
  count,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  href: string;
  tint: string;
  /** Bekleyen iş sayısı (hazırlık listesi) — 0/undefined ise rozet çizilmez. */
  count?: number;
}) {
  return (
    <PressableScale
      onPress={() => router.push(href as never)}
      style={styles.shortcut}
      accessibilityRole="button"
      accessibilityLabel={count ? `${label}, ${count} bekliyor` : label}
    >
      <SymbolView name={icon} tintColor={tint} style={{ width: 22, height: 22 }} />
      <Text style={styles.shortcutText} numberOfLines={1}>
        {label}
      </Text>
      {count ? (
        <View style={[styles.shortcutBadge, { backgroundColor: tint }]}>
          <Text style={styles.shortcutBadgeText}>{count > 99 ? "99+" : count}</Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

export default function AtolyeScreen() {
  const printers = useQuery({ queryKey: ["printer-snapshots"], queryFn: getPrinterSnapshots });
  const spools = useQuery({ queryKey: ["spools"], queryFn: getSpools });
  const { refreshing, onRefresh } = useManualRefresh(async () => {
    await Promise.all([printers.refetch(), spools.refetch()]);
  });

  const snaps = printers.data ?? [];
  const basanlar = snaps.filter((s) => s.status === "printing" || s.status === "paused");
  const sorunlu = snaps.filter((s) => s.status === "error");

  // Filament uyarıları ortak çekirdekten — zil ve Filament ekranıyla AYNI kural.
  const gruplar = groupSpools(spools.data ?? []);
  const uyarilar = buildFilamentAlerts(gruplar);

  /** Hazırlık rozeti: kaç ürün satırı toplanmayı bekliyor (işaretler masaüstüyle ortak). */
  const orders = useQuery({ queryKey: ["orders"], queryFn: getAllOrders, staleTime: ORDERS_STALE_MS });
  const urunler = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const prepDone = useQuery({ queryKey: ["prep-done"], queryFn: getPrepDone });
  const prepKalan = useMemo(() => {
    if (!orders.data) return 0;
    const isaretli = new Set(prepDone.data ?? []);
    return prepItemsFromOrders(visibleOrders(orders.data.orders), urunler.data).filter(
      (i) => !isaretli.has(i.key)
    ).length;
  }, [orders.data, urunler.data, prepDone.data]);

  const hata = printers.error ?? spools.error;
  const yukleniyor = printers.isLoading || spools.isLoading;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader
        title="Atölye"
        updatedAt={printers.dataUpdatedAt}
        subtitle={
          snaps.length > 0
            ? `${basanlar.length} baskı sürüyor · ${snaps.length} yazıcı`
            : yukleniyor
              ? "yükleniyor…"
              : "yazıcı yok"
        }
      />

      {hata && !printers.data && !spools.data ? (
        <ConnectionError
          error={hata}
          onRetry={() => {
            void printers.refetch();
            void spools.refetch();
          }}
          retrying={printers.isFetching || spools.isFetching}
        />
      ) : yukleniyor ? (
        <SkeletonList count={4} height={92} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
        >
          {/* HATA VEREN YAZICI EN ÜSTTE — atölyede en acil bilgi bu. */}
          {sorunlu.map((s, i) => (
            <FadeInView key={s.printerConfigId} index={i}>
              <Card accent={ML.red} onPress={() => router.push("/printers")} style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.printerName}>{s.name}</Text>
                  <Pill color={ML.red}>Hata</Pill>
                </View>
                {s.statusMessage ? (
                  <Text style={styles.reason} numberOfLines={2}>
                    {s.statusMessage}
                  </Text>
                ) : null}
              </Card>
            </FadeInView>
          ))}

          {basanlar.length > 0 ? <SectionLabel>Süren baskılar</SectionLabel> : null}
          {basanlar.map((s, i) => {
            const info = DURUM[s.status] ?? DURUM.idle;
            const pct = Math.round((s.progress || 0) * 100);
            return (
              <FadeInView key={s.printerConfigId} index={i + sorunlu.length}>
                <Card onPress={() => router.push("/printers")} style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.printerName} numberOfLines={1}>
                      {s.name}
                    </Text>
                    <Pill color={info.color}>{info.label}</Pill>
                  </View>
                  <Text style={styles.job} numberOfLines={1}>
                    {s.productName ?? s.currentFilename ?? "Baskı"}
                  </Text>
                  <AnimatedBar percent={pct} color={info.color} height={6} />
                  <AnimatedNumber
                    value={pct}
                    format={(n) => `%${Math.round(n)}`}
                    style={[styles.pct, tabular, { color: info.color }]}
                  />
                </Card>
              </FadeInView>
            );
          })}

          {/* FİLAMENT UYARILARI — "bu baskıyı bitirecek filamentim var mı" sorusu. */}
          {uyarilar.length > 0 ? (
            <>
              <SectionLabel>Filament uyarıları</SectionLabel>
              <Card accent={ML.orange} onPress={() => router.push("/spools")} style={styles.card}>
                {uyarilar.slice(0, 4).map((a) => (
                  <Text key={a.id} style={styles.alert} numberOfLines={1}>
                    • {a.body}
                  </Text>
                ))}
                {uyarilar.length > 4 ? (
                  <Text style={styles.more}>+{uyarilar.length - 4} tane daha</Text>
                ) : null}
              </Card>
            </>
          ) : null}

          <SectionLabel>Kısayollar</SectionLabel>
          <View style={styles.shortcuts}>
            {/* HAZIRLIK en başta: paketleme atölyede yapılıyor ve rozet "kaç ürün toplanacak"
                sorusunu ekranı açmadan cevaplıyor. (Siparişler başlığındaydı; orada + Ekle ve
                zille birlikte başlığı kırpıyordu.) */}
            <Kisayol
              icon="shippingbox.fill"
              label="Hazırlık"
              href="/hazirlik"
              tint={ML.orange}
              count={prepKalan}
            />
            <Kisayol icon="printer.fill" label="Yazıcılar" href="/printers" tint={ML.accent} />
            <Kisayol icon="circle.grid.cross.fill" label="Makaralar" href="/spools" tint={ML.green} />
            <Kisayol icon="list.bullet.rectangle" label="Üretim" href="/planner" tint={ML.orange} />
            <Kisayol icon="tray.full.fill" label="Özel Baskı" href="/custom-prints" tint={ML.manual} />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  // Başlık 4px alt boşluk bırakıyor; eski Atölye başlığı 12 bırakıyordu → farkı burada kapat.
  content: { padding: 20, paddingTop: space.sm, gap: space.md },
  card: { gap: space.sm },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  printerName: { ...type.heading, color: ML.text, flex: 1 },
  job: { ...type.small, color: ML.textDim },
  pct: { ...type.label, alignSelf: "flex-end" },
  reason: { ...type.small, color: ML.red },
  alert: { ...type.body, color: ML.text },
  more: { ...type.small, color: ML.textFaint },
  shortcuts: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  shortcut: {
    flexGrow: 1,
    flexBasis: "47%",
    minHeight: 56, // eldivenli dokunma hedefi
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
  },
  shortcutText: { ...type.body, color: ML.text, fontWeight: "700", flexShrink: 1 },
  shortcutBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },
  shortcutBadgeText: { color: ML.bg, fontSize: 12, fontWeight: "800" },
});
