import { View } from "react-native";

import { Shimmer } from "@/components/kit/Skeleton";
import { radius, space } from "@/theme/tokens";

/** FORM YÜKLENİYOR — etiket + alan çiftleri; düzenleme ekranlarının şekli listeden farklı. */
export function FormShimmer({ rows = 5 }: { rows?: number }) {
  return (
    <View style={{ gap: space.xl }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ gap: space.sm }}>
          <Shimmer width="35%" height={11} delay={i * 70} />
          <Shimmer width="100%" height={46} radius={radius.md} delay={i * 70 + 60} />
        </View>
      ))}
    </View>
  );
}
