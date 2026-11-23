"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Link2, Loader2, PackagePlus, RotateCcw, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { thumbUrl } from "@/lib/image";
import { formatCurrency, formatNumber } from "@/lib/format";
import { requestOrdersView } from "@/components/ui/command-palette";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { KarEksikSebepleri } from "@/app/reports/reports-view";
import { ayAdi } from "@/app/reports/rapor-gorunum";
import { RaporKart } from "./rapor-ortak";

/** Ayın kâr hesabındaki eksikler: maliyetsiz ürünler, bağlanmamış satışlar, eski hesap. */
export function RaporSaglik({
  eksikSiparis,
  karEksik,
  yenidenHesaplanabilir,
  onYenidenHesapla,
  sira,
}: {
  eksikSiparis: number;
  karEksik: KarEksikSebepleri | null;
  yenidenHesaplanabilir: number;
  onYenidenHesapla: () => void;
  sira?: number;
}) {
  const urunler = karEksik?.urunler ?? [];
  const baglanmamis = karEksik?.baglanmamis ?? [];
  return (
    <RaporKart
      baslik="Kâr hesabını tamamla"
      aciklama={eksikSiparis > 0 ? `Bu ay ${formatNumber(eksikSiparis)} siparişin kârı eksik` : "Rakamları güncel tut"}
      ikon={<Stethoscope className="size-4" />}
      sira={sira}
    >
      <div className="space-y-4">
        {urunler.length > 0 && (
          <Grup baslik="Maliyeti girilmemiş ürünler" ek={karEksik?.digerUrun ? `+${karEksik.digerUrun} ürün daha` : null}>
            {urunler.map((u, i) => (
              <Link
                key={u.productId}
                href={`/products/${u.productId}`}
                className={cip}
                style={{ animationDelay: `${i * 40}ms` } as CSSProperties}
              >
                {u.imageUrl ? (
                  <img src={thumbUrl(u.imageUrl, 48) ?? ""} alt="" className="size-5 rounded object-cover" />
                ) : (
                  <PackagePlus className="size-3.5 text-[#A9AEFF]" />
                )}
                <span className="max-w-[16rem] truncate">{u.name}</span>
                <span className="text-muted-foreground">· maliyet gir</span>
              </Link>
            ))}
          </Grup>
        )}
        {baglanmamis.length > 0 && (
          <Grup
            baslik="Ürüne bağlanmamış satışlar"
            ek={karEksik?.digerBaglanmamis ? `+${karEksik.digerBaglanmamis} satış daha` : null}
          >
            {baglanmamis.map((s, i) => (
              <Link
                key={s.ad}
                href="/orders"
                onClick={() => requestOrdersView({ search: s.ad })}
                className={cip}
                style={{ animationDelay: `${(urunler.length + i) * 40}ms` } as CSSProperties}
              >
                <Link2 className="size-3.5 text-[#A9AEFF]" />
                <span className="max-w-[16rem] truncate">{s.ad}</span>
              </Link>
            ))}
          </Grup>
        )}
        {yenidenHesaplanabilir > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#7A7EFF]/[0.07] px-4 py-3 ring-1 ring-[#7A7EFF]/20">
            <p className="text-xs text-[#C9D2F2]">
              {formatNumber(yenidenHesaplanabilir)} siparişin kârı eski hesapla kayıtlı.
            </p>
            <button
              type="button"
              onClick={onYenidenHesapla}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#7A7EFF] px-3 py-1.5 text-xs font-medium text-white shadow-[0_8px_20px_-10px_rgba(122,126,255,0.9)] transition hover:brightness-110 active:scale-[0.98]"
            >
              <RotateCcw className="size-3.5" /> Yeniden hesapla
            </button>
          </div>
        )}
      </div>
    </RaporKart>
  );
}

const cip =
  "inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] py-1 pl-1.5 pr-2.5 text-xs ring-1 ring-white/[0.08] transition hover:bg-white/[0.08] hover:ring-white/[0.15] active:scale-[0.98] animate-in fade-in zoom-in-95 fill-mode-both duration-300 motion-reduce:animate-none";

function Grup({ baslik, ek, children }: { baslik: string; ek: string | null; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{baslik}</p>
      <div className="flex flex-wrap gap-1.5">
        {children}
        {ek && <span className="self-center px-1 text-[11px] text-muted-foreground">{ek}</span>}
      </div>
    </div>
  );
}

/* ── Ayı yeniden hesapla ──────────────────────────────────────────────────────────────── */

interface RecalcState {
  month: string;
  phase: "reading" | "calculating" | "writing" | "done" | "error";
  processed: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  dryRun?: boolean;
  error: string | null;
  result: {
    totalOrders: number;
    recalculatedOrders: number;
    changedOrders: number;
    skippedOrders: number;
    profitDeltaKurus: number;
    dryRun?: boolean;
  } | null;
}

type Adim = "prova" | "hazir" | "uygula" | "bitti" | "hata";

const AKTIF = new Set(["reading", "calculating", "writing"]);
const ASAMA: Record<string, string> = { reading: "Okunuyor", calculating: "Hesaplanıyor", writing: "Kaydediliyor" };

function yuzde(s: RecalcState | null): number {
  if (!s) return 2;
  if (s.phase === "done" || s.phase === "error") return 100;
  if (s.phase === "reading") return 6;
  if (s.phase === "writing") return 96;
  return s.total > 0 ? 8 + (s.processed / s.total) * 86 : 8;
}

/**
 * Önce PROVA (hiçbir şey yazılmaz, ne değişeceği gösterilir), onaylanınca uygular.
 * Tur sunucuda sürer; ilerleme yoklanır.
 */
