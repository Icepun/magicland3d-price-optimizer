"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { kargoDesiOku } from "@/core/kargo-desi";
import { cn } from "@/lib/utils";

/**
 * SHOPIFY KARGO DESİSİ — sipariş gerçekte kaç desiyle çıktıysa kullanıcı buraya yazar; kargo bedeli
 * ürün desilerinin toplamı yerine bununla hesaplanır (Berke, 24 Kas 2026). Kargo satırının yanında
 * küçük "Desi" düğmesi; tıklanınca aynı satırda açılan küçük bir giriş.
 */
export function KargoDesiDuzenle({
  siparisId,
  desi,
  elle,
}: {
  siparisId: string;
  /** Şu an hesapta kullanılan desi (girilmemişse ürünlerin toplamı). */
  desi: number | null | undefined;
  /** Desi daha önce elle girildi mi? */
  elle: boolean;
}) {
  const qc = useQueryClient();
  const [acik, setAcik] = useState(false);
  const [metin, setMetin] = useState("");
  const gecerli = kargoDesiOku(metin);

  const bitti = (mesaj: string) => {
    void qc.invalidateQueries({ queryKey: ["orders"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    toast.success(mesaj);
    setAcik(false);
  };
  const kaydet = useMutation({
    mutationFn: (yeni: number) =>
      fetchJson("/api/orders/kargo-desi", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "shopify", siparisId, desi: yeni }),
      }),
    onSuccess: () => bitti("Kargo desisi kaydedildi"),
    onError: (e: Error) => toast.error(e.message || "Kaydedilemedi"),
  });
  const sifirla = useMutation({
    mutationFn: () =>
      fetchJson("/api/orders/kargo-desi", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "shopify", siparisId }),
      }),
    onSuccess: () => bitti("Kargo yine ürün desilerinden hesaplanıyor"),
    onError: (e: Error) => toast.error(e.message || "Kaydedilemedi"),
  });
  const mesgul = kaydet.isPending || sifirla.isPending;

  if (!acik) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMetin(desi != null ? String(desi).replace(".", ",") : "");
          setAcik(true);
        }}
        className={cn(
          "ml-1.5 inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-semibold transition-all hover:brightness-125 active:scale-95",
          elle ? "bg-[#7A7EFF]/20 text-[#C9D2F2]" : "bg-white/[0.06] text-muted-foreground hover:text-foreground"
        )}
        title="Kargoyu gerçekte kaç desiyle çıkardığını gir"
      >
        <Pencil className="h-2.5 w-2.5" />
        Desi
      </button>
    );
  }

  return (
    <span
      className="ml-1.5 inline-flex items-center gap-1 align-middle animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        inputMode="decimal"
        value={metin}
        onChange={(e) => setMetin(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && gecerli != null && !mesgul) kaydet.mutate(gecerli);
          if (e.key === "Escape") setAcik(false);
        }}
        aria-label="Kargo desisi"
        className={cn(
          "h-5 w-12 rounded border bg-white/[0.04] px-1 text-[10px] tabular-nums outline-none transition-colors",
          metin && gecerli == null ? "border-rose-400/60" : "border-white/[0.12] focus:border-[#7A7EFF]/60"
        )}
      />
      <span className="text-[9px] text-muted-foreground">desi</span>
      <button
        type="button"
        disabled={gecerli == null || mesgul}
        onClick={() => gecerli != null && kaydet.mutate(gecerli)}
        className="grid h-5 w-5 place-items-center rounded bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] text-white transition active:scale-90 disabled:opacity-40"
        title="Kaydet"
      >
        <Check className="h-3 w-3" />
      </button>
      {elle && (
        <button
          type="button"
          disabled={mesgul}
          onClick={() => sifirla.mutate()}
          className="grid h-5 w-5 place-items-center rounded bg-white/[0.06] text-muted-foreground transition hover:text-foreground active:scale-90 disabled:opacity-40"
          title="Ürün desilerinden hesapla"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
      <button
        type="button"
        disabled={mesgul}
        onClick={() => setAcik(false)}
        className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition hover:text-foreground active:scale-90"
        title="Vazgeç"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
