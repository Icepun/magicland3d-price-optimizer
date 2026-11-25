import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Image } from "expo-image";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { buildFilamentAlerts, filamentAyarlariniCoz, groupSpools } from "@core/filament-groups";
import { getSettingsMap } from "@/lib/db/rules";
import { Pill } from "@/components/kit/Chip";
import {
  Bolum,
  BolumEtiketi,
  Count,
  ErrorState,
  FadeInView,
  Glass,
  Header,
  IkonKutusu,
  PressableScale,
  Progress,
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
import { satirBayatMi } from "@/lib/yazici-tazelik";
import { getSpools } from "@/lib/db/spools";
import { formatNumber } from "@/lib/format";
import { prepItemsFromOrders } from "@/lib/prep";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

/**
 * ATÖLYE — sahada en çok bakılan şeyler tek sekmede: hangi yazıcı ne basıyor, filament var mı,
 * kaç ürün toplanacak. Kısayollar bir dokunuş derinde. Veri katmanı öncekiyle aynı.
 */


/** Tek yazıcı kartı: solda durum renginde çizgi, baskının görseli, durum, iş, ilerleme, kalan süre, ısılar. */
function YaziciKarti({ s, bayat }: { s: PrinterSnapshot; bayat: boolean }) {
  // Satır eskiyse (masaüstü kapalı / uyuyor) durum BİLİNMİYOR: eski "%45 basıyor" canlı gibi gösterilmez.
  const info = bayat ? { label: "Canlı değil", color: color.textFaint } : durumBilgisi(s.status, Boolean(s.online));
  const cevrimdisi = bayat || !s.online || s.status === "offline";
  const aktif = !cevrimdisi && (s.status === "printing" || s.status === "paused");
  const isVar = !cevrimdisi && (aktif || s.status === "finished" || s.status === "error");
  const oran = s.status === "finished" ? 1 : Math.max(0, Math.min(1, s.progress || 0));
  const kalan = aktif ? kalanSure(s.etaSec) : null;
  // Dilimleyicinin plaka önizlemesi (masaüstü R2'ye koyar) varsa o — Bambu işinde tek görsel bu.
  const gorsel = isVar ? (s.detay?.plateUrl ?? (s.productImage ? thumbUrl(s.productImage, 120) : null)) : null;
  return (
    <Glass
      padded={false}
      onPress={() => router.push(`/printer/${s.printerConfigId}` as never)}
      style={[
        styles.printCard,
        // Duraklatılan (sarı) ve duran (gül) yazıcı ilk bakışta ayrılsın — masaüstüyle aynı.
        !cevrimdisi && s.status === "error" ? { borderColor: color.bad, borderWidth: 1.5 } : null,
        !cevrimdisi && s.status === "paused" ? { borderColor: color.warn, borderWidth: 1.5 } : null,
        cevrimdisi ? { opacity: 0.6 } : null,
      ]}
      accessibilityLabel={`${s.name}, ${info.label}${kalan ? `, ${kalan} kaldı` : ""}. Yazıcının ayrıntısını ve kamerasını açar`}
    >
      <View style={[styles.durumCizgisi, { backgroundColor: info.color }]} />
      {gorsel ? (
        <Image source={{ uri: gorsel }} style={styles.gorsel} contentFit="cover" transition={150} recyclingKey={s.printerConfigId} />
      ) : (
        <View style={[styles.gorsel, styles.gorselBos]}>
          <SymbolView name={cevrimdisi ? "wifi.slash" : "printer.fill"} tintColor={info.color} style={{ width: 22, height: 22 }} />
        </View>
      )}
      <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
        <View style={styles.rowBetween}>
          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {s.name}
          </Txt>
          <Pill color={info.color}>{info.label}</Pill>
        </View>
        <Txt v="small" tone="dim" numberOfLines={1}>
          {isVar ? s.productName ?? s.currentFilename ?? "Baskı" : bayat ? "Masaüstü açık mı?" : cevrimdisi ? "Bağlantı yok" : "Yeni baskıya hazır"}
        </Txt>
        {s.statusMessage && (s.status === "error" || s.status === "paused") ? (
          <Txt v="small" tone={s.status === "error" ? "bad" : "warn"} numberOfLines={2}>
            {s.statusMessage}
          </Txt>
        ) : null}
        {aktif ? (
          <View style={styles.ilerlemeSatiri}>
            <Progress value={oran} color={s.status === "paused" ? color.warn : undefined} height={6} style={{ flex: 1 }} />
            <Count value={oran * 100} v="smallStrong" format={(n) => `%${Math.round(n)}`} />
          </View>
        ) : null}
        {!cevrimdisi ? (
          <View style={styles.meta}>
            {kalan ? (
              <View style={styles.metaOge}>
                <SymbolView name="clock" tintColor={color.textFaint} style={styles.metaIkon} />
                <Txt v="label" tone="faint" num>
                  ~{kalan} kaldı
                </Txt>
              </View>
            ) : null}
            <View style={styles.metaOge}>
              <SymbolView name="thermometer.medium" tintColor={color.textFaint} style={styles.metaIkon} />
              <Txt v="label" tone="faint" num>
                {Math.round(s.nozzle)}° / {Math.round(s.bed)}°
              </Txt>
            </View>
          </View>
        ) : null}
      </View>
      <SymbolView name="chevron.right" tintColor={color.textFaint} style={styles.ok} />
    </Glass>
  );
}

/** Üstteki durum şeridi: kaç yazıcı yazdırıyor / duraklatıldı / hazır / hatada (masaüstü renkleriyle). */
function DurumSeridi({ yazicilar, simdi }: { yazicilar: PrinterSnapshot[]; simdi: number }) {
  const canli = yazicilar.filter((s) => s.online && !satirBayatMi(s.updatedAt, simdi));
  const say = (d: string) => canli.filter((s) => s.status === d).length;
  const hucreler: { durum: string; label: string }[] = [
    { durum: "printing", label: "Yazdırıyor" },
    { durum: "paused", label: "Duraklatıldı" },
    { durum: "idle", label: "Hazır" },
    { durum: "error", label: "Hata" },
  ];
  return (
    <View style={styles.serit}>
      {hucreler.map((h) => {
        const renk = durumBilgisi(h.durum, true).color;
        const n = say(h.durum);
        const dikkat = n > 0 && (h.durum === "paused" || h.durum === "error");
        return (
          <Tint key={h.durum} strong style={[styles.seritHucre, dikkat ? { borderColor: renk, borderWidth: 1 } : null]}>
            <View style={styles.rowGap}>
              <View style={[styles.statusDot, { backgroundColor: renk }]} />
              <Txt v="label" tone="faint" numberOfLines={1} style={{ fontSize: 10, flexShrink: 1 }}>
                {h.label}
              </Txt>
            </View>
            <Count value={n} v="heading" />
          </Tint>
        );
      })}
    </View>
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
        <IkonKutusu icon={icon} size={38} />
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
  // 4 sn'de bir — Yazıcılar ekranıyla aynı anahtar ve aralık. Eskiden Atölye hiç yoklamıyordu.
  const printers = useQuery({ queryKey: ["printer-snapshots"], queryFn: getPrinterSnapshots, refetchInterval: 4000 });
  const [simdi, setSimdi] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setSimdi(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const spools = useQuery({ queryKey: ["spools"], queryFn: getSpools });
  // Eşik / susturma / izlenen renkler — zil ve Filament ekranıyla AYNI ayarlar (eskiden hiç okunmuyordu).
  const ayarlar = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { refreshing, onRefresh } = useManualRefresh(async () => {
    await Promise.all([printers.refetch(), spools.refetch()]);
  });

  const snaps = printers.data ?? [];
  const basanlar = snaps.filter((s) => s.online && !satirBayatMi(s.updatedAt, simdi) && (s.status === "printing" || s.status === "paused"));
  // Atölye DÖRT YAZICININ DÖRDÜNÜ gösterir. Bir tur yalnız basan ve hatalı olanlar listeleniyordu;
  // işi biten ya da boştaki yazıcı hiç görünmüyor, "yazıcım nerede" sorusu doğuyordu.
  const yazicilar = yazicilariSirala(snaps);
  const cevrimici = snaps.filter((s) => s.online && !satirBayatMi(s.updatedAt, simdi)).length;

  // Filament uyarıları ortak çekirdekten — zil ve Filament ekranıyla AYNI kural.
  const gruplar = groupSpools(spools.data ?? []);
  const uyarilar = buildFilamentAlerts(gruplar, filamentAyarlariniCoz(ayarlar.data ?? {}));

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
          icon="printer.fill"
          updatedAt={printers.dataUpdatedAt}
          subtitle={
            snaps.length > 0
              ? `${basanlar.length} baskı sürüyor · ${cevrimici}/${snaps.length} yazıcı çevrimiçi`
              : yukleniyor
                ? "yükleniyor…"
                : printers.isError
                  ? "yazıcı bilgisi alınamadı"
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
          {yazicilar.length > 0 ? (
            <FadeInView index={0}>
              <DurumSeridi yazicilar={yazicilar} simdi={simdi} />
            </FadeInView>
          ) : null}
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
          {/* Yazıcılar okunamadıysa "yazıcı yok" denmez — kısa hata + tekrar dene. */}
          {printers.isError && !printers.data ? (
            <ErrorState error={printers.error} onRetry={() => void printers.refetch()} retrying={printers.isFetching} />
          ) : null}
          {yazicilar.map((s, i) => (
            <FadeInView key={s.printerConfigId} index={i}>
              <YaziciKarti s={s} bayat={satirBayatMi(s.updatedAt, simdi)} />
            </FadeInView>
          ))}

          {/* FİLAMENT UYARILARI — "bu baskıyı bitirecek filamentim var mı" sorusu. */}
          {uyarilar.length > 0 ? (
            <FadeInView index={yazicilar.length}>
              <Bolum
                title="Filament uyarıları"
                desc="Makaralar ekranına git"
                icon="exclamationmark.triangle.fill"
                right={<Pill color={uyarilar.some((u) => u.severity === "critical") ? color.bad : color.caution}>{formatNumber(uyarilar.length)}</Pill>}
                onPress={() => router.push("/spools")}
                accessibilityLabel="Filament uyarıları"
              >
                <View style={{ gap: 6 }}>
                  {uyarilar.slice(0, 4).map((u) => (
                    <View key={u.id} style={styles.rowGap}>
                      <View style={[styles.statusDot, { backgroundColor: u.severity === "critical" ? color.bad : color.caution }]} />
                      <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>
                        {u.body}
                      </Txt>
                    </View>
                  ))}
                  {uyarilar.length > 4 ? (
                    <Txt v="small" tone="faint">
                      +{uyarilar.length - 4} tane daha
                    </Txt>
                  ) : null}
                </View>
              </Bolum>
            </FadeInView>
          ) : null}

          <BolumEtiketi>Kısayollar</BolumEtiketi>
          <View style={styles.grid}>
            <Kisayol icon="shippingbox.fill" label="Hazırlık" hint="Toplanacak ürünler" href="/hazirlik" tint={color.accentBright} count={prepKalan} />
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
  gorsel: { width: 56, height: 56, borderRadius: radius.sm },
  gorselBos: { alignItems: "center", justifyContent: "center", backgroundColor: color.tint },
  printCard: { flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.md, paddingLeft: space.md + 4 },
  durumCizgisi: { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 },
  ilerlemeSatiri: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: 2 },
  meta: { flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" },
  metaOge: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaIkon: { width: 12, height: 12 },
  ok: { width: 12, height: 12, alignSelf: "center" },
  serit: { flexDirection: "row", gap: 6 },
  seritHucre: { flex: 1, paddingVertical: space.sm, paddingHorizontal: space.sm, gap: 2 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  rowGap: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  grid: { flexDirection: "row", gap: space.sm },
  shortcut: { flex: 1, gap: 2, padding: space.md, minHeight: 104 },
  shortcutHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm },
  badge: { minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
});
