import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { FreshnessStamp } from "@/components/FreshnessStamp";
import { IkonKutusu, Tint } from "@/components/kit/Glass";
import { IconButton } from "@/components/kit/IconButton";
import { Sheet } from "@/components/kit/Sheet";
import { Txt } from "@/components/kit/Txt";
import { getNotifications } from "@/lib/db/notifications";
import { color, space } from "@/theme/tokens";

/**
 * EKRAN BAŞLIĞI — masaüstündeki sayfa başlığı: mor→mavi geçişli ikon kutusu + büyük başlık + alt
 * satırda yeşil noktalı tazelik ("2 dk önce güncellendi"). Sağda ekrana özel düğme, zil ve menü
 * (Raporlar, Hızlı hesap, Bildirimler, Kurallar menüden de açılır) — her sekmede aynı yerde.
 */
export function Header({
  title,
  subtitle,
  updatedAt,
  right,
  icon = "sparkles",
  bell = true,
  menu = true,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Ekrandaki ana verinin çekilme anı (React Query `dataUpdatedAt`). */
  updatedAt?: number;
  /** Ekrana özel düğme(ler) — zilin solunda. */
  right?: ReactNode;
  /** Başlıktaki ikon kutusunun SF Symbol'ü. */
  icon?: SymbolViewProps["name"];
  bell?: boolean;
  menu?: boolean;
  /** Eski çağıranlar için duruyor (marka satırı kalktı). */
  brand?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <IkonKutusu icon={icon} size={44} dolu />
      <View style={styles.titleBlock}>
        <Txt v="title" numberOfLines={1}>
          {title}
        </Txt>
        <View style={styles.subRow}>
          {updatedAt ? <View style={styles.canli} /> : null}
          {typeof subtitle === "string" ? (
            <Txt v="small" tone="dim" numberOfLines={1} style={{ flexShrink: 1 }}>
              {subtitle}
            </Txt>
          ) : (
            subtitle
          )}
          {updatedAt ? (
            <>
              {subtitle ? (
                <Txt v="small" tone="faint">
                  ·
                </Txt>
              ) : null}
              <FreshnessStamp updatedAt={updatedAt} suffix={!subtitle} />
            </>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        {right}
        {bell ? <Bell /> : null}
        {menu ? <MenuButton /> : null}
      </View>
    </View>
  );
}

/** Zil + okunmamış rozeti — masaüstü ziliyle AYNI kaynaktan (Notification tablosu + anlık kurallar). */
export function Bell() {
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });
  const toplam = data?.counts.total ?? 0;
  const kritik = (data?.counts.critical ?? 0) > 0;
  return (
    <IconButton
      icon="bell.fill"
      size={36}
      tint={toplam > 0 ? color.text : color.textDim}
      badge={toplam}
      badgeColor={kritik ? color.bad : color.warn}
      onPress={() => router.push("/notifications" as never)}
      accessibilityLabel={toplam > 0 ? `Bildirimler, ${toplam} uyarı` : "Bildirimler"}
    />
  );
}

const MENU: { icon: SymbolViewProps["name"]; title: string; hint: string; href: string; tint: string }[] = [
  { icon: "chart.pie.fill", title: "Raporlar", hint: "Aylık ciro, kâr ve ürün kırılımı", href: "/reports", tint: color.accentBright },
  { icon: "function", title: "Hızlı hesap", hint: "Ürünü kaydetmeden fiyat ve kâr dene", href: "/hizli-hesap", tint: color.good },
  { icon: "bell.fill", title: "Bildirimler", hint: "Stok, filament ve yazıcı uyarıları", href: "/notifications", tint: color.warn },
  { icon: "slider.horizontal.3", title: "Kurallar", hint: "Komisyon, kargo, gider, reklam bütçesi", href: "/settings", tint: color.info },
];

/** Menü düğmesi + alttan açılan menü sayfası. */
export function MenuButton() {
  const sheet = useRef<BottomSheetModal>(null);
  return (
    <>
      <IconButton icon="line.3.horizontal" size={36} onPress={() => sheet.current?.present()} accessibilityLabel="Menü" />
      <Sheet ref={sheet}>
        <Txt v="label" tone="faint" style={styles.menuLabel}>
          MENÜ
        </Txt>
        <View style={{ gap: space.sm }}>
          {MENU.map((m) => (
            <Tint
              key={m.href}
              strong
              onPress={() => {
                sheet.current?.dismiss();
                router.push(m.href as never);
              }}
              style={styles.menuRow}
              accessibilityLabel={m.title}
            >
              <View style={[styles.menuIcon, { backgroundColor: m.tint + "26" }]}>
                <SymbolView name={m.icon} tintColor={m.tint} style={{ width: 20, height: 20 }} />
              </View>
              <View style={{ flex: 1 }}>
                <Txt v="bodyStrong">{m.title}</Txt>
                <Txt v="small" tone="dim" numberOfLines={1}>
                  {m.hint}
                </Txt>
              </View>
              <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
            </Tint>
          ))}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: 6 },
  titleBlock: { flex: 1, minWidth: 0, gap: 1 },
  subRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  canli: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.good },
  menuLabel: { marginBottom: space.md, letterSpacing: 1.2 },
  menuRow: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  menuIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
