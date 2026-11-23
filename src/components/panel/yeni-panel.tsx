"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Coins,
  Disc3,
  LayoutDashboard,
  Package,
  PackageX,
  Printer,
  RefreshCw,
  Store,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { thumbUrl } from "@/lib/image";
import { formatCurrency, formatNumber, formatPercent, formatRelativeTime } from "@/lib/format";
import { useDakika, usePageHidden } from "@/lib/client-state";
import { gonderilecekSayisi } from "@/lib/panel-bugun";
import { zararGruplari } from "@/lib/panel-gruplama";
import { openHizliHesap } from "@/components/hizli-hesap/HizliHesap";
import { PlatformLogo } from "@/components/PlatformLogo";
import { countsAsSale } from "@/app/orders/siparis-filtre";
import type { FinanceResponse } from "@/app/reports/reports-view";
import { ayOzeti, aylikTrend, platformSatirlari } from "@/app/reports/rapor-gorunum";
import { monthPeriodLabel } from "@/app/reports/reports-view";
import { RaporOzet } from "@/components/reports/rapor-ozet";
import { RaporPlatformlar, PLATFORM_RENGI } from "@/components/reports/rapor-platformlar";
import { Adet, BosDurum, DolanCubuk, Para, RaporKart } from "@/components/reports/rapor-ortak";
import {
  PRICE_CHANGES_URL,
  type DashboardData,
  type PanelBugun,
  type PanelSiparisleri,
  type PlatformStats,
  type PriceChangesData,
} from "./panel-tipler";

const TZ = "Europe/Istanbul";
const PLATFORM_ADI = { trendyol: "Trendyol", hepsiburada: "Hepsiburada", shopify: "Shopify" } as const;
const gunAnahtari = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: TZ });

