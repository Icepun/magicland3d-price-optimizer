import { useEffect, useState } from "react";

import { Txt } from "@/components/kit/Txt";
import { formatRelativeTime } from "@/lib/format";

/**
 * "X dk önce" damgası — ekrandaki verinin YAŞI. Çevrimdışı önbellekten gelen bayat rakam
 * (varsayılan 5 dk) uyarı rengine döner; sessizce eski rakam gösterilmez.
 *
 * ⚠️ `Date.now()` render sırasında çağrılmaz (React Compiler); şimdiki zaman durumda tutulur ve
 * zamanlayıcıyla ilerler — damga kendiliğinden "2 dk" → "3 dk" olur.
 */
export function FreshnessStamp({
  updatedAt,
  staleAfterMs = 5 * 60_000,
  suffix = true,
}: {
  /** Verinin çekildiği an (epoch ms). 0/undefined → hiç yüklenmemiş, damga gösterilmez. */
  updatedAt: number | undefined;
  staleAfterMs?: number;
  /** "güncellendi" ekini gösterme (başlık satırında yer dar). */
  suffix?: boolean;
}) {
  const [now, setNow] = useState(updatedAt ?? 0);

  useEffect(() => {
    if (!updatedAt) return;
    const tick = () => setNow(Date.now());
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
    <Txt v="label" tone={bayat ? "warn" : "faint"} numberOfLines={1}>
      {bayat ? "⚠ " : ""}
      {formatRelativeTime(new Date(updatedAt), now || undefined)}
      {suffix ? " güncellendi" : ""}
    </Txt>
  );
}
