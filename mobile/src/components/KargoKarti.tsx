import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Share, StyleSheet, View } from "react-native";

import { ETIKET_ISTEGI_OMRU_MS } from "@core/etiket-uygunluk";
import { KARGO_DURUM_ETIKETI, type KargoDurumu, type KargoGonderiOzeti } from "@core/kargo-gonderisi";
import { Bolum, Button, FadeInView, PressableScale, Txt } from "@/components/kit";
import type { UnifiedOrder } from "@/lib/api/orders";
import { etiketIstegiGonder, etiketIstegiIptal, etiketIstegiOku } from "@/lib/db/etiket";
import { basilabilirEtiketAnahtari } from "@/lib/etiket";
import { formatDateTime } from "@/lib/format";
import { color, space } from "@/theme/tokens";

/** Masaüstü bu süre içinde almazsa kullanıcıya "açık mı?" diye sorulur (istek ömrü dolmadan). */
const GECIKME_MS = 20_000;

/**
 * KARGO KARTI — sipariş detayında kargo firması, takip numarası ve "Etiketi yazdır".
 *
 * Etiketi telefon basmaz: istek veritabanına yazılır, etiket yazıcısı bağlı masaüstü basar
 * (masaüstü `lib/etiket/telefon-istekleri`). Kart isteği izler: gönderildi → basılıyor → basıldı.
 * Takip numarasına dokununca paylaşım sayfası açılır ("Kopyala" orada); basılı tutunca da seçilir.
 */
export function KargoKarti({ order, basildiAt }: { order: UnifiedOrder; basildiAt?: number }) {
  const anahtar = basilabilirEtiketAnahtari(order);
  // Shopify firmayı bilmediğinde "Other" gönderir — anlamsız İngilizce kelime gösterilmez.
  const firma = order.cargoProvider && order.cargoProvider !== "Other" ? order.cargoProvider : null;
  if (order.isManual || (!firma && !order.trackingNumber && !anahtar)) return null;
  return (
    <Bolum title="Kargo" desc={firma ?? undefined} icon="shippingbox.fill">
      <View style={styles.kart}>
      {order.trackingNumber ? (
        <PressableScale
          onPress={() => void Share.share({ message: order.trackingNumber ?? "" }).catch(() => {})}
          style={styles.satir}
          accessibilityRole="button"
          accessibilityLabel={`Takip numarası ${order.trackingNumber}, paylaş veya kopyala`}
        >
          <SymbolView name="barcode" tintColor={color.textFaint} style={styles.ikon} />
          <View style={{ flex: 1 }}>
            <Txt v="label" tone="faint">
              Takip no
            </Txt>
            <Txt v="bodyStrong" num selectable numberOfLines={1}>
              {order.trackingNumber}
            </Txt>
          </View>
          <SymbolView name="square.and.arrow.up" tintColor={color.accentBright} style={styles.ikon} />
        </PressableScale>
      ) : (
        <Txt v="small" tone="faint">
          Takip numarası yok
        </Txt>
      )}
      {order.kargoGonderisi ? <HepsijetDurumu g={order.kargoGonderisi} /> : null}
      {anahtar && (order.platform === "trendyol" || order.platform === "hepsiburada" || order.platform === "shopify") ? (
        <EtiketDugmesi order={order} platform={order.platform} anahtar={anahtar} basildiAt={basildiAt} />
      ) : null}
      </View>
    </Bolum>
  );
}

const DURUM_RENGI: Record<KargoDurumu, string> = {
  olusturuldu: "#7DD3FC",
  yolda: "#A5B4FC",
  dagitimda: "#C4B5FD",
  teslim: color.good,
  sorun: color.bad,
  iade: color.warn,
  iptal: color.textFaint,
};

