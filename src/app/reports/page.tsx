"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, RefreshCw, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { useDakika, usePageHidden } from "@/lib/client-state";
import { RaporOzet } from "@/components/reports/rapor-ozet";
import { RaporTrend } from "@/components/reports/rapor-trend";
import { RaporDokum } from "@/components/reports/rapor-dokum";
import { RaporPlatformlar } from "@/components/reports/rapor-platformlar";
import { RaporUrunler } from "@/components/reports/rapor-urunler";
import { RaporGiderler, RaporKayiplar } from "@/components/reports/rapor-giderler";
import { AyiYenidenHesapla, RaporSaglik } from "@/components/reports/rapor-saglik";
import { freshnessLine, monthPeriodLabel, type FinanceResponse, type KarDokumuYaniti } from "./reports-view";
import {
  ayAdi,
  ayOzeti,
  aylikTrend,
  giderSatirlari,
  platformSatirlari,
  secilebilirAylar,
  selaleSatirlari,
} from "./rapor-gorunum";

/**
 * RAPORLAR — seçilen ayın tek bakışta özeti.
 *
 * Bütün rakamlar kayıtlı sipariş geçmişinden (`/api/finance/monthly`): Siparişler ekranının
 * hesapladığı ve yazdığı kâr. Ay seçilince sayfanın tamamı o aya geçer; "Kâr nereye gitti"
 * dökümü ayrı istenir (motorun prova turu) ve sayfayı bekletmez.
 */