/** Panel — Raporlar'ın görsel dili: günün işleri, bu ayın özeti, katalog sağlığı, uyarılar. */
export function YeniPanel() {
  const queryClient = useQueryClient();
  const dakika = useDakika();
  const gizli = usePageHidden();

  const dashboard = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: ({ signal }) => fetchJson("/api/dashboard", { signal }),
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });
  const siparisler = useQuery<PanelSiparisleri>({
    queryKey: ["orders"],
    queryFn: ({ signal }) => fetchJson("/api/orders", { signal }),
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  });
  const bugun = useQuery<PanelBugun>({
    queryKey: ["panel-bugun"],
    queryFn: ({ signal }) => fetchJson("/api/panel/bugun", { signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const fiyat = useQuery<PriceChangesData>({
    queryKey: ["price-changes"],
    queryFn: ({ signal }) => fetchJson(PRICE_CHANGES_URL, { signal }),
    staleTime: Infinity,
    refetchOnMount: true,
  });
  // Bu ayın özeti Raporlar'la AYNI kaynaktan ve aynı bileşenle — iki ekran aynı rakamı gösterir.
  const finans = useQuery<FinanceResponse>({
    queryKey: ["finance-monthly", 12],
    queryFn: () => fetchJson<FinanceResponse>("/api/finance/monthly?months=12", { cache: "no-store" }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: true,
    refetchInterval: gizli ? false : 2 * 60_000,
  });

  const [yenileniyor, setYenileniyor] = useState(false);
  const kilit = useRef(false);
  const yenile = useCallback(() => {
    if (kilit.current) return;
    kilit.current = true;
    setYenileniyor(true);
    const taze = <T,>(key: unknown[], url: string) =>
      queryClient.fetchQuery<T>({ queryKey: key, queryFn: ({ signal }) => fetchJson<T>(url, { signal }), staleTime: 0 });
    void Promise.allSettled([
      taze(["dashboard"], "/api/dashboard?fresh=1"),
      taze(["orders"], "/api/orders?fresh=1"),
      taze(["price-changes"], `${PRICE_CHANGES_URL}&fresh=1`),
      queryClient.invalidateQueries({ queryKey: ["finance-monthly"] }),
    ]).finally(() => {
      kilit.current = false;
      setYenileniyor(false);
    });
  }, [queryClient]);

  const d = dashboard.data;
  const f = finans.data;
  const ayAnahtari = f?.months.at(-1)?.month ?? null;
  const ozet = useMemo(
    () => (f && ayAnahtari && dakika ? ayOzeti(f.months, ayAnahtari, f.previousToDate, dakika, f.timeZone || TZ) : null),
    [f, ayAnahtari, dakika]
  );
  const trend = useMemo(() => (f && dakika ? aylikTrend(f.months, dakika, f.timeZone || TZ) : []), [f, dakika]);

  // Bugünün satışı — canlı listeden, Siparişler'deki "Bugün" kutusuyla aynı kural.
  const bugunSatis = useMemo(() => {
    const liste = siparisler.data?.orders;
    if (!liste || !dakika) return null;
    const anahtar = gunAnahtari(dakika);
    let ciro = 0;
    let adet = 0;
    for (const o of liste) {
      if (!o.date || gunAnahtari(Date.parse(o.date)) !== anahtar) continue;
      if (!countsAsSale(o as never)) continue;
      ciro += o.total;
      adet++;
    }
    return { ciro, adet };
  }, [siparisler.data, dakika]);

  const tazelik = useMemo(() => {
    const damgalar = [d?.computedAt, siparisler.data?.computedAt, fiyat.data?.computedAt]
      .map((v) => (v == null ? null : new Date(v).getTime()))
      .filter((n): n is number => n != null && Number.isFinite(n));
    return damgalar.length ? Math.min(...damgalar) : null;
  }, [d, siparisler.data, fiyat.data]);

  // Elde veri varken hata: tazeleme düştü, ekrandaki rakamlar eski. Veri hiç yoksa kart kendi hatasını gösterir.
  const guncellenemedi = (dashboard.isError && !!d) || (finans.isError && !!f);
  // Veri gelmedi ≠ boş: hata ya da ağ kopukluğu (duraklamış sorgu) — iskelet sonsuza kadar dönmesin.
  const dashboardYok = !d && !dashboard.isLoading;
  const finansYok = !f && !finans.isLoading;
  const gonderilecek = siparisler.data?.orders ? gonderilecekSayisi(siparisler.data.orders) : null;
  const yz = bugun.data?.yazici;
  const biten = bugun.data?.bitenRenkler ?? null;
  const donem = ozet ? monthPeriodLabel(ozet.ay.month, ozet.ilerleme) : null;

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 p-6 pb-10">
      {/* BAŞLIK */}
      <header className="flex flex-wrap items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <LayoutDashboard className="size-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Panel</h1>
            <p className={cn("text-xs", guncellenemedi ? "text-rose-300" : "text-muted-foreground")}>
              {yenileniyor
                ? "Yenileniyor…"
                : guncellenemedi
                  ? `Güncellenemedi${tazelik && dakika ? ` · ${formatRelativeTime(new Date(tazelik))}` : ""}`
                  : tazelik && dakika
                    ? `${formatRelativeTime(new Date(tazelik))} güncellendi`
                    : "Günün işleri ve bu ayın özeti"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openHizliHesap}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] px-3.5 py-2 text-sm font-medium text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:-translate-y-px hover:brightness-110 active:scale-[0.97]"
          >
            <Calculator className="size-4" /> Hızlı hesap
          </button>
          <button
            type="button"
            onClick={yenile}
            disabled={yenileniyor}
            title="Yenile"
            className="grid size-9 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.08] transition hover:bg-white/[0.08] hover:text-foreground active:scale-95 disabled:opacity-70"
          >
            <RefreshCw className={cn("size-4", yenileniyor && "animate-spin")} />
          </button>
        </div>
      </header>

      {/* BUGÜN */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <BugunKutusu
          sira={0}
          href="/orders"
          ikon={<Coins className="size-4" />}
          baslik="Bugün satış"
          deger={bugunSatis ? <Para deger={bugunSatis.ciro} /> : <span className="text-muted-foreground">—</span>}
          alt={bugunSatis ? (bugunSatis.adet === 0 ? "Henüz sipariş yok" : `${formatNumber(bugunSatis.adet)} sipariş`) : " "}
        />
        <BugunKutusu
          sira={1}
          href="/orders"
          ikon={<ClipboardList className="size-4" />}
          baslik="Gönderilecek"
          deger={gonderilecek == null ? <span className="text-muted-foreground">—</span> : <Adet deger={gonderilecek} />}
          alt={gonderilecek === 0 ? "Bekleyen sipariş yok" : "sipariş kargo bekliyor"}
          vurgu={gonderilecek != null && gonderilecek > 0 ? "mor" : undefined}
        />
        <BugunKutusu
          sira={2}
          href={yz && yz.sorunlu.length > 0 ? "/printers" : "/planner"}
          ikon={<Printer className="size-4" />}
          baslik={yz && yz.sorunlu.length > 0 ? "Yazıcıda sorun" : "Boştaki yazıcı"}
          deger={
            !yz ? (
              <span className="text-muted-foreground">—</span>
            ) : yz.sorunlu.length > 0 ? (
              <Adet deger={yz.sorunlu.length} />
            ) : (
              <Adet deger={yz.bosta.length} />
            )
          }
          alt={
            !yz
              ? bugun.isError
                ? "Okunamadı"
                : " "
              : yz.sorunlu.length > 0
                ? `${yz.sorunlu.join(" · ")} durdu`
                : yz.bosta.length > 0
                  ? yz.bosta.join(" · ")
                  : yz.basiyor > 0
                    ? `Hepsi basıyor (${yz.basiyor})`
                    : "Durum bilinmiyor"
          }
          vurgu={yz && yz.sorunlu.length > 0 ? "kirmizi" : undefined}
        />
        <BugunKutusu
          sira={3}
          href="/spools"
          ikon={<Disc3 className="size-4" />}
          baslik="Biten filament"
          deger={biten == null ? <span className="text-muted-foreground">—</span> : <Adet deger={biten.length} />}
          alt={biten == null ? (bugun.isError ? "Okunamadı" : " ") : biten.length === 0 ? "Biten renk yok" : biten.join(" · ")}
          vurgu={biten && biten.length > 0 ? "kirmizi" : undefined}
        />
      </div>

      {/* BU AY */}
      <div className="space-y-3">
        <div className="flex items-center justify-between animate-in fade-in duration-500">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Bu ay {donem && <span className="text-xs font-normal text-muted-foreground">· {donem}</span>}
          </h2>
          <Link
            href="/reports"
            className="group inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
          >
            <BarChart3 className="size-3.5" /> Raporlar
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
        {ozet ? (
          <RaporOzet ozet={ozet} donem={donem ? `${donem} · bugüne kadar` : ""} trend={trend} />
        ) : finansYok ? (
          <Yuklenemedi metin="Bu ayın özeti şu an yüklenemedi." onRetry={() => void finans.refetch()} deneniyor={finans.isFetching} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="h-[260px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06] lg:col-span-2" />
            <div className="grid grid-cols-2 gap-4 lg:col-span-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[122px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06]" style={{ animationDelay: `${i * 90}ms` }} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-5">
        {ozet ? (
          <RaporPlatformlar satirlar={platformSatirlari(ozet.ay)} sira={5} className="xl:col-span-2" />
        ) : (
          <div className="h-[260px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06] xl:col-span-2" />
        )}
        <IlanSagligi
          platformlar={d?.platforms ?? null}
          hata={dashboardYok ? () => void dashboard.refetch() : null}
          sira={6}
          className="xl:col-span-3"
        />
      </div>

      {/* KATALOG */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KatalogKutusu
          sira={7}
          href="/products"
          ikon={<Package className="size-4" />}
          baslik="Toplam ürün"
          deger={d?.totalProducts}
          alt={
            d
              ? `Stokta ${d.inStockCount} · Biten ${d.outOfStockCount} · Sipariş üzerine ${Math.max(0, d.totalProducts - d.inStockCount - d.outOfStockCount)}`
              : " "
          }
        />
        <KatalogKutusu
          sira={8}
          href="/products?filter=missing-cost"
          ikon={<AlertTriangle className="size-4" />}
          baslik="Maliyeti eksik"
          deger={d?.missingCost}
          birim="ürün"
          alt="Kârı hesaplanamıyor"
          ton={d && d.missingCost > 0 ? "mor" : "yesil"}
        />
        <KatalogKutusu
          sira={9}
          href="/products?filter=negative-profit"
          ikon={<TrendingDown className="size-4" />}
          baslik="Zarar eden ilan"
          deger={d?.negativeListings}
          birim="ilan"
          alt="Fiyatına bak"
          ton={d && d.negativeListings > 0 ? "kirmizi" : "yesil"}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-5">
        <AcilMudahale data={d ?? null} hata={dashboardYok ? () => void dashboard.refetch() : null} sira={10} className="xl:col-span-3" />
        <FiyatHareketleri
          data={fiyat.data ?? null}
          yukleniyor={fiyat.isLoading}
          hata={!fiyat.data && !fiyat.isLoading ? () => void fiyat.refetch() : null}
          sira={11}
          className="xl:col-span-2"
        />
      </div>

      <DusukStok data={d ?? null} hata={dashboardYok ? () => void dashboard.refetch() : null} sira={12} />
    </div>
  );
}

/* ── Kutular ──────────────────────────────────────────────────────────────────────────── */

const VURGU = {
  mor: "from-[#9B5CFF]/20 to-[#4F8CFF]/10 ring-[#7A7EFF]/30",
  kirmizi: "from-rose-500/15 to-rose-500/5 ring-rose-400/25",
} as const;

function BugunKutusu({
  sira,
  href,
  ikon,
  baslik,
  deger,
  alt,
  vurgu,
}: {
  sira: number;
  href: string;
  ikon: ReactNode;
  baslik: string;
  deger: ReactNode;
  alt: string;
  vurgu?: keyof typeof VURGU;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl bg-card p-4 ring-1 ring-white/[0.07] outline-hidden",
        "transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] hover:shadow-[0_20px_40px_-30px_rgba(122,126,255,0.55)] focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60",
        "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none motion-reduce:hover:translate-y-0",
        vurgu && cn("bg-gradient-to-br", VURGU[vurgu])
      )}
      style={{ animationDelay: `${sira * 60}ms` } as CSSProperties}
    >
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span
          className={cn(
            "grid size-7 place-items-center rounded-lg ring-1 transition-colors",
            vurgu === "kirmizi"
              ? "bg-rose-500/15 text-rose-300 ring-rose-400/20"
              : "bg-white/[0.05] text-[#C9D2F2] ring-white/[0.08] group-hover:bg-[#7A7EFF]/15"
          )}
        >
          {ikon}
        </span>
        {baslik}
        <ArrowRight className="ml-auto size-3.5 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-60" />
      </span>
      <div className="mt-3 text-2xl font-semibold tracking-tight">{deger}</div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{alt}</p>
    </Link>
  );
}

const TON = {
  mor: "text-[#A9AEFF]",
  kirmizi: "text-rose-300",
  yesil: "text-emerald-300",
} as const;

function KatalogKutusu({
  sira,
  href,
  ikon,
  baslik,
  deger,
  birim,
  alt,
  ton,
}: {
  sira: number;
  href: string;
  ikon: ReactNode;
  baslik: string;
  deger: number | undefined;
  birim?: string;
  alt: string;
  ton?: keyof typeof TON;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center gap-4 rounded-2xl bg-card p-4 ring-1 ring-white/[0.07] outline-hidden",
        "transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60",
        "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none"
      )}
      style={{ animationDelay: `${sira * 60}ms` } as CSSProperties}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#9B5CFF]/20 to-[#4F8CFF]/15 text-[#C9D2F2] ring-1 ring-white/10 transition-transform duration-300 group-hover:scale-105">
        {ikon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{baslik}</p>
        <p className={cn("text-2xl font-semibold tracking-tight", ton && TON[ton])}>
          {deger == null ? "—" : <Adet deger={deger} />}
          {birim && deger != null && <span className="ml-1 text-sm font-normal text-muted-foreground">{birim}</span>}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{alt}</p>
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </Link>
  );
}

/* ── İlan sağlığı ─────────────────────────────────────────────────────────────────────── */

function IlanSagligi({
  platformlar,
  hata,
  sira,
  className,
}: {
  platformlar: PlatformStats[] | null;
  hata: (() => void) | null;
  sira?: number;
  className?: string;
}) {
  return (
    <RaporKart baslik="İlan sağlığı" aciklama="Bugünkü fiyat ve maliyetle" ikon={<Store className="size-4" />} sira={sira} className={className}>
      {!platformlar && hata ? (
        <Yuklenemedi metin="İlan özeti şu an yüklenemedi." onRetry={hata} />
      ) : !platformlar ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-white/[0.04]" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {platformlar.map((p, i) => {
            const renk = PLATFORM_RENGI[p.platform];
            return (
              <li
                key={p.platform}
                className="rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.03] animate-in fade-in slide-in-from-right-2 fill-mode-both duration-500 motion-reduce:animate-none"
                style={{ animationDelay: `${i * 70}ms` } as CSSProperties}
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-white/10" style={{ background: `${renk}22`, color: renk }}>
                    <PlatformLogo platform={p.platform} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{PLATFORM_ADI[p.platform]}</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{formatNumber(p.activeListings)} ilan</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <DolanCubuk oran={Math.max(0, p.averageMargin ?? 0)} renk={renk} className="flex-1" gecikme={150 + i * 70} />
                      <span className="w-12 text-right text-xs font-semibold tabular-nums" style={{ color: renk }}>
                        {p.averageMargin == null ? "—" : formatPercent(p.averageMargin, 0)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 pl-11 text-[11px]">
                  <span className={cn("rounded-full px-2 py-0.5 ring-1", p.negativeProfitCount > 0 ? "bg-rose-500/10 text-rose-200 ring-rose-400/20" : "bg-white/[0.04] text-muted-foreground ring-white/[0.08]")}>
                    {p.negativeProfitCount > 0 ? `${p.negativeProfitCount} zararda` : "Zararda ilan yok"}
                  </span>
                  {p.missingCostListings > 0 && (
                    <Link
                      href="/products?filter=missing-cost"
                      className="rounded-full bg-[#7A7EFF]/10 px-2 py-0.5 text-[#C9D2F2] ring-1 ring-[#7A7EFF]/25 transition hover:bg-[#7A7EFF]/20"
                    >
                      {p.missingCostListings} ilanın maliyeti eksik →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </RaporKart>
  );
}

/* ── Fiyat hareketleri ────────────────────────────────────────────────────────────────── */

function FiyatHareketleri({
  data,
  yukleniyor,
  hata,
  sira,
  className,
}: {
  data: PriceChangesData | null;
  yukleniyor: boolean;
  hata: (() => void) | null;
  sira?: number;
  className?: string;
}) {
  return (
    <RaporKart
      baslik="Fiyat hareketleri"
      aciklama={data ? `Son ${data.days} gün · ${formatNumber(data.productsAffected)} ürün` : "Son 30 gün"}
      ikon={<Activity className="size-4" />}
      sira={sira}
      className={className}
    >
      {!data ? (
        yukleniyor ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-white/[0.04]" style={{ animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
        ) : (
          <Yuklenemedi metin="Fiyat hareketleri şu an alınamadı." onRetry={hata ?? undefined} />
        )
      ) : data.totalChanges === 0 ? (
        <BosDurum metin={`Son ${data.days} günde fiyat değişmedi.`} />
      ) : (
        <ul className="space-y-0.5">
          {data.recent.slice(0, 7).map((it, i) => {
            const y = it.changePercent;
            const bilinir = typeof y === "number" && Number.isFinite(y);
            const artis = bilinir && y >= 0;
            return (
              <li
                key={it.productId}
                className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-400 motion-reduce:animate-none"
                style={{ animationDelay: `${i * 40}ms` } as CSSProperties}
              >
                <Link
                  href={`/products/${it.productId}`}
                  className="group flex items-center gap-3 rounded-lg px-2 py-1.5 outline-hidden transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{it.productName}</p>
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {formatCurrency(it.firstPrice, { decimals: 0 })} → {formatCurrency(it.lastPrice, { decimals: 0 })}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ring-1",
                      !bilinir
                        ? "bg-white/[0.04] text-muted-foreground ring-white/10"
                        : artis
                          ? "bg-emerald-500/12 text-emerald-300 ring-emerald-400/20"
                          : "bg-rose-500/12 text-rose-300 ring-rose-400/20"
                    )}
                  >
                    {bilinir && (artis ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />)}
                    {bilinir ? formatPercent(Math.abs(y) / 100, 0) : "—"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </RaporKart>
  );
}

/* ── Acil müdahale ────────────────────────────────────────────────────────────────────── */

function AcilMudahale({
  data,
  hata,
  sira,
  className,
}: {
  data: DashboardData | null;
  hata: (() => void) | null;
  sira?: number;
  className?: string;
}) {
  const zararlar = data ? data.problemProducts.filter((p) => p.problem !== "missing_cost") : [];
  const gruplar = zararGruplari(zararlar).slice(0, 6);
  const maliyetEksik = data ? data.problemProducts.filter((p) => p.problem === "missing_cost") : [];
  const maliyetToplam = maliyetEksik.length + (data?.problemMoreMissingCost ?? 0);
  const kalanZarar = data?.problemMoreNegative ?? 0;
  return (
    <RaporKart
      baslik="Acil müdahale"
      aciklama={data ? `${formatNumber(data.problemTotal)} ürün ya da ilan` : " "}
      ikon={<AlertTriangle className="size-4" />}
      sira={sira}
      className={className}
    >
      {!data && hata ? (
        <Yuklenemedi metin="Acil müdahale listesi şu an yüklenemedi." onRetry={hata} />
      ) : !data ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-white/[0.04]" style={{ animationDelay: `${i * 70}ms` }} />
          ))}
        </div>
      ) : data.problemProducts.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-emerald-500/[0.06] px-4 py-4 text-sm text-emerald-100/90 ring-1 ring-emerald-400/15">
          <CheckCircle2 className="size-5 text-emerald-300" /> Tüm ürün ve ilanlar sağlıklı.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {gruplar.map((g, i) => {
            const ilk = g.satirlar[0];
            const renk = ilk.platform ? PLATFORM_RENGI[ilk.platform] : "#C9D2F2";
            return (
              <li
                key={g.anahtar}
                className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-400 motion-reduce:animate-none"
                style={{ animationDelay: `${i * 45}ms` } as CSSProperties}
              >
                <Link
                  href={`/products/${ilk.id}`}
                  className="group flex items-center gap-3 rounded-lg px-2 py-2 outline-hidden transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60"
                >
                  <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: `${renk}1f`, color: renk }}>
                    {ilk.platform ? PLATFORM_ADI[ilk.platform] : "Ürün"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {g.ad}
                      {g.satirlar.length > 1 && <span className="ml-1.5 text-[10px] text-muted-foreground">{g.satirlar.length} varyant</span>}
                    </p>
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      İlan fiyatı {formatCurrency(g.fiyatAralik[0], { decimals: 0 })}
                      {g.fiyatAralik[1] !== g.fiyatAralik[0] && ` – ${formatCurrency(g.fiyatAralik[1], { decimals: 0 })}`}
                    </p>
                  </div>
                  {g.karAralik && (
                    <span className="shrink-0 rounded-full bg-rose-500/12 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-rose-300 ring-1 ring-rose-400/20">
                      {formatCurrency(g.karAralik[0], { decimals: 0 })}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
          {maliyetToplam > 0 && (
            <li>
              <Link
                href="/products?filter=missing-cost"
                className="group mt-1 flex items-center justify-between gap-3 rounded-xl bg-[#7A7EFF]/[0.07] px-3 py-2.5 outline-hidden ring-1 ring-[#7A7EFF]/20 transition hover:bg-[#7A7EFF]/[0.12] focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-[#C9D2F2]">{formatNumber(maliyetToplam)} ürünün maliyeti girilmemiş</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{maliyetEksik.slice(0, 3).map((p) => p.name).join(" · ")}</span>
                </span>
                <span className="shrink-0 text-xs font-medium text-[#A9AEFF] transition-transform group-hover:translate-x-0.5">Maliyet gir →</span>
              </Link>
            </li>
          )}
          {kalanZarar > 0 && (
            <li>
              <Link href="/products?filter=negative-profit" className="mt-1 block px-2 text-[11px] text-muted-foreground transition hover:text-foreground">
                +{formatNumber(kalanZarar)} zarar eden ilan daha →
              </Link>
            </li>
          )}
        </ul>
      )}
    </RaporKart>
  );
}

/* ── Düşük stok ───────────────────────────────────────────────────────────────────────── */

const STOK_ILK = 12;

function DusukStok({ data, hata, sira }: { data: DashboardData | null; hata: (() => void) | null; sira?: number }) {
  const [acik, setAcik] = useState(false);
  const tumu = data?.lowStockProducts ?? [];
  const gorunen = acik ? tumu : tumu.slice(0, STOK_ILK);
  const bitenToplam = (data?.lowStockMoreOutOfStock ?? 0) + tumu.filter((p) => p.stock === 0).length;
  return (
    <RaporKart
      baslik="Düşük stok"
      aciklama={data ? (data.lowStockCount > 0 ? `${formatNumber(data.lowStockCount)} ürün · ${formatNumber(bitenToplam)} tanesi bitti` : "Her şey yolunda") : " "}
      ikon={<PackageX className="size-4" />}
      sira={sira}
      sag={
        data && (data.lowStockMoreOutOfStock ?? 0) > 0 ? (
          <Link
            href="/products?filter=out-of-stock"
            className="group inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
          >
            Bitenler <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
          </Link>
        ) : undefined
      }
    >
      {!data && hata ? (
        <Yuklenemedi metin="Düşük stok listesi şu an yüklenemedi." onRetry={hata} />
      ) : !data ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-white/[0.04]" style={{ animationDelay: `${i * 50}ms` }} />
          ))}
        </div>
      ) : data.lowStockCount === 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-emerald-500/[0.06] px-4 py-4 text-sm text-emerald-100/90 ring-1 ring-emerald-400/15">
          <CheckCircle2 className="size-5 text-emerald-300" /> Stoğu biten ya da azalan ürün yok.
        </div>
      ) : (
        <>
          <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
            {gorunen.map((p, i) => (
              <li
                key={p.id}
                className="animate-in fade-in zoom-in-95 fill-mode-both duration-300 motion-reduce:animate-none"
                style={{ animationDelay: `${Math.min(i, 16) * 25}ms` } as CSSProperties}
              >
                <Link
                  href={`/products/${p.id}`}
                  className="group flex items-center gap-2.5 rounded-xl px-2 py-1.5 outline-hidden ring-1 ring-transparent transition hover:bg-white/[0.04] hover:ring-white/[0.08] focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60"
                >
                  <span className="size-9 shrink-0 overflow-hidden rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08]">
                    {p.imageUrl ? (
                      <img src={thumbUrl(p.imageUrl, 80) ?? ""} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-110" loading="lazy" />
                    ) : (
                      <Package className="m-2.5 size-4 text-muted-foreground/50" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{p.name}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ring-1",
                      p.stock === 0 ? "bg-rose-500/12 text-rose-300 ring-rose-400/20" : "bg-[#7A7EFF]/12 text-[#C9D2F2] ring-[#7A7EFF]/25"
                    )}
                  >
                    {p.stock === 0 ? "Bitti" : `${p.stock} adet`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {tumu.length > STOK_ILK && (
            <button
              type="button"
              onClick={() => setAcik((v) => !v)}
              className="mx-auto mt-3 flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
            >
              {acik ? "Daha az göster" : `+${formatNumber(tumu.length - STOK_ILK)} ürün daha`}
              <ChevronDown className={cn("size-3.5 transition-transform duration-300", acik && "rotate-180")} />
            </button>
          )}
        </>
      )}
    </RaporKart>
  );
}

/** Veri gelmedi (hata ya da ağ kopuk) — "yok" demez, yeniden denetir. */
function Yuklenemedi({ metin, onRetry, deneniyor = false }: { metin: string; onRetry?: () => void; deneniyor?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-white/[0.02] px-4 py-8 text-center text-sm text-muted-foreground ring-1 ring-white/[0.06]">
      {metin}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={deneniyor}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-white/10 transition hover:bg-white/[0.1] active:scale-[0.98] disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", deneniyor && "animate-spin")} /> Tekrar dene
        </button>
      )}
    </div>
  );
}