/** Masaüstünden açılan HepsiJet gönderisi: durum, Shopify işareti, hareketler (masaüstüyle aynı bilgi). */
function HepsijetDurumu({ g }: { g: KargoGonderiOzeti }) {
  const [acik, setAcik] = useState(false);
  const renk = DURUM_RENGI[g.durum];
  const shopify =
    g.ortam === "test"
      ? "Test gönderisi · Shopify'a yazılmaz"
      : g.shopifyTeslim
        ? `Shopify'da teslim edildi · ${formatDateTime(g.shopifyTeslim)}`
        : g.shopifyGonderildi
          ? `Shopify'da gönderildi · ${formatDateTime(g.shopifyGonderildi)}`
          : g.durum === "iptal"
            ? null
            : (g.shopifyHata ?? "Kurye alınca Shopify'da gönderildi işaretlenecek");
  return (
    <FadeInView style={styles.hj}>
      <View style={styles.satir}>
        <View style={[styles.nokta, { backgroundColor: renk }]} />
        <Txt v="bodyStrong" style={{ color: renk, flex: 1 }} numberOfLines={1}>
          {KARGO_DURUM_ETIKETI[g.durum]}
          {g.ortam === "test" ? " · test" : ""}
        </Txt>
      </View>
      {g.durum !== "iptal" && g.metin !== KARGO_DURUM_ETIKETI[g.durum] ? (
        <Txt v="small" tone="dim">
          {g.metin}
        </Txt>
      ) : null}
      {shopify ? (
        <Txt v="small" tone={g.shopifyHata && !g.shopifyGonderildi ? "warn" : "faint"}>
          {shopify}
        </Txt>
      ) : null}
      {g.olaylar.length > 0 ? (
        <PressableScale
          onPress={() => setAcik((v) => !v)}
          style={styles.satir}
          accessibilityRole="button"
          accessibilityLabel={acik ? "Hareketleri gizle" : "Hareketleri göster"}
        >
          <SymbolView name={acik ? "chevron.up" : "chevron.down"} tintColor={color.textFaint} style={styles.ikon} />
          <Txt v="small" tone="faint">
            Hareketler ({g.olaylar.length})
          </Txt>
        </PressableScale>
      ) : null}
      {acik
        ? [...g.olaylar].reverse().map((o, i) => (
            <FadeInView key={`${o.an}-${i}`} index={i} style={styles.olay}>
              <View style={[styles.olayNokta, { backgroundColor: i === 0 ? renk : color.lineStrong }]} />
              <View style={{ flex: 1 }}>
                <Txt v="small">{o.metin}</Txt>
                <Txt v="small" tone="faint" num>
                  {formatDateTime(o.an)}
                </Txt>
              </View>
            </FadeInView>
          ))
        : null}
    </FadeInView>
  );
}

