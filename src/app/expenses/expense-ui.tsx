"use client";

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";
import {
  PERIYOTLAR,
  type KategoriDilimi,
  type PeriyotTipi,
} from "@/lib/expense-view";
import { GIDER_KDV_ORANLARI, giderKdvEtiketi } from "@/core/gider-kdv";

/**
 * Gider Ödemeleri sayfasının görsel parçaları.
 *
 * Sayfa dosyası zaten uzun; grafik ve seçiciler burada duruyor. Hepsi SAF sunum —
 * veri türetmesi `@/lib/expense-view` içinde, testleri de orada.
 */

/* ─────────────────────────── KDV seçici ─────────────────────────── */

/**
 * Giderin KDV oranı: Yok / %1 / %10 / %20. Tutar KDV DAHİL girilir; oran seçilince net kârdan
 * KDV hariç tutar düşer (kural `core/gider-kdv.ts`). "Yok" varsayılan — eski davranış.
 */
export function KdvSecici({
  value,
  onChange,
  id,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  id?: string;
}) {
  const secenekler: { deger: number | null; ad: string }[] = [
    { deger: null, ad: "Yok" },
    ...GIDER_KDV_ORANLARI.map((o) => ({ deger: o as number, ad: `%${o}` })),
  ];
  return (
    <div id={id} role="radiogroup" aria-label="KDV" className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5 w-fit">
      {secenekler.map((s) => {
        const secili = (value ?? null) === s.deger;
        return (
          <button
            key={s.ad}
            type="button"
            role="radio"
            aria-checked={secili}
            onClick={() => onChange(s.deger)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded-sm tabular-nums transition-all duration-200 active:scale-[0.96] motion-reduce:transition-none",
              secili
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s.ad}
          </button>
        );
      })}
    </div>
  );
}

/** Listede KDV'li gidere küçük etiket ("KDV %20"). KDV yoksa hiçbir şey çizmez. */
export function KdvEtiketi({ oran }: { oran: number | null | undefined }) {
  const metin = giderKdvEtiketi(oran);
  if (!metin) return null;
  return (
    <span className="inline-flex items-center text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full border bg-[#7A7EFF]/10 text-[#C9D2F2] border-[#7A7EFF]/30 tabular-nums animate-in fade-in duration-300 motion-reduce:animate-none">
      {metin}
    </span>
  );
}

/* ─────────────────────────── Dönem seçici ─────────────────────────── */

