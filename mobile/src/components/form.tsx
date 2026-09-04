import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/kit/Button";
import { Input } from "@/components/kit/Input";
import { Segmented as KitSegmented } from "@/components/kit/Segmented";
import { SubHeader } from "@/components/kit/SubHeader";
import { Txt } from "@/components/kit/Txt";
import { space } from "@/theme/tokens";

/**
 * FORM PARÇALARI — eski API korunur (ScreenHeader/Field/TextField/Segmented/PrimaryButton/
 * DeleteButton), gövde yeni kit. Böylece manuel sipariş, maliyet, kural ve ayar formları
 * (8 ekran) tek dosya değişikliğiyle yeni dile geçer; ekranlar sırayla ayrıca elden geçirilir.
 */

export function ScreenHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <SubHeader
      title={title}
      right={onAdd ? <Button label="Ekle" icon="plus" size="sm" variant="secondary" onPress={onAdd} /> : undefined}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Txt v="label" tone="faint" style={s.label}>
        {label.toLocaleUpperCase("tr-TR")}
      </Txt>
      {children}
    </View>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  numeric,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
}) {
  return <Input value={value} onChangeText={onChange} placeholder={placeholder} numeric={numeric} />;
}

export function Segmented<T extends string>({
  items,
  selected,
  onSelect,
}: {
  items: { key: T; label: string }[];
  selected: T;
  onSelect: (k: T) => void;
}) {
  return (
    <KitSegmented
      options={items.map((it) => ({ value: it.key, label: it.label }))}
      value={selected}
      onChange={onSelect}
    />
  );
}

export function PrimaryButton({
  label,
  onPress,
  loading,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
}) {
  return <Button label={label} onPress={onPress} loading={loading} style={{ marginTop: space.sm }} />;
}

export function DeleteButton({ onPress }: { onPress: () => void }) {
  return <Button label="Sil" variant="danger" onPress={onPress} style={{ marginTop: space.xs }} />;
}

const s = StyleSheet.create({
  label: { letterSpacing: 1 },
});
