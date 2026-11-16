import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Share, StyleSheet, View } from "react-native";

import { ETIKET_ISTEGI_OMRU_MS } from "@core/etiket-uygunluk";
import { Button, FadeInView, PressableScale, Tint, Txt } from "@/components/kit";
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
    <Tint strong style={styles.kart}>
      <Txt v="label" tone="faint" style={styles.etiket}>
        KARGO
      </Txt>
      {firma ? (
        <View style={styles.satir}>
          <SymbolView name="shippingbox" tintColor={color.textFaint} style={styles.ikon} />
          <Txt v="body" style={{ flex: 1 }} numberOfLines={1}>
            {firma}
          </Txt>
        </View>
      ) : null}
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
      {anahtar && (order.platform === "trendyol" || order.platform === "hepsiburada") ? (
        <EtiketDugmesi order={order} platform={order.platform} anahtar={anahtar} basildiAt={basildiAt} />
      ) : null}
    </Tint>
  );
}

function EtiketDugmesi({
  order,
  platform,
  anahtar,
  basildiAt,
}: {
  order: UnifiedOrder;
  platform: "trendyol" | "hepsiburada";
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
        trackingNumber: order.trackingNumber ?? null,
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
});
