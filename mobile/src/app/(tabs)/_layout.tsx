import { NativeTabs } from "expo-router/unstable-native-tabs";

import { ML } from "@/theme/colors";

export default function TabsLayout() {
  return (
    <NativeTabs
      backgroundColor={ML.card}
      labelStyle={{ color: ML.textFaint, selected: { color: ML.accent } }}
      indicatorColor={ML.accentSoft}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Panel</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.bar.fill" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="products">
        <NativeTabs.Trigger.Label>Ürünler</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="shippingbox.fill" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="orders">
        <NativeTabs.Trigger.Label>Siparişler</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bag.fill" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Ayarlar</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape.fill" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
