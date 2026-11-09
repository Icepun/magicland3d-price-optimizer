import { useMemo, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import Svg, { G, Rect } from "react-native-svg";

import { Button, Chip, Glass, Txt } from "@/components/kit";
import type { YaziciParca } from "@core/printer-detail";
import { color, radius, space } from "@/theme/tokens";

/**
 * BOZULAN PARÇAYI İPTAL ET — telefondan, masaüstü seçicisinin küçük kardeşi.
 *
 * Parçalar tabladaki yerlerine göre numaralı (masaüstüyle AYNI numaralar — masaüstü hesaplayıp
 * yazıyor); ham ad gösterilmez. Dokunmak SEÇER, iptal ayrı bir onaydan geçer. Son kalan parça
 * iptal edilemez (yazıcı boşa çalışırdı — o durumda baskıyı iptal etmek gerekir).
 */
export function ParcaIptalKarti({
  parcalar,
  iptaller,
  basilan,
  mesgul,
  onIptal,
}: {
  parcalar: YaziciParca[];
  iptaller: string[];
  basilan: string | null;
  mesgul: boolean;
  onIptal: (p: YaziciParca) => void;
}) {
  const [secili, setSecili] = useState<string | null>(null);

  // Çerçeve: parçaların kapladığı alan + pay, kare (tabla ölçüsü telefonda bilinmiyor).
  const cerceve = useMemo(() => {
    const xs = parcalar.flatMap((p) => [p.kutu[0], p.kutu[2]]);
    const ys = parcalar.flatMap((p) => [p.kutu[1], p.kutu[3]]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const kenar = Math.max(maxX - minX, maxY - minY) * 1.25 + 10;
    return { x: (minX + maxX) / 2 - kenar / 2, y: (minY + maxY) / 2 - kenar / 2, kenar };
  }, [parcalar]);

  const kalan = parcalar.filter((p) => !iptaller.includes(p.ad)).length;
  const sonParca = kalan <= 1;
  const seciliParca = parcalar.find((p) => p.ad === secili && !iptaller.includes(p.ad)) ?? null;

  const iptalEt = () => {
    if (!seciliParca || sonParca) return;
    Alert.alert(
      `${seciliParca.no}. parça iptal edilsin mi?`,
      "Bu parça yarım kalacak, diğerleri basılmaya devam edecek.",
      [
        { text: "Vazgeç", style: "cancel" },
        {
          text: "İptal et",
          style: "destructive",
          onPress: () => {
            onIptal(seciliParca);
            setSecili(null);
          },
        },
      ],
    );
  };

  // Tabla koordinatı → çizim: Y ekranda TERS (tablanın arkası yukarıda).
  const cx = (x: number) => x - cerceve.x;
  const cy = (y: number) => cerceve.kenar - (y - cerceve.y);

  return (
    <Glass style={{ gap: space.md }}>
      <View style={styles.ust}>
        <Txt v="label" tone="faint">
          BOZULAN PARÇA
        </Txt>
        <Txt v="small" tone="dim" num>
          {kalan} / {parcalar.length} basılıyor
        </Txt>
      </View>

      <View style={styles.harita}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${cerceve.kenar} ${cerceve.kenar}`}>
          {[...parcalar]
            .sort((a, b) => alan(b) - alan(a)) // büyük altta → küçük parça dokunulabilir kalır
            .map((p) => {
              const kapali = iptaller.includes(p.ad);
              const sec = p.ad === secili && !kapali;
              const aktif = p.ad === basilan && !kapali;
              const [x0, y0, x1, y1] = p.kutu;
              return (
                <G key={p.ad} onPress={kapali ? undefined : () => setSecili(p.ad)}>
                  <Rect
                    x={cx(x0)}
                    y={cy(y1)}
                    width={Math.max(2, x1 - x0)}
                    height={Math.max(2, y1 - y0)}
                    rx={2}
                    fill={kapali ? "rgba(255,255,255,0.04)" : sec ? color.badSoft : color.accentSoft}
                    stroke={kapali ? color.line : sec ? color.bad : aktif ? color.good : color.accentBright}
                    strokeWidth={sec || aktif ? 1.6 : 0.8}
                    strokeDasharray={kapali ? "3 2" : undefined}
                  />
                </G>
              );
            })}
        </Svg>
        {/* Numaralar uygulamanın kendi yazısıyla (SVG yazısı yazı tipi ailesini bulamayabiliyor). */}
        {parcalar.map((p) => {
          const kapali = iptaller.includes(p.ad);
          const [x0, y0, x1, y1] = p.kutu;
          return (
            <View
              key={`n-${p.ad}`}
              pointerEvents="none"
              style={[
                styles.numara,
                { left: `${(cx((x0 + x1) / 2) / cerceve.kenar) * 100}%`, top: `${(cy((y0 + y1) / 2) / cerceve.kenar) * 100}%` },
              ]}
            >
              <Txt v="smallStrong" tone={kapali ? "faint" : "default"} num>
                {p.no}
              </Txt>
            </View>
          );
        })}
      </View>

      <View style={styles.cipler}>
        {[...parcalar].sort((a, b) => a.no - b.no).map((p) => {
          const kapali = iptaller.includes(p.ad);
          return (
            <Chip
              key={p.ad}
              label={kapali ? `${p.no}. parça · iptal` : p.ad === basilan ? `${p.no}. parça · basılıyor` : `${p.no}. parça`}
              selected={p.ad === secili && !kapali}
              onPress={kapali ? undefined : () => setSecili(p.ad)}
              style={kapali ? { opacity: 0.45 } : undefined}
            />
          );
        })}
      </View>

      {sonParca ? (
        <Txt v="small" tone="warn">
          Tek parça kaldı — durdurmak için baskıyı iptal et.
        </Txt>
      ) : (
        <Button
          label={seciliParca ? `${seciliParca.no}. parçayı iptal et` : "İptal edilecek parçayı seç"}
          icon="scissors"
          variant="danger"
          disabled={!seciliParca || mesgul}
          onPress={iptalEt}
        />
      )}
    </Glass>
  );
}

function alan(p: YaziciParca): number {
  return Math.abs((p.kutu[2] - p.kutu[0]) * (p.kutu[3] - p.kutu[1]));
}

const styles = StyleSheet.create({
  ust: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  harita: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: "rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  cipler: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  numara: { position: "absolute", width: 32, height: 20, marginLeft: -16, marginTop: -10, alignItems: "center", justifyContent: "center" },
});
