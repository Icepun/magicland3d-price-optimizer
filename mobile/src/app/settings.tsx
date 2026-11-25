import { useQuery } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { StyleSheet, View } from "react-native";

import { FadeInView, IkonKutusu, Screen, SubHeader, Tint, Txt } from "@/components/kit";
import { getSettingsMap } from "@/lib/db/rules";
import { formatCurrency } from "@/lib/format";
import { resolveVatRate } from "@/core/vat";
import { color, radius, space } from "@/theme/tokens";

/**
 * KURALLAR — komisyon, kargo, gider kuralları ve reklam bütçesi (menüden açılır).
 * Genel ayarlar (KDV, saatlik maliyetler) telefonda YALNIZ görüntülenir; düzenleme masaüstünde
 * (kullanıcı kararı, Eylül 2026: "ayarlar sekmesine gerek yok").
 */
const NAV: { label: string; hint: string; href: Href; icon: SymbolViewProps["name"]; tint: string }[] = [
  { label: "Komisyon kuralları", hint: "Platform ve kategori komisyonları", href: "/rules/commission", icon: "percent", tint: color.accentBright },
  { label: "Kargo kuralları", hint: "Desi baremleri ve tarife dönemleri", href: "/rules/cargo", icon: "shippingbox.fill", tint: color.info },
  { label: "Sipariş gider kuralları", hint: "Hizmet bedeli, paketleme, sabit giderler", href: "/rules/expense", icon: "list.bullet.rectangle", tint: color.warn },
  { label: "Reklam bütçesi", hint: "Platform bazlı, dönemli reklam payı", href: "/rules/ad-budget", icon: "megaphone.fill", tint: color.manual },
];

/** Ayar metni ("4.6") → "₺4,60"; okunamazsa "—". */
function tl(deger: string | null | undefined): string {
  if (deger == null || deger === "") return formatCurrency(0);
  const n = Number(String(deger).replace(",", "."));
  return Number.isFinite(n) ? formatCurrency(n) : "—";
}

export default function SettingsScreen() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const vat = resolveVatRate(settings);
  const rows: { label: string; value: string }[] = [
    // Hesapla AYNI kural: geçersiz/boş oran %20 sayılır — kart da bunu söylesin.
    { label: "KDV oranı", value: settings ? (vat.invalid ? `%${vat.rate} (okunamadı)` : `%${vat.rate}`) : "—" },
    { label: "Shopify komisyon", value: `%${settings?.shopifyCommissionRate ?? "3.2"}` },
    { label: "İndirim payı", value: `%${settings?.discountBuffer ?? "0"}` },
    {
      label: "Elektrik / saat",
      value: settings?.costElectricityIncluded === "true" ? `${tl(settings?.costElectricityPerHour)} · dahil` : "Dahil değil",
    },
    // Asıl dolu oran — eskiden kartta hiç yoktu (denetim, 23 Kas 2026).
    { label: "Makine aşınması / saat", value: tl(settings?.costMachineWearPerHour) },
    { label: "İşçilik / saat", value: tl(settings?.costLaborPerHour) },
  ];

  return (
    <Screen header={<SubHeader title="Kurallar" subtitle="Masaüstüyle aynı veritabanı" />}>
      <FadeInView index={0}>
        <View style={{ gap: space.sm }}>
          {NAV.map((n) => (
            <Tint key={n.label} strong onPress={() => router.push(n.href)} style={styles.row} accessibilityLabel={n.label}>
              <IkonKutusu icon={n.icon} size={40} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt v="bodyStrong" numberOfLines={1}>
                  {n.label}
                </Txt>
                <Txt v="small" tone="dim" numberOfLines={1}>
                  {n.hint}
                </Txt>
              </View>
              <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
            </Tint>
          ))}
        </View>
      </FadeInView>

      <Txt v="label" tone="faint" style={styles.section}>
        FİNANS
      </Txt>
      <FadeInView index={1}>
        <Tint strong onPress={() => router.push("/expenses")} style={styles.row} accessibilityLabel="Gider ödemeleri">
          <IkonKutusu icon="creditcard.fill" size={40} />
          <View style={{ flex: 1 }}>
            <Txt v="bodyStrong">Gider ödemeleri</Txt>
            <Txt v="small" tone="dim">
              Ödediğin genel giderler
            </Txt>
          </View>
          <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
        </Tint>
      </FadeInView>

      <Txt v="label" tone="faint" style={styles.section}>
        HESAP PARAMETRELERİ · MASAÜSTÜNDEN DÜZENLENİR
      </Txt>
      <FadeInView index={2}>
        <Tint strong padded={false} style={styles.paramCard}>
          {rows.map((r, i) => (
            <View key={r.label} style={[styles.param, i > 0 ? styles.paramBorder : null]}>
              <Txt v="body" tone="dim">
                {r.label}
              </Txt>
              <Txt v="bodyStrong" num>
                {r.value}
              </Txt>
            </View>
          ))}
        </Tint>
      </FadeInView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  icon: { width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  paramCard: { paddingHorizontal: space.lg },
  param: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: space.md, gap: space.sm },
  paramBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
});
