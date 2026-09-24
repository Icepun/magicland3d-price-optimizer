import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Image } from "expo-image";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { buildFilamentAlerts, groupSpools } from "@core/filament-groups";
import { Pill } from "@/components/kit/Chip";
import {
  Count,
  ErrorState,
  FadeInView,
  Glass,
  Header,
  PressableScale,
  Progress,
  Ring,
  Screen,
  ShimmerCard,
  Tint,
  Txt,
} from "@/components/kit";
import { getAllOrders, ORDERS_STALE_MS, visibleOrders } from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getPrepDone } from "@/lib/db/prep";
import { getPrinterSnapshots, type PrinterSnapshot } from "@/lib/db/printers";
import { thumbUrl } from "@/lib/image";
import { durumBilgisi, kalanSure, yazicilariSirala } from "@/lib/yazici-durum";
import { getSpools } from "@/lib/db/spools";
import { formatNumber } from "@/lib/format";
import { prepItemsFromOrders } from "@/lib/prep";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

/**
 * ATÖLYE — sahada en çok bakılan şeyler tek sekmede: hangi yazıcı ne basıyor, filament var mı,
 * kaç ürün toplanacak. Kısayollar bir dokunuş derinde. Veri katmanı öncekiyle aynı.
 */


/** Tek yazıcı kartı: görsel (ilerleme halkasında baskının resmi), durum, iş, kalan süre, ısılar. */
function YaziciKarti({ s }: { s: PrinterSnapshot }) {
  const info = durumBilgisi(s.status, Boolean(s.online));
  const cevrimdisi = !s.online || s.status === "offline";
  const aktif = !cevrimdisi && (s.status === "printing" || s.status === "paused");
  const isVar = !cevrimdisi && (aktif || s.status === "finished" || s.status === "error");
  const oran = s.status === "finished" ? 1 : Math.max(0, Math.min(1, s.progress || 0));
  const kalan = aktif ? kalanSure(s.etaSec) : null;
  // Dilimleyicinin plaka önizlemesi (masaüstü R2'ye koyar) varsa o — Bambu işinde tek görsel bu.
  const gorsel = isVar ? (s.detay?.plateUrl ?? (s.productImage ? thumbUrl(s.productImage, 120) : null)) : null;
  return (
    <Glass
      strong={s.status === "error"}
      onPress={() => router.push(`/printer/${s.printerConfigId}` as never)}
      style={[styles.printCard, s.status === "error" ? { borderColor: color.bad + "88" } : null, cevrimdisi ? { opacity: 0.6 } : null]}
      accessibilityLabel={`${s.name}, ${info.label}${kalan ? `, ${kalan} kaldı` : ""}. Yazıcının ayrıntısını ve kamerasını açar`}
    >
      <Ring value={isVar ? oran : 0} size={60} stroke={5} color={info.color}>
        {gorsel ? (
          <Image source={{ uri: gorsel }} style={styles.gorsel} contentFit="cover" transition={150} recyclingKey={s.printerConfigId} />
        ) : aktif ? (
          <Count value={oran * 100} v="label" format={(n) => `%${Math.round(n)}`} />
        ) : (
          <SymbolView name="printer.fill" tintColor={info.color} style={{ width: 22, height: 22 }} />
        )}
      </Ring>
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <View style={styles.rowBetween}>
          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {s.name}
          </Txt>
          <Pill color={info.color}>{info.label}</Pill>
        </View>
        <Txt v="small" tone="dim" numberOfLines={1}>
          {isVar ? s.productName ?? s.currentFilename ?? "Baskı" : cevrimdisi ? "Bağlantı yok" : "Yeni baskıya hazır"}
        </Txt>
        {s.statusMessage && (s.status === "error" || s.status === "paused") ? (
          <Txt v="small" tone={s.status === "error" ? "bad" : "warn"} numberOfLines={2}>
            {s.statusMessage}
          </Txt>
        ) : null}
        {aktif ? <Progress value={oran} color={info.color} height={4} style={{ marginTop: 2 }} /> : null}
        {!cevrimdisi ? (
          <Txt v="label" tone="faint" num numberOfLines={1}>
            {[aktif ? `%${Math.round(oran * 100)}` : null, kalan ? `~${kalan} kaldı` : null, `${Math.round(s.nozzle)}° / ${Math.round(s.bed)}°`]
              .filter(Boolean)
              .join(" · ")}
          </Txt>
        ) : null}
      </View>
      <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 12, height: 12 }} />
    </Glass>
  );
}