export default function ReportsPage() {
  const queryClient = useQueryClient();
  const dakika = useDakika();
  const gizli = usePageHidden();

  const financeQuery = useQuery<FinanceResponse>({
    queryKey: ["finance-monthly", 12],
    queryFn: () => fetchJson<FinanceResponse>("/api/finance/monthly?months=12", { cache: "no-store" }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    // Genel varsayılan false; mount'ta bayatlık sorulmazsa düşürülen sorgu eski rakamla dönerdi.
    refetchOnMount: true,
    // Arka planda gelen siparişler sayfa açıkken de yansısın (pencere gizliyken sorulmaz).
    refetchInterval: gizli ? false : 2 * 60_000,
  });
  const finance = financeQuery.data;
  const timeZone = finance?.timeZone || "Europe/Istanbul";
  // Sunucu çiziminde 0 döner; zaman gerektiren hesaplar istemciye geçince yapılır.
  const simdi = dakika || 0;

  const aylar = useMemo(() => secilebilirAylar(finance?.months ?? []), [finance]);
  const [secim, setSecim] = useState<string | null>(null);
  const seciliAy = secim && aylar.some((a) => a.month === secim) ? secim : (aylar.at(-1)?.month ?? null);

  const ozet = useMemo(
    () => (finance && seciliAy && simdi ? ayOzeti(finance.months, seciliAy, finance.previousToDate, simdi, timeZone) : null),
    [finance, seciliAy, simdi, timeZone]
  );
  const trend = useMemo(() => (finance && simdi ? aylikTrend(finance.months, simdi, timeZone) : []), [finance, simdi, timeZone]);

  const dokumQuery = useQuery<KarDokumuYaniti>({
    queryKey: ["finance-dokum", seciliAy],
    queryFn: () => fetchJson<KarDokumuYaniti>(`/api/finance/monthly?section=dokum&month=${encodeURIComponent(seciliAy ?? "")}`),
    enabled: Boolean(seciliAy),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: true,
  });
  const selale = useMemo(
    () => (dokumQuery.data && ozet && dokumQuery.data.month === ozet.ay.month ? selaleSatirlari(dokumQuery.data, ozet.ay) : null),
    [dokumQuery.data, ozet]
  );
  // Döküm aylık özetten ESKİ okunmuşsa (arada sipariş geldi) bir kez yenilenir.
  const yenilenenDokum = useRef<number>(0);
  useEffect(() => {
    if (!selale?.eskimis || dokumQuery.isFetching) return;
    if (dokumQuery.dataUpdatedAt >= financeQuery.dataUpdatedAt) return;
    if (yenilenenDokum.current === financeQuery.dataUpdatedAt) return;
    yenilenenDokum.current = financeQuery.dataUpdatedAt;
    void dokumQuery.refetch();
  }, [selale?.eskimis, dokumQuery, financeQuery.dataUpdatedAt]);

  const [hesapAyi, setHesapAyi] = useState<string | null>(null);

  const yenile = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-dokum"] });
  };

  const tazelik = finance && simdi ? freshnessLine(finance.generatedAt, finance.lastOrderSyncAt, simdi) : null;
  const yukleniyor = !finance && financeQuery.isLoading;
  const hata = !finance && financeQuery.isError;
  // Duraklamış sorguda isError de isFetching de false — ayırmazsak ekran "rapor yok" der.
  const baglantiYok = !finance && financeQuery.fetchStatus === "paused";

  const ayVerisi = ozet?.ay ?? null;
  const urunAyi = seciliAy ? finance?.products?.byMonth?.[seciliAy] ?? null : null;
  const hazirlik = seciliAy ? finance?.recalcReadiness?.months.find((m) => m.month === seciliAy) : undefined;
  const yenidenHesaplanabilir = hazirlik?.recalculableOrders ?? 0;
  const eksikSiparis = ayVerisi?.incompleteOrders ?? 0;
  const karEksik = finance?.karEksik ?? null;
  const saglikGoster =
    yenidenHesaplanabilir > 0 || (eksikSiparis > 0 && ((karEksik?.urunler.length ?? 0) > 0 || (karEksik?.baglanmamis.length ?? 0) > 0));

  const donem = ozet
    ? ozet.ilerleme?.ongoing
      ? `${monthPeriodLabel(ozet.ay.month, ozet.ilerleme) ?? ayAdi(ozet.ay.month)} · bugüne kadar`
      : ayAdi(ozet.ay.month)
    : "";

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 p-6 pb-10">
      {/* BAŞLIK */}
      <header className="flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <BarChart3 className="size-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Raporlar</h1>
            <p className={cn("text-xs", tazelik?.stale ? "text-[#C9D2F2]" : "text-muted-foreground")}>
              {tazelik?.text ?? "Satışların, kârın ve giderlerin ay ay özeti."}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          {aylar.length > 0 && (
            <div className="flex min-w-0 gap-1 overflow-x-auto rounded-xl bg-white/[0.04] p-1 ring-1 ring-white/[0.08] [scrollbar-width:none]">
              {aylar.slice(-12).map((a) => {
                const aktif = a.month === seciliAy;
                return (
                  <button
                    key={a.month}
                    type="button"
                    onClick={() => setSecim(a.month)}
                    className={cn(
                      "relative shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 active:scale-[0.97]",
                      aktif
                        ? "bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] text-white shadow-[0_8px_20px_-10px_rgba(122,126,255,0.95)]"
                        : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                    )}
                    aria-pressed={aktif}
                    title={ayAdi(a.month)}
                  >
                    {ayAdi(a.month, false).slice(0, 3)}
                  </button>
                );
              })}
            </div>
          )}
          {seciliAy && (
            <button
              type="button"
              onClick={() => setHesapAyi(seciliAy)}
              title="Bu ayı güncel maliyetle yeniden hesapla"
              className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.08] transition hover:bg-white/[0.08] hover:text-foreground active:scale-95"
            >
              <RotateCcw className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={yenile}
            title="Yenile"
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.08] transition hover:bg-white/[0.08] hover:text-foreground active:scale-95"
          >
            <RefreshCw className={cn("size-4", (financeQuery.isFetching || dokumQuery.isFetching) && "animate-spin")} />
          </button>
        </div>
      </header>

      {yukleniyor || (finance && !simdi) ? (
        <Iskelet />
      ) : baglantiYok ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-card px-6 py-16 text-center ring-1 ring-white/[0.07]">
          <RefreshCw className="size-6 animate-spin text-muted-foreground/60 motion-reduce:animate-none" />
          <p className="text-sm text-muted-foreground">Bağlantı bekleniyor…</p>
        </div>
      ) : hata ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-card px-6 py-16 text-center ring-1 ring-white/[0.07]">
          <p className="text-sm text-muted-foreground">Raporlar şu an alınamadı.</p>
          <button
            type="button"
            onClick={() => void financeQuery.refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#7A7EFF] px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 active:scale-[0.98]"
          >
            <RefreshCw className="size-3.5" /> Tekrar dene
          </button>
        </div>
      ) : !ozet || !ayVerisi ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-card px-6 py-16 text-center ring-1 ring-white/[0.07]">
          <BarChart3 className="size-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">Henüz rapor yok</p>
          <p className="text-xs text-muted-foreground">İlk siparişler geldikçe burada ay ay görünecek.</p>
          <Link href="/orders" className="mt-2 text-xs text-[#A9AEFF] hover:underline">
            Siparişlere git
          </Link>
        </div>
      ) : (
        <div key={seciliAy} className="space-y-5">
          <RaporOzet ozet={ozet} donem={donem} trend={trend} />

          <div className="grid gap-5 xl:grid-cols-5">
            <RaporTrend
              aylar={trend}
              haftalar={finance?.weeks ?? []}
              secili={ozet.ay.month}
              onSec={setSecim}
              sira={5}
              className="xl:col-span-3"
            />
            <RaporPlatformlar satirlar={platformSatirlari(ayVerisi)} sira={6} className="xl:col-span-2" />
          </div>

          <div className="grid gap-5 xl:grid-cols-5">
            <RaporDokum
              selale={selale}
              yukleniyor={dokumQuery.isLoading || dokumQuery.isFetching}
              hata={dokumQuery.isError && !dokumQuery.data}
              onYenile={() => void dokumQuery.refetch()}
              sira={7}
              className="xl:col-span-3"
            />
            <div className="grid gap-5 xl:col-span-2">
              <RaporGiderler
                satirlar={giderSatirlari(ayVerisi, finance?.expenseCategories ?? [])}
                toplam={ayVerisi.expenses}
                sira={8}
              />
              <RaporKayiplar
                iade={ayVerisi.returnLoss ?? 0}
                iadeAdet={ayVerisi.returnLossOrders ?? 0}
                ceza={ayVerisi.penalty ?? 0}
                cezaAdet={ayVerisi.penaltyOrders ?? 0}
                sira={9}
              />
            </div>
          </div>

          <RaporUrunler ay={urunAyi} ayAdi={ayAdi(ozet.ay.month)} sira={10} />

          {saglikGoster && (
            <RaporSaglik
              eksikSiparis={eksikSiparis}
              karEksik={karEksik}
              yenidenHesaplanabilir={yenidenHesaplanabilir}
              onYenidenHesapla={() => setHesapAyi(ozet.ay.month)}
              sira={11}
            />
          )}
        </div>
      )}

      {hesapAyi && <AyiYenidenHesapla month={hesapAyi} onClose={() => setHesapAyi(null)} />}
    </div>
  );
}

function Iskelet() {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="h-[260px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06] lg:col-span-2" />
        <div className="grid grid-cols-2 gap-4 lg:col-span-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className="h-[122px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06]"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-5">
        <div className="h-[340px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06] xl:col-span-3" />
        <div className="h-[340px] animate-pulse rounded-2xl bg-card ring-1 ring-white/[0.06] xl:col-span-2" />
      </div>
    </div>
  );
}
