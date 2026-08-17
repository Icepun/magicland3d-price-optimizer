import { useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";

import { ML } from "@/theme/colors";
import { formatRelativeTime } from "@/lib/format";

/**
 * "X dk önce güncellendi" damgası.
 *
 * NEDEN: telefon ekranı, veriyi ne zaman aldığını söylemiyordu. Atölyede wifi düştüğünde ekranda
 * duran rakam saatler öncesine ait olabiliyor ama CANLI gibi görünüyordu — sipariş/kâr/yazıcı
 * kararları bunun üzerine veriliyor. Damga, verinin YAŞINI görünür kılar; bayatladığında
 * (varsayılan 5 dk) rengi uyarıya döner.
 *
 * ⚠️ `Date.now()` RENDER SIRASINDA çağrılamaz — React Compiler bunu "saf olmayan çağrı" diye
 * hata sayar (aynı tuzağa Kargo Kuralları ekranı düşmüştü ve mobil CI'nın lint adımını kırmıştı).
 * Bu yüzden şimdiki zaman bir durum değişkeninde tutulur ve zamanlayıcıyla tazelenir; yan etki
 * olarak damga kendiliğinden de ilerler ("2 dk" → "3 dk"), ekranı yenilemeye gerek kalmaz.
 */
export function FreshnessStamp({
  updatedAt,
  staleAfterMs = 5 * 60_000,
  style,
  suffix = true,
}: {
  /** Verinin çekildiği an (epoch ms). 0/undefined → hiç yüklenmemiş, damga gösterilmez. */
  updatedAt: number | undefined;
  staleAfterMs?: number;
  style?: object;
  /**
   * "güncellendi" ekini gösterme. Başlık satırında yer dar: ek yüzünden asıl bilgi
   * ("4 baskı sürüyor · 4 yazıcı") kırpılıyordu. Yanındaki alt başlık zaten neyin
   * güncellendiğini söylüyor.
   */
  suffix?: boolean;
}) {
  // Başlangıç değeri prop'tan gelir (saf); gerçek saat yalnız efekt içinde okunur.
  const [now, setNow] = useState(updatedAt ?? 0);

  useEffect(() => {
    if (!updatedAt) return;
    const tick = () => setNow(Date.now());
    // İlk güncelleme de ASENKRON: efekt içinde doğrudan setState çağırmak zincirleme render
    // uyarısı üretiyor (React Compiler kuralı). Sıfır gecikmeli zamanlayıcı bunu bir sonraki
    // tur'a atar; damga yine anında doğru değeri gösterir.
    const ilk = setTimeout(tick, 0);
    const id = setInterval(tick, 30_000);
    return () => {
      clearTimeout(ilk);
      clearInterval(id);
    };
  }, [updatedAt]);

  if (!updatedAt) return null;
  const bayat = now - updatedAt > staleAfterMs;
  return (
    <Text style={[styles.text, bayat && styles.stale, style]} numberOfLines={1}>
      {bayat ? "⚠ " : ""}
      {formatRelativeTime(new Date(updatedAt), now || undefined)}
      {suffix ? " güncellendi" : ""}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { color: ML.textFaint, fontSize: 11, fontWeight: "600" },
  stale: { color: ML.orange },
});
