import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";

import { Txt } from "@/components/kit/Txt";
import { color, font, radius, space } from "@/theme/tokens";

/**
 * METİN GİRİŞİ — saydam yüzey, ince kenarlık, yeni yazı tipi. Odaklanınca kenarlık mora döner
 * (native `onFocus` ile; ek kütüphane yok). Sayısal alanlarda ondalık klavye.
 */
export function Input({
  value,
  onChangeText,
  placeholder,
  numeric = false,
  icon,
  suffix,
  style,
  inputStyle,
  ...rest
}: Omit<TextInputProps, "style"> & {
  value: string;
  onChangeText: (v: string) => void;
  numeric?: boolean;
  /** Solda küçük SF Symbol (arama büyüteci gibi). */
  icon?: SymbolViewProps["name"];
  /** Sağda birim (₺, %, gr). */
  suffix?: string;
  style?: StyleProp<ViewStyle>;
  inputStyle?: TextInputProps["style"];
}) {
  return (
    <View style={[styles.wrap, style]}>
      {icon ? <SymbolView name={icon} tintColor={color.textFaint} style={styles.icon} /> : null}
      <TextInput
        {...rest}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textFaint}
        keyboardType={rest.keyboardType ?? (numeric ? "decimal-pad" : "default")}
        keyboardAppearance="dark"
        selectionColor={color.accentBright}
        style={[styles.input, inputStyle]}
      />
      {suffix ? (
        <Txt v="small" tone="faint" num>
          {suffix}
        </Txt>
      ) : null}
    </View>
  );
}

/** Arama kutusu — büyüteç + "ara" klavye tuşu + yazarken temizle düğmesi. */
export function SearchInput(props: Omit<Parameters<typeof Input>[0], "icon">) {
  return (
    <Input
      icon="magnifyingglass"
      clearButtonMode="while-editing"
      autoCorrect={false}
      returnKeyType="search"
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 46,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.tint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  icon: { width: 16, height: 16 },
  input: {
    flex: 1,
    minHeight: 46,
    paddingVertical: 0,
    color: color.text,
    fontFamily: font.medium,
    fontSize: 15,
  },
});
