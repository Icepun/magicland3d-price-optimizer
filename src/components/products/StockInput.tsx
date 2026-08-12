"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Yazılan stok değerinden KAYDEDİLECEK sayıyı çözer.
 *
 * `null` = yazma yok, alan eski değerine dönsün. Esc iptal sayılır: kutu odaktan çıkarken
 * blur olayı yazmayı tetikliyordu ve Esc yazılan rakamı KAYDEDİYORDU (iptal etmesi gerekirken).
 * Karar tek yerde ve saf tutuluyor ki bu davranış testle kilitli kalsın.
 */
export function stockCommitValue(
  draft: string,
  current: number,
  cancelled: boolean
): number | null {
  if (cancelled) return null;
  const trimmed = draft.trim();
  if (!trimmed) return null; // boş bırakıldı → kaza ile 0 olmasın
  const parsed = Math.floor(Number(trimmed));
  if (!Number.isFinite(parsed)) return null;
  const next = Math.max(0, parsed);
  return next === current ? null : next;
}

/**
 * Stok değeri — hem OKUNUR hem ELLE DÜZENLENEBİLİR.
 *
 * Eskiden yalnız +/- butonları vardı; 900 stoklu bir ürünü 0'a indirmek imkânsıza yakındı.
 * Artık sayıya tıklayıp doğrudan yazabilirsin (odakta tümü seçilir → yaz-geç).
 * Enter/blur kaydeder, Esc iptal eder. Boş bırakılırsa eski değere döner (kaza ile 0 olmasın).
 */
export function StockInput({
  value,
  onCommit,
  className,
  title,
}: {
  value: number;
  onCommit: (next: number) => void;
  className?: string;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  // Esc'in bıraktığı iptal işareti REF'te tutulur: blur, state güncellenmeden önce
  // çalıştığı için state ile bakıldığında iptal görünmüyor ve eski rakam kaydediliyordu.
  const cancelledRef = useRef(false);

  const commit = () => {
    setEditing(false);
    const next = stockCommitValue(draft, value, cancelledRef.current);
    cancelledRef.current = false;
    if (next == null) {
      setDraft(String(value));
      return;
    }
    onCommit(next);
  };

  const tone =
    value === 0 ? "text-destructive" : value === 1 ? "text-amber-500" : "text-foreground";

  return (
    <input
      type="text"
      inputMode="numeric"
      value={editing ? draft : String(value)}
      title={title ?? "Stok — tıkla ve doğrudan yaz"}
      aria-label="Stok adedi"
      onFocus={(e) => {
        cancelledRef.current = false;
        setDraft(String(value));
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.currentTarget.blur(); }
        else if (e.key === "Escape") {
          cancelledRef.current = true;
          setDraft(String(value));
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "tabular-nums font-bold text-center bg-transparent rounded-md border border-transparent",
        "hover:border-border focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30",
        "transition-colors cursor-text",
        tone,
        className
      )}
    />
  );
}