function EtiketDugmesi({
  order,
  platform,
  anahtar,
  basildiAt,
}: {
  order: UnifiedOrder;
  platform: "trendyol" | "hepsiburada" | "shopify";
  anahtar: string;
  basildiAt?: number;
}) {
  const qc = useQueryClient();
  const [istekId, setIstekId] = useState<string | null>(null);

  const gonder = useMutation({
    mutationFn: () =>
      etiketIstegiGonder({
        platform,
        orderNumber: order.orderNumber,
        labelKey: anahtar,
        // Shopify: masaüstü etiketi HepsiJet barkoduyla basar (Shopify'daki takip no başka olabilir).
        trackingNumber: platform === "shopify" ? anahtar : (order.trackingNumber ?? null),
        packageNumber: order.packageNumber ?? null,
      }),
    onSuccess: (id) => setIstekId(id),
  });

  const istekQ = useQuery({
    queryKey: ["etiket-istegi", istekId],
    queryFn: () => etiketIstegiOku(istekId ?? ""),
    enabled: istekId != null,
    // Sonuçlanana kadar sık bak; ömrü dolan bekleyen istekte dur (masaüstü onu artık basmaz).
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return 1500;
      if (d.status === "running") return 1500;
      if (d.status === "pending") return q.state.dataUpdatedAt - d.createdAtMs > ETIKET_ISTEGI_OMRU_MS ? false : 1500;
      return false;
    },
  });
  const istek = istekQ.data ?? null;
  const yas = istek ? istekQ.dataUpdatedAt - istek.createdAtMs : 0;

  const iptal = useMutation({
    mutationFn: () => etiketIstegiIptal(istekId ?? ""),
    onSettled: () => void istekQ.refetch(),
  });

  // Basılınca: titreşim + "basıldı" listesi tazelensin (liste ve detaydaki işaret).
  const durum = istek?.status;
  useEffect(() => {
    if (durum === "done") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void qc.invalidateQueries({ queryKey: ["etiket-basilanlar"] });
    } else if (durum === "error") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    }
  }, [durum, qc]);

  const yazdir = () => {
    const once = istek?.status === "done" ? istek.createdAtMs : basildiAt;
    if (once) {
      Alert.alert("Etiket tekrar basılsın mı?", `Bu etiket ${formatDateTime(once)} basıldı.`, [
        { text: "Vazgeç", style: "cancel" },
        { text: "Tekrar bas", onPress: () => gonder.mutate() },
      ]);
      return;
    }
    gonder.mutate();
  };

  // Görünüm: istek yoksa düğme; varsa durumunu anlatan satır.
  const bekliyor = istek?.status === "pending";
  const omurDoldu = bekliyor && yas > ETIKET_ISTEGI_OMRU_MS;
  const gecikti = bekliyor && !omurDoldu && yas > GECIKME_MS;

  if (gonder.isPending || (istekId && !istek) || (bekliyor && !gecikti && !omurDoldu)) {
    return <Durum spinner metin="Masaüstüne gönderildi…" />;
  }
  if (gecikti) {
    return (
      <FadeInView style={{ gap: space.sm }}>
        <Durum spinner metin="Masaüstü henüz almadı. Uygulama açık ve etiket yazıcısı seçili mi?" ton="warn" />
        <Button label="Vazgeç" size="sm" variant="secondary" onPress={() => iptal.mutate()} loading={iptal.isPending} />
      </FadeInView>
    );
  }
  if (istek?.status === "running") {
    return <Durum spinner metin={istek.printedBy ? `Basılıyor · ${istek.printedBy}` : "Basılıyor…"} />;
  }

  const hata =
    gonder.error instanceof Error
      ? gonder.error.message
      : omurDoldu
        ? "Masaüstü kapalıydı, etiket basılmadı."
        : istek?.status === "error"
          ? (istek.error ?? "Etiket basılamadı.")
          : null;
  const basildi = istek?.status === "done" ? istek.createdAtMs : basildiAt;

  return (
    <View style={{ gap: space.sm }}>
      {hata ? <Durum metin={hata} ton="bad" ikon="exclamationmark.triangle.fill" /> : null}
      {!hata && basildi ? (
        <Durum
          metin={istek?.status === "done" ? "Etiket basıldı" : `Etiket basıldı · ${formatDateTime(basildi)}`}
          ton="good"
          ikon="checkmark.circle.fill"
        />
      ) : null}
      <Button
        label={hata ? "Tekrar dene" : basildi ? "Tekrar yazdır" : "Etiketi yazdır"}
        icon="printer.fill"
        size="sm"
        variant={basildi && !hata ? "secondary" : "primary"}
        onPress={yazdir}
        style={{ alignSelf: "flex-start" }}
      />
    </View>
  );
}

function Durum({
  metin,
  ton = "dim",
  spinner,
  ikon,
}: {
  metin: string;
  ton?: "dim" | "warn" | "bad" | "good";
  spinner?: boolean;
  ikon?: "exclamationmark.triangle.fill" | "checkmark.circle.fill";
}) {
  const renk = ton === "warn" ? color.warn : ton === "bad" ? color.bad : ton === "good" ? color.good : color.textDim;
  return (
    <FadeInView style={styles.durum}>
      {spinner ? <ActivityIndicator size="small" color={renk} /> : null}
      {ikon ? <SymbolView name={ikon} tintColor={renk} style={styles.ikon} /> : null}
      <Txt v="small" tone={ton} style={{ flex: 1 }}>
        {metin}
      </Txt>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  kart: { gap: space.md },
  etiket: { letterSpacing: 1 },
  satir: { flexDirection: "row", alignItems: "center", gap: space.md },
  ikon: { width: 16, height: 16 },
  durum: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 24 },
  hj: { gap: space.xs, paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  nokta: { width: 8, height: 8, borderRadius: 4 },
  olay: { flexDirection: "row", gap: space.sm, paddingLeft: space.xs },
  olayNokta: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
});
