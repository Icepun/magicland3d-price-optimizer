import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";

import { color } from "@/theme/tokens";

/**
 * ZEMİN — tüm uygulamanın altında duran tek katman.
 *
 * Şablondaki (Ledgerix) cam yüzeyler, arkalarında ışık olduğu için cam gibi okunur. Düz siyah
 * zemin üstünde cam, koyu gri karttan farksızdır. Bu yüzden zemin: dikey füme-mavi gradyan +
 * iki yumuşak ışık lekesi (mor sağ üstte, mavi sol altta). Lekeler SVG radial gradyanla çizilir;
 * BlurView'den çok daha ucuz ve her cihazda aynı görünür.
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
            <Stop offset="0" stopColor={color.glowAccent} stopOpacity={0.42} />
            <Stop offset="0.55" stopColor={color.glowAccent} stopOpacity={0.12} />
            <Stop offset="1" stopColor={color.glowAccent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="leke-mavi" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color.glowCool} stopOpacity={0.3} />
            <Stop offset="0.6" stopColor={color.glowCool} stopOpacity={0.08} />
            <Stop offset="1" stopColor={color.glowCool} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={width * 0.88} cy={height * 0.06} rx={width * 0.62} ry={height * 0.22} fill="url(#leke-mor)" />
        <Ellipse cx={width * 0.08} cy={height * 0.72} rx={width * 0.58} ry={height * 0.2} fill="url(#leke-mavi)" />
      </Svg>
    </View>
  );
}