export function AyiYenidenHesapla({ month, onClose }: { month: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [adim, setAdim] = useState<Adim>("prova");
  const [durum, setDurum] = useState<RecalcState | null>(null);
  const [prova, setProva] = useState<RecalcState["result"]>(null);
  const [hata, setHata] = useState<string | null>(null);
  const iptal = useRef(false);

  useEffect(() => {
    iptal.current = false;
    return () => {
      iptal.current = true;
    };
  }, []);

  const calistir = async (dryRun: boolean): Promise<RecalcState | null> => {
    const r = await fetch(`/api/finance/monthly?month=${encodeURIComponent(month)}${dryRun ? "&dryRun=1" : ""}`, {
      method: "POST",
    });
    const j = (await r.json().catch(() => ({}))) as { recalc?: RecalcState; error?: string };
    if (!r.ok) throw new Error(j.error || "Hesaplama başlatılamadı.");
    let s = j.recalc ?? null;
    setDurum(s);
    while (s && AKTIF.has(s.phase) && !iptal.current) {
      await new Promise((ok) => setTimeout(ok, 350));
      s = (await fetchJson<{ recalc: RecalcState | null }>("/api/finance/monthly?recalc=status", { cache: "no-store" })).recalc;
      setDurum(s);
    }
    if (s?.phase === "error") throw new Error(s.error || "Hesaplanamadı.");
    return s;
  };

  // Açılınca prova kendiliğinden başlar.
  const basladi = useRef(false);
  useEffect(() => {
    if (basladi.current) return;
    basladi.current = true;
    void (async () => {
      try {
        const s = await calistir(true);
        if (iptal.current) return;
        setProva(s?.result ?? null);
        setAdim("hazir");
      } catch (e) {
        if (iptal.current) return;
        setHata(e instanceof Error ? e.message : "Hesaplanamadı.");
        setAdim("hata");
      }
    })();
    // calistir her çizimde yeniden kurulur; yalnız ilk açılışta çalışmalı.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uygula = async () => {
    setAdim("uygula");
    try {
      const s = await calistir(false);
      const r = s?.result;
      const fark = (r?.profitDeltaKurus ?? 0) / 100;
      toast.success(
        !r || r.changedOrders === 0
          ? "Değişen bir rakam yok."
          : `${formatNumber(r.changedOrders)} siparişin kârı güncellendi (${fark >= 0 ? "+" : "−"}${formatCurrency(Math.abs(fark), { decimals: 0 })}).`
      );
      await queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
      await queryClient.invalidateQueries({ queryKey: ["finance-dokum"] });
      if (!iptal.current) setAdim("bitti");
      onClose();
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Hesaplanamadı.");
      setAdim("hata");
    }
  };

  const calisiyor = adim === "prova" || adim === "uygula";
  const fark = (prova?.profitDeltaKurus ?? 0) / 100;

  return (
    <Dialog open onOpenChange={(o) => !o && !calisiyor && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="size-4 text-[#A9AEFF]" /> {ayAdi(month)} yeniden hesapla
          </DialogTitle>
          <DialogDescription>Güncel maliyet, komisyon ve kargo ile.</DialogDescription>
        </DialogHeader>

        {calisiyor && (
          <div className="space-y-2 py-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                {adim === "prova" ? "Değişecekler hesaplanıyor" : "Uygulanıyor"} · {ASAMA[durum?.phase ?? "reading"] ?? ""}
              </span>
              <span className="tabular-nums">
                {durum && durum.total > 0 ? `${formatNumber(durum.processed)} / ${formatNumber(durum.total)}` : ""}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#9B5CFF] to-[#4F8CFF] transition-[width] duration-300 ease-out"
                style={{ width: `${yuzde(durum)}%` }}
              />
            </div>
          </div>
        )}

        {adim === "hazir" && prova && (
          <div className="space-y-4 py-1 animate-in fade-in slide-in-from-bottom-1 duration-300">
            {prova.changedOrders === 0 ? (
              <p className="flex items-center gap-2 rounded-xl bg-emerald-500/[0.07] px-3 py-3 text-sm text-emerald-100/90 ring-1 ring-emerald-400/15">
                <CheckCircle2 className="size-4 text-emerald-300" /> Bu ayın rakamları zaten güncel.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08]">
                  <p className="text-[11px] text-muted-foreground">Değişecek sipariş</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(prova.changedOrders)}</p>
                </div>
                <div className="rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08]">
                  <p className="text-[11px] text-muted-foreground">Kâr farkı</p>
                  <p className={cn("mt-1 text-xl font-semibold tabular-nums", fark < 0 ? "text-rose-300" : "text-emerald-300")}>
                    {fark >= 0 ? "+" : "−"}
                    {formatCurrency(Math.abs(fark), { decimals: 0 })}
                  </p>
                </div>
              </div>
            )}
            {prova.skippedOrders > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {formatNumber(prova.skippedOrders)} siparişin ürün bilgisi yok, onlara dokunulmaz.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
              >
                Vazgeç
              </button>
              {prova.changedOrders > 0 && (
                <button
                  type="button"
                  onClick={() => void uygula()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#7A7EFF] px-3.5 py-1.5 text-xs font-medium text-white shadow-[0_8px_20px_-10px_rgba(122,126,255,0.9)] transition hover:brightness-110 active:scale-[0.98]"
                >
                  Uygula
                </button>
              )}
            </div>
          </div>
        )}

        {adim === "hata" && (
          <div className="space-y-3 py-1">
            <p className="rounded-xl bg-rose-500/[0.07] px-3 py-3 text-sm text-rose-100/90 ring-1 ring-rose-400/15">{hata}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
              >
                Kapat
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
