"use client";

/**
 * PAZARYERİ KARGO TARİFESİ — salt okunur görünüm (Trendyol / Hepsiburada).
 *
 * Fiyatlar kullanıcı tarafından düzenlenmez: pazaryerinin kendi listesidir ve `core/kargo-tarife.ts`
 * içinde dönem dönem tutulur. Sipariş kârı ve Ürünler ekranı aynı tabloyu kullanır.
 */

import { useMemo, useState } from "react";
import { ChevronDown, Lock, Zap, RotateCcw, Truck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  KARGO_FIRMA_ADLARI,
  KARGO_TARIFELERI,
  tarifeDonemiBul,
  type FirmaKodu,
  type KargoPlatformu,
  type TarifeDonemi,
} from "@/core/kargo-tarife";

const para = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tarih = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Istanbul" });

/** Barem tablosunda firmalar — kullanılan firma en üstte. */
function baremFirmalari(donem: TarifeDonemi): FirmaKodu[] {
  const hepsi = new Set<FirmaKodu>();
  for (const bant of donem.barem.bantlar) {
    for (const f of Object.keys(bant.standart) as FirmaKodu[]) hepsi.add(f);
  }
  return [donem.varsayilanFirma, ...[...hepsi].filter((f) => f !== donem.varsayilanFirma).sort()].filter((f) =>
    hepsi.has(f)
  );
}

function desiFirmalari(donem: TarifeDonemi): FirmaKodu[] {
  const hepsi = Object.keys(donem.desi) as FirmaKodu[];
  return [donem.varsayilanFirma, ...hepsi.filter((f) => f !== donem.varsayilanFirma)].filter((f) => donem.desi[f]);
}

function bantEtiketi(donem: TarifeDonemi, i: number): string {
  const alt = i === 0 ? 0 : donem.barem.bantlar[i - 1].ust + 0.01;
  return `${para.format(alt).replace(",00", "")}–${para.format(donem.barem.bantlar[i].ust)} ₺`;
}

/** Tutar hücresi — KDV anahtarı değişince yumuşak geçiş. */
function Tutar({ deger, kdvli, vurgu }: { deger: number | undefined; kdvli: boolean; vurgu?: boolean }) {
  if (deger == null) return <span className="text-muted-foreground/40">—</span>;
  const gosterilen = kdvli ? Math.round(deger * 1.2 * 100) / 100 : deger;
  return (
    <span
      key={kdvli ? "k" : "h"}
      className={cn(
        "tabular-nums animate-in fade-in zoom-in-95 duration-300",
        vurgu ? "font-semibold text-foreground" : "text-foreground/85"
      )}
    >
      {para.format(gosterilen)}
    </span>
  );
}

const ACIKLAMA: Record<KargoPlatformu, { barem: string; desi: string; kurallar: { ikon: typeof Zap; metin: string }[] }> = {
  trendyol: {
    barem: "350 ₺ altı ve 10 desiye kadar siparişlerde sabit fiyat.",
    desi: "350 ₺ ve üstü, 10 desi üstü siparişler ve iade kargosu.",
    kurallar: [
      { ikon: Zap, metin: "Hızlı teslimat etiketli ve zamanında kargolanan siparişe hızlı teslimat fiyatı uygulanır." },
      { ikon: Truck, metin: "Termini 1 gün olan ürünler hızlı teslimat etiketi alır." },
      { ikon: RotateCcw, metin: "İade kargosu desi fiyatından kesilir." },
    ],
  },
  hepsiburada: {
    barem: "400 ₺ altı ve 1 günde kargoya verilen siparişlerde sabit fiyat (hepsiJET, Sürat).",
    desi: "400 ₺ ve üstü ya da 2 gün ve üzeri kargoya verilen siparişler.",
    kurallar: [
      { ikon: Truck, metin: "Kargoya verme süresi 2 gün olan ürüne ayrıca hizmet bedeli kesilir." },
      { ikon: RotateCcw, metin: "İade kargosu gidişle aynı fiyattan kesilir." },
    ],
  },
};

const ILK_SATIR = 12;