function Kisayol({
  icon,
  label,
  hint,
  href,
  tint,
  count,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  hint: string;
  href: string;
  tint: string;
  count?: number;
}) {
  return (
    <Tint
      strong
      onPress={() => router.push(href as never)}
      style={styles.shortcut}
      accessibilityLabel={count ? `${label}, ${count} bekliyor` : label}
    >
      <View style={styles.shortcutHead}>
        <View style={[styles.shortcutIcon, { backgroundColor: tint + "26" }]}>
          <SymbolView name={icon} tintColor={tint} style={{ width: 20, height: 20 }} />
        </View>
        {count ? (
          <View style={[styles.badge, { backgroundColor: tint }]}>
            <Txt v="label" style={{ color: color.bg0 }} num>
              {count > 99 ? "99+" : count}
            </Txt>
          </View>
        ) : null}
      </View>
      <Txt v="bodyStrong" numberOfLines={1}>
        {label}
      </Txt>
      <Txt v="small" tone="faint" numberOfLines={1}>
        {hint}
      </Txt>
    </Tint>
  );
}

export default function AtolyeScreen() {
  const printers = useQuery({ queryKey: ["printer-snapshots"], queryFn: getPrinterSnapshots });
  const spools = useQuery({ queryKey: ["spools"], queryFn: getSpools });
  const { refreshing, onRefresh } = useManualRefresh(async () => {
    await Promise.all([printers.refetch(), spools.refetch()]);
  });

  const snaps = printers.data ?? [];
  const basanlar = snaps.filter((s) => s.online && (s.status === "printing" || s.status === "paused"));
  // Atölye DÖRT YAZICININ DÖRDÜNÜ gösterir. Bir tur yalnız basan ve hatalı olanlar listeleniyordu;
  // işi biten ya da boştaki yazıcı hiç görünmüyor, "yazıcım nerede" sorusu doğuyordu.
  const yazicilar = yazicilariSirala(snaps);
  const cevrimici = snaps.filter((s) => s.online).length;

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
    return prepItemsFromOrders(visibleOrders(orders.data.orders), urunler.data).filter((i) => !isaretli.has(i.key)).length;
  }, [orders.data, urunler.data, prepDone.data]);

  const hata = printers.error ?? spools.error;
  const yukleniyor = printers.isLoading || spools.isLoading;

  return (
    <Screen
      header={
        <Header
          title="Atölye"
          updatedAt={printers.dataUpdatedAt}
          subtitle={
            snaps.length > 0
              ? `${basanlar.length} baskı sürüyor · ${cevrimici}/${snaps.length} yazıcı çevrimiçi`
              : yukleniyor
                ? "yükleniyor…"
                : "yazıcı yok"
          }
        />
      }
      refreshing={refreshing}
      onRefresh={onRefresh}
    >
      {hata && !printers.data && !spools.data ? (
        <ErrorState
          error={hata}
          onRetry={() => {
            void printers.refetch();
            void spools.refetch();
          }}
          retrying={printers.isFetching || spools.isFetching}
        />
      ) : yukleniyor ? (
        <>
          <ShimmerCard height={104} />
          <ShimmerCard height={104} delay={80} />
          <View style={styles.grid}>
            <ShimmerCard height={112} delay={160} style={{ flex: 1 }} />
            <ShimmerCard height={112} delay={220} style={{ flex: 1 }} />
          </View>
        </>
      ) : (
        <>
          {/* YAZICILAR — hepsi, en acil üstte. Başlık ve her kart yazıcı ekranına götürdüğünü
              açıkça söyler (sağda ok + "Tümü"); bir tur dokunulabilir olduğu hiç belli değildi. */}
          {yazicilar.length > 0 ? (
            <PressableScale
              onPress={() => router.push("/printers")}
              style={styles.bolumBaslik}
              accessibilityRole="link"
              accessibilityLabel="Tüm yazıcılar"
            >
              <Txt v="label" tone="faint" style={styles.section}>
                YAZICILAR · {yazicilar.length}
              </Txt>
              <View style={styles.rowGap}>
                <Txt v="smallStrong" tone="accent">
                  Tümü
                </Txt>
                <SymbolView name="chevron.right" tintColor={color.accentBright} style={{ width: 11, height: 11 }} />
              </View>
            </PressableScale>
          ) : null}
          {yazicilar.map((s, i) => (
            <FadeInView key={s.printerConfigId} index={i}>
              <YaziciKarti s={s} />
            </FadeInView>
          ))}

          {/* FİLAMENT UYARILARI — "bu baskıyı bitirecek filamentim var mı" sorusu. */}
          {uyarilar.length > 0 ? (
            <FadeInView index={yazicilar.length}>
              <Tint strong onPress={() => router.push("/spools")} style={styles.card} accessibilityLabel="Filament uyarıları">
                <View style={styles.rowBetween}>
                  <View style={styles.rowGap}>
                    <SymbolView name="exclamationmark.triangle.fill" tintColor={color.warn} style={{ width: 16, height: 16 }} />
                    <Txt v="label" tone="warn" style={{ letterSpacing: 1 }}>
                      FİLAMENT UYARILARI
                    </Txt>
                  </View>
                  <Pill color={color.warn}>{formatNumber(uyarilar.length)}</Pill>
                </View>
                {uyarilar.slice(0, 4).map((a) => (
                  <Txt key={a.id} v="body" numberOfLines={1}>
                    • {a.body}
                  </Txt>
                ))}
                {uyarilar.length > 4 ? (
                  <Txt v="small" tone="faint">
                    +{uyarilar.length - 4} tane daha
                  </Txt>
                ) : null}
              </Tint>
            </FadeInView>
          ) : null}

          <Txt v="label" tone="faint" style={styles.section}>
            KISAYOLLAR
          </Txt>
          <View style={styles.grid}>
            <Kisayol icon="shippingbox.fill" label="Hazırlık" hint="Toplanacak ürünler" href="/hazirlik" tint={color.warn} count={prepKalan} />
            <Kisayol icon="printer.fill" label="Yazıcılar" hint="Canlı durum · kontrol" href="/printers" tint={color.accentBright} />
          </View>
          <View style={styles.grid}>
            <Kisayol icon="circle.grid.cross.fill" label="Makaralar" hint="Filament stoğu" href="/spools" tint={color.good} />
            <Kisayol icon="list.bullet.rectangle" label="Üretim" hint="Baskı planı" href="/planner" tint={color.info} />
          </View>
          <View style={styles.grid}>
            <Kisayol icon="tray.full.fill" label="Özel baskı" hint="Yüklenen dosyalar" href="/custom-prints" tint={color.manual} />
            <Kisayol icon="creditcard.fill" label="Giderler" hint="Gider ödemeleri" href="/expenses" tint={color.textDim} />
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bolumBaslik: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: space.xs, minHeight: 32 },
  gorsel: { width: 46, height: 46, borderRadius: 23 },
  card: { gap: space.sm },
  printCard: { flexDirection: "row", alignItems: "center", gap: space.md },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  rowGap: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  grid: { flexDirection: "row", gap: space.sm },
  shortcut: { flex: 1, gap: 2, padding: space.md, minHeight: 104 },
  shortcutHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm },
  shortcutIcon: { width: 38, height: 38, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  badge: { minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
});
