"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

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
  const inputRef = useRef<HTMLInputElement>(null);

  // Dışarıdan değer değişirse (ör. +/- butonu, senkron) düzenlemede DEĞİLKEN yansıt.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const n = Math.max(0, Math.floor(Number(draft)));
    if (!draft.trim() || !Number.isFinite(n)) { setDraft(String(value)); return; } // boş/geçersiz → eski değer
    if (n !== value) onCommit(n);
    else setDraft(String(value));
  };

  const tone =
    value === 0 ? "text-destructive" : value === 1 ? "text-amber-500" : "text-foreground";

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      value={draft}
      title={title ?? "Stok — tıkla ve doğrudan yaz"}
      aria-label="Stok adedi"
      onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.currentTarget.blur(); }
        else if (e.key === "Escape") { setDraft(String(value)); setEditing(false); e.currentTarget.blur(); }
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