export function PeriyotSecici({
  value,
  onChange,
}: {
  value: PeriyotTipi;
  onChange: (v: PeriyotTipi) => void;
}) {
  return (
    <div className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5 w-fit">
      {PERIYOTLAR.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onChange(p.id)}
          className={cn(
            "px-3 py-1.5 text-sm font-medium rounded-sm transition-all active:scale-[0.97]",
            value === p.id
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {p.kisa}
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────── Özet şeridi ─────────────────────────── */

const KIYAS_BASLIGI: Record<PeriyotTipi, string> = {
  hafta: "Geçen haftanın aynı günlerine göre",
  ay: "Geçen ayın aynı günlerine göre",
  "3ay": "Önceki 3 ayın aynı süresine göre",
  "6ay": "Önceki 6 ayın aynı süresine göre",
  yil: "Geçen yılın aynı dönemine göre",
};

export function OzetSerit({
  toplam,
  adet,
  degisimYuzde,
  periyot,
  hazir = true,
}: {
  toplam: number;
  adet: number;
  degisimYuzde: number | null;
  periyot: PeriyotTipi;
  /** Veri gelmeden ya da gelemezse rakam yerine "—" (eskiden "₺0 / 0 ödeme" görünüyordu). */
  hazir?: boolean;
}) {
  const etiket = PERIYOTLAR.find((p) => p.id === periyot)?.label ?? "Bu dönem";
  const artti = degisimYuzde != null && degisimYuzde > 0;
  const azaldi = degisimYuzde != null && degisimYuzde < 0;
  return (
    <Card className="rounded-2xl border-0 bg-card ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
      <CardContent className="py-4 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">{etiket}</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums leading-none">
            {hazir ? <AnimatedNumber value={toplam} format={(n) => formatCurrency(n)} /> : <span className="text-muted-foreground/50">—</span>}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">Ödeme sayısı</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums leading-none">
            {hazir ? <AnimatedNumber value={adet} /> : <span className="text-muted-foreground/50">—</span>}
          </p>
        </div>
        <div className="min-w-0">
          {/* Önceki dönem bu dönemde geçen süre kadar alınır (bkz. core/expense-view esUzunluk). */}
          <p className="text-[11px] text-muted-foreground">{KIYAS_BASLIGI[periyot]}</p>
          <p
            className={cn(
              "mt-0.5 text-2xl font-bold tabular-nums leading-none",
              artti && "text-[#C9D2F2]",
              azaldi && "text-emerald-300"
            )}
          >
            {/* BİLİNMEYEN ≠ SIFIR: önceki dönemde hiç ödeme yoksa oran tanımsızdır;
                "%100 arttı" demek yanlış olurdu. */}
            {!hazir || degisimYuzde == null ? (
              <span className="text-muted-foreground/50">—</span>
            ) : (
              <>
                {/* İŞARET ŞART: mutlak değer yazınca "%34 arttı" ile "%34 azaldı" ekranda
                    aynı görünüyordu. Renk tek başına yeterli değil. */}
                {artti ? "+" : azaldi ? "−" : ""}
                <AnimatedNumber
                  value={degisimYuzde}
                  format={(n) => `%${Math.abs(n).toFixed(0)}`}
                />
              </>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── Kategori grafiği ─────────────────────────── */

/**
 * Halka grafik + tıklanabilir liste.
 *
 * Liste yalnız açıklama değil SÜZGEÇ: bir kategoriye tıklayınca aşağıdaki ödeme listesi
 * o kategoriye iniyor. Renk her zaman kategorinin kendi rengi — grafik ile listedeki
 * rozetlerin aynı rengi taşıması, "hangi dilim neydi" sorusunu ortadan kaldırıyor.
 */
export function KategoriGrafigi({
  dilimler,
  toplam,
  secili,
  onSec,
}: {
  dilimler: KategoriDilimi[];
  toplam: number;
  secili: string | null;
  onSec: (kategori: string | null) => void;
}) {
  const [vurgulu, setVurgulu] = useState<string | null>(null);
  const veri = useMemo(
    () => dilimler.map((d) => ({ name: d.kategori, value: d.toplam, renk: d.renk })),
    [dilimler]
  );

  if (dilimler.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Bu dönemde ödeme yok.
        </CardContent>
      </Card>
    );
  }

  const odak = vurgulu ?? secili;

  return (
    <Card>
      <CardContent className="p-4 grid gap-4 md:grid-cols-[200px_1fr] items-center">
        <div className="relative h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={veri}
                dataKey="value"
                nameKey="name"
                innerRadius={62}
                outerRadius={90}
                paddingAngle={2}
                stroke="none"
                isAnimationActive
                animationDuration={550}
                onMouseEnter={(_d, i) => setVurgulu(veri[i]?.name ?? null)}
                onMouseLeave={() => setVurgulu(null)}
                onClick={(_d, i) => {
                  const ad = veri[i]?.name ?? null;
                  onSec(secili === ad ? null : ad);
                }}
              >
                {veri.map((d) => (
                  <Cell
                    key={d.name}
                    fill={d.renk}
                    className="cursor-pointer transition-opacity"
                    opacity={odak == null || odak === d.name ? 1 : 0.28}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {/* Halkanın ortası boş durmasın: odaktaki dilimin tutarı, yoksa dönem toplamı. */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {odak ?? "Toplam"}
              </p>
              <p className="text-lg font-bold tabular-nums leading-tight">
                {formatCurrency(
                  odak ? (dilimler.find((d) => d.kategori === odak)?.toplam ?? 0) : toplam
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          {dilimler.map((d, i) => {
            const aktif = secili === d.kategori;
            return (
              <button
                key={d.kategori}
                type="button"
                onClick={() => onSec(aktif ? null : d.kategori)}
                onMouseEnter={() => setVurgulu(d.kategori)}
                onMouseLeave={() => setVurgulu(null)}
                style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                className={cn(
                  "w-full text-left rounded-lg border px-2.5 py-2 transition-all",
                  "animate-in fade-in slide-in-from-right-2 fill-mode-both duration-300",
                  aktif ? "border-primary/50 bg-primary/5" : "border-transparent hover:bg-muted/40"
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: d.renk }}
                    aria-hidden
                  />
                  <span className="text-sm font-medium truncate flex-1">{d.kategori}</span>
                  <span className="text-sm font-bold tabular-nums shrink-0">
                    {formatCurrency(d.toplam)}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums w-10 text-right shrink-0">
                    %{d.yuzde.toFixed(0)}
                  </span>
                </div>
                {/* Oran çubuğu: yüzdeyi okumadan da payı görürsün. */}
                <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.max(2, d.yuzde)}%`, background: d.renk }}
                  />
                </div>
              </button>
            );
          })}
          {secili && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs w-full"
              onClick={() => onSec(null)}
            >
              Süzgeci temizle
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
