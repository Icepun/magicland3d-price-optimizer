import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ML, radius } from "@/theme/colors";

export function ScreenHeader({
  title,
  onAdd,
}: {
  title: string;
  onAdd?: () => void;
}) {
  return (
    <View style={s.header}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
        <Text style={s.backText}>‹</Text>
      </Pressable>
      <Text style={s.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      {onAdd ? (
        <Pressable onPress={onAdd} hitSlop={12}>
          <Text style={s.add}>+ Ekle</Text>
        </Pressable>
      ) : (
        <View style={{ width: 48 }} />
      )}
    </View>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
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
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={ML.textFaint}
      keyboardType={numeric ? "decimal-pad" : "default"}
      style={s.input}
    />
  );
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
    <View style={s.segmented}>
      {items.map((it) => {
        const on = it.key === selected;
        return (
          <Pressable
            key={it.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(it.key);
            }}
            style={[s.segment, on && s.segmentOn]}
          >
            <Text style={[s.segmentText, on && { color: "#fff", fontWeight: "700" }]}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [s.primary, pressed && { opacity: 0.85 }]}
    >
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>{label}</Text>}
    </Pressable>
  );
}

export function DeleteButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={s.delete}>
      <Text style={s.deleteText}>Sil</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, height: 48 },
  back: { width: 48, height: 32, justifyContent: "center" },
  backText: { color: ML.text, fontSize: 34, marginTop: -4 },
  headerTitle: { flex: 1, color: ML.text, fontSize: 17, fontWeight: "700", textAlign: "center" },
  add: { color: ML.accent, fontSize: 16, fontWeight: "700", width: 48, textAlign: "right" },
  label: { color: ML.textFaint, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  input: {
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    color: ML.text,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 4,
    gap: 4,
  },
  segment: { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: "center" },
  segmentOn: { backgroundColor: ML.accent },
  segmentText: { color: ML.textDim, fontSize: 14 },
  primary: {
    backgroundColor: ML.accent,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  primaryText: { color: "#fff", fontSize: 17, fontWeight: "800" },
  delete: { paddingVertical: 14, alignItems: "center" },
  deleteText: { color: ML.red, fontSize: 16, fontWeight: "700" },
});
