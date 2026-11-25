import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";

import { color } from "@/theme/tokens";

/**
 * ZEMİN — tüm uygulamanın altında duran tek katman.
 *
 * Masaüstü gövdesiyle aynı: lacivert-siyah zemin + iki yumuşak ortam ışığı (sağ üstte periwinkle,
 * sağ altta mor). Lekeler SVG radial gradyanla çizilir; ucuz ve her cihazda aynı görünür.
 *
 * Ekranlar kendi arka planını ŞEFFAF bırakır; bu katman kökte bir kez çizilir.
 */
export function Backdrop() {
  const { width, height } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[color.bg1, color.bg0]}
        locations={[0, 0.85]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="leke-mor" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color.glowAccent} stopOpacity={0.26} />
            <Stop offset="0.55" stopColor={color.glowAccent} stopOpacity={0.08} />
            <Stop offset="1" stopColor={color.glowAccent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="leke-mavi" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color.glowCool} stopOpacity={0.16} />
            <Stop offset="0.6" stopColor={color.glowCool} stopOpacity={0.05} />
            <Stop offset="1" stopColor={color.glowCool} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={width * 0.72} cy={-height * 0.02} rx={width * 0.9} ry={height * 0.26} fill="url(#leke-mor)" />
        <Ellipse cx={width * 1.0} cy={height * 0.98} rx={width * 0.75} ry={height * 0.22} fill="url(#leke-mavi)" />
      </Svg>
    </View>
  );
}