export function PazaryeriTarifesi({
  platform,
  maxDesi,
}: {
  platform: KargoPlatformu;
  /** Ürünlerdeki en büyük desi — tabloda bu aralık işaretlenir. */
  maxDesi: number | null;
}) {
  const [kdvli, setKdvli] = useState(false);
  const [tumDesi, setTumDesi] = useState(false);
  // Sayfa açıkken sabit "şimdi" (render saf kalsın).
  const [simdi] = useState(() => new Date());
  const donem = useMemo(
    () => tarifeDonemiBul(platform, simdi) ?? KARGO_TARIFELERI[platform][KARGO_TARIFELERI[platform].length - 1],
    [platform, simdi]
  );
  const firmalarB = baremFirmalari(donem);
  const firmalarD = desiFirmalari(donem);
  const avantajliVar = donem.barem.bantlar.some((b) => b.avantajli);
  const satirSayisi = donem.desi[donem.varsayilanFirma]?.length ?? 31;
  // 0 ve 1 desi her firmada aynı fiyat → "0–1" tek satır; 2 desi bazı firmalarda farklı (Aras, Yurtiçi).
  const desiler = Array.from({ length: Math.max(0, satirSayisi - 1) }, (_, i) => i + 1);
  const gorunen = tumDesi ? desiler : desiler.slice(0, ILK_SATIR);
  const urunDesisi = maxDesi != null && maxDesi > 0 ? Math.max(1, Math.round(maxDesi)) : null;
  const aciklama = ACIKLAMA[platform];

  return (
    <div className="space-y-5">
      {/* Başlık şeridi */}
      <div className="flex flex-wrap items-center justify-between gap-3 animate-in fade-in slide-in-from-top-1 duration-300">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            <Lock className="h-3 w-3" />
            Pazaryeri fiyat listesi
          </span>
          <span className="text-xs text-muted-foreground">
            {tarih.format(donem.baslangic)} tarifesi · son kontrol {donem.kontrol}
          </span>
        </div>
        <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <Switch checked={kdvli} onCheckedChange={setKdvli} />
          {kdvli ? "KDV dahil" : "KDV hariç"}
        </label>
      </div>

      {/* SABİT FİYAT (BAREM) */}
      <section className="space-y-2 animate-in fade-in slide-in-from-bottom-1 duration-500">
        <div>
          <h3 className="text-sm font-semibold">Sabit fiyat</h3>
          <p className="text-xs text-muted-foreground">{aciklama.barem}</p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Firma</th>
                {donem.barem.bantlar.map((b, i) =>
                  avantajliVar ? (
                    <th key={i} colSpan={2} className="px-3 py-2 text-center font-medium">
                      {bantEtiketi(donem, i)}
                    </th>
                  ) : (
                    <th key={i} className="px-3 py-2 text-right font-medium">
                      {bantEtiketi(donem, i)}
                    </th>
                  )
                )}
              </tr>
              {avantajliVar && (
                <tr className="border-t border-border/40">
                  <th />
                  {donem.barem.bantlar.map((_, i) => (
                    <th key={i} colSpan={2} className="px-0 pb-1.5 font-normal">
                      <div className="grid grid-cols-2 text-[10px]">
                        <span className="flex items-center justify-end gap-1 px-3 text-sky-300">
                          <Zap className="h-2.5 w-2.5" />
                          Hızlı
                        </span>
                        <span className="px-3 text-right">Standart</span>
                      </div>
                    </th>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {firmalarB.map((f, satir) => {
                const bizim = f === donem.varsayilanFirma;
                return (
                  <tr
                    key={f}
                    style={{ animationDelay: `${satir * 35}ms` }}
                    className={cn(
                      "border-t border-border/40 transition-colors animate-in fade-in slide-in-from-left-1 fill-mode-backwards duration-300 hover:bg-muted/30",
                      bizim && "bg-primary/[0.07]"
                    )}
                  >
                    <td className="px-3 py-1.5">
                      <span className={cn(bizim && "font-semibold text-primary")}>{KARGO_FIRMA_ADLARI[f]}</span>
                      {bizim && <span className="ml-1.5 text-[10px] text-muted-foreground">kullanılan</span>}
                    </td>
                    {donem.barem.bantlar.map((b, i) =>
                      avantajliVar ? (
                        <td key={i} colSpan={2} className="px-0 py-1.5">
                          <div className="grid grid-cols-2">
                            <span className="px-3 text-right">
                              <Tutar deger={b.avantajli?.[f]} kdvli={kdvli} vurgu={bizim} />
                            </span>
                            <span className="px-3 text-right">
                              <Tutar deger={b.standart[f]} kdvli={kdvli} vurgu={bizim} />
                            </span>
                          </div>
                        </td>
                      ) : (
                        <td key={i} className="px-3 py-1.5 text-right">
                          <Tutar deger={b.standart[f]} kdvli={kdvli} vurgu={bizim} />
                        </td>
                      )
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* DESİ FİYATLARI */}
      <section className="space-y-2 animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-delay:120ms] fill-mode-backwards">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Desi fiyatları</h3>
            <p className="text-xs text-muted-foreground">{aciklama.desi}</p>
          </div>
          {urunDesisi != null && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-sm bg-primary/50" />
              Ürünlerinin desi aralığı
            </span>
          )}
        </div>
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Desi</th>
                {firmalarD.map((f) => (
                  <th
                    key={f}
                    className={cn(
                      "px-3 py-2 text-right font-medium",
                      f === donem.varsayilanFirma && "text-primary"
                    )}
                  >
                    {KARGO_FIRMA_ADLARI[f]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gorunen.map((d, satir) => {
                const urunAraliginda = urunDesisi != null && d <= urunDesisi;
                return (
                  <tr
                    key={d}
                    style={{ animationDelay: `${Math.min(satir, 14) * 20}ms` }}
                    className={cn(
                      "border-t border-border/40 transition-colors animate-in fade-in fill-mode-backwards duration-300 hover:bg-muted/30",
                      urunAraliginda && "bg-primary/[0.05]"
                    )}
                  >
                    <td className="px-3 py-1.5">
                      <span className={cn("tabular-nums", urunAraliginda && "font-medium text-primary")}>
                        {d === 1 ? "0–1" : d}
                      </span>
                    </td>
                    {firmalarD.map((f) => (
                      <td key={f} className="px-3 py-1.5 text-right">
                        <Tutar deger={donem.desi[f]?.[d]} kdvli={kdvli} vurgu={f === donem.varsayilanFirma} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {desiler.length > ILK_SATIR && (
          <button
            type="button"
            onClick={() => setTumDesi((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-80 active:scale-[0.98]"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-300", tumDesi && "rotate-180")} />
            {tumDesi ? "Daha az göster" : `${desiler.length} satırın tümünü göster`}
          </button>
        )}
      </section>

      {/* NASIL SEÇİLİYOR */}
      <section className="grid gap-2 sm:grid-cols-3">
        {aciklama.kurallar.map(({ ikon: Ikon, metin }, i) => (
          <div
            key={metin}
            style={{ animationDelay: `${200 + i * 60}ms` }}
            className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300 transition-colors hover:border-primary/30"
          >
            <Ikon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            {metin}
          </div>
        ))}
      </section>
    </div>
  );
}
