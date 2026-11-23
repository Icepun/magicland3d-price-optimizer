"use client";
/* eslint-disable @next/next/no-img-element */

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Package, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { thumbUrl } from "@/lib/image";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { useKaliciSecim } from "@/lib/kalici-secim";
import type { MonthlyProductSales, ProductProfitability, ProductSalesRow } from "@/app/reports/reports-view";
import { BosDurum, DolanCubuk, RaporKart } from "./rapor-ortak";

const SEKMELER = ["satan", "kazandiran", "birim"] as const;
type Sekme = (typeof SEKMELER)[number];
const SEKME_ADI: Record<Sekme, string> = { satan: "Çok satan", kazandiran: "Çok kazandıran", birim: "Birim kârlılık" };

export function RaporUrunler({
  ay,
  ayAdi,
  sira,
  className,
}: {
  ay: MonthlyProductSales | null;
  ayAdi: string;
  sira?: number;
  className?: string;
}) {
  const [sekme, setSekme] = useKaliciSecim<Sekme>("mlhub.raporlar.urun-sekme", "satan", SEKMELER);
  const karlilik = useQuery({
    queryKey: ["products", "profitability"],
    queryFn: () => fetchJson<ProductProfitability>("/api/finance/monthly?section=profitability"),
    enabled: sekme === "birim",
    staleTime: 2 * 60_000,
    gcTime: 30 * 60_000,
    // Anahtar ["products", …]: maliyet/fiyat değişince ürün düşürücüleri bunu da tazeler.
    refetchOnMount: true,
  });

  return (
    <RaporKart
      baslik="Ürünler"
      aciklama={sekme === "birim" ? "Bugünkü fiyat ve maliyetle bir adetten kalan" : ayAdi}
      ikon={<Trophy className="size-4" />}
      sira={sira}
      className={className}
      sag={
        <div className="flex rounded-lg bg-white/[0.05] p-0.5 ring-1 ring-white/[0.08]">
          {SEKMELER.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSekme(k)}
              className={cn(
                "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200",
                sekme === k
                  ? "bg-[#7A7EFF] text-white shadow-[0_6px_16px_-8px_rgba(122,126,255,0.9)]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {SEKME_ADI[k]}
            </button>
          ))}
        </div>
      }
    >
      <div key={`${sekme}-${ayAdi}`} className="animate-in fade-in duration-300">
        {sekme === "birim" ? (
          <BirimKarlilik veri={karlilik.data ?? null} yukleniyor={karlilik.isLoading} />
        ) : !ay || (sekme === "satan" ? ay.topSellers : ay.profitLeaders).length === 0 ? (
          <BosDurum ikon={<Package className="size-6" />} metin="Bu ay ürün satışı kayıtlı değil." />
        ) : (
          <SatisListesi satirlar={sekme === "satan" ? ay.topSellers : ay.profitLeaders} olcu={sekme === "satan" ? "adet" : "kar"} />
        )}
        {sekme !== "birim" && ay && (ay.unmatched.lines > 0 || ay.ordersWithoutItems > 0) && (
          <p className="mt-3 text-[11px] text-muted-foreground/80">
            {ay.unmatched.lines > 0 && `Ürüne bağlanmamış ${formatNumber(ay.unmatched.quantity)} adet satış listede yok.`}
            {ay.unmatched.lines > 0 && ay.ordersWithoutItems > 0 && " "}
            {ay.ordersWithoutItems > 0 && `${formatNumber(ay.ordersWithoutItems)} siparişin ürün bilgisi yok.`}
          </p>
        )}
      </div>
    </RaporKart>
  );
}

function SatisListesi({ satirlar, olcu }: { satirlar: ProductSalesRow[]; olcu: "adet" | "kar" }) {
  const deger = (s: ProductSalesRow) => (olcu === "adet" ? s.quantity : s.profit ?? 0);
  const enYuksek = Math.max(1, ...satirlar.map(deger));
  return (
    <ol className="grid gap-x-6 gap-y-1 md:grid-cols-2">
      {satirlar.map((s, i) => (
        <li
          key={s.productId}
          className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-400 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 40}ms` } as CSSProperties}
        >
          <Satir
            sira={i + 1}
            resim={s.imageUrl}
            ad={s.name}
            href={`/products/${s.productId}`}
            sag={
              olcu === "adet" ? (
                <>
                  <span className="font-semibold tabular-nums">{formatNumber(s.quantity)} adet</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{formatCurrency(s.revenue, { decimals: 0 })}</span>
                </>
              ) : (
                <>
                  <span className="font-semibold tabular-nums text-emerald-300">
                    {formatCurrency(s.profit ?? 0, { decimals: 0 })}
                    {s.profitPartial && <span className="ml-0.5 text-muted-foreground">*</span>}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{formatNumber(s.quantity)} adet</span>
                </>
              )
            }
            oran={deger(s) / enYuksek}
            gecikme={i * 40}
          />
        </li>
      ))}
    </ol>
  );
}

function BirimKarlilik({ veri, yukleniyor }: { veri: ProductProfitability | null; yukleniyor: boolean }) {
  if (!veri) {
    return yukleniyor ? (
      <div className="grid gap-2 md:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-11 animate-pulse rounded-xl bg-white/[0.04]" style={{ animationDelay: `${i * 70}ms` }} />
        ))}
      </div>
    ) : (
      <BosDurum metin="Liste şu an alınamadı." />
    );
  }
  const enYuksek = Math.max(1, ...veri.leaders.map((r) => r.netProfit ?? 0));
  return (
    <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-emerald-300/80">En kârlı</p>
        <ol className="space-y-1">
          {veri.leaders.slice(0, 6).map((r, i) => (
            <li key={r.id}>
              <Satir
                sira={i + 1}
                resim={r.imageUrl}
                ad={r.name}
                href={`/products/${r.id}`}
                sag={
                  <>
                    <span className="font-semibold tabular-nums text-emerald-300">{formatCurrency(r.netProfit, { decimals: 0 })}</span>
                    {r.profitMargin != null && (
                      <span className="text-[11px] tabular-nums text-muted-foreground">{formatPercent(r.profitMargin, 0)}</span>
                    )}
                  </>
                }
                oran={(r.netProfit ?? 0) / enYuksek}
                gecikme={i * 40}
              />
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-rose-300/80">Zarar edenler</p>
        {veri.losers.length === 0 ? (
          <p className="rounded-xl bg-emerald-500/[0.06] px-3 py-3 text-xs text-emerald-200/90 ring-1 ring-emerald-400/15">
            Zarar eden ürün yok.
          </p>
        ) : (
          <ol className="space-y-1">
            {veri.losers.slice(0, 6).map((r, i) => (
              <li key={r.id}>
                <Satir
                  sira={i + 1}
                  resim={r.imageUrl}
                  ad={r.name}
                  href={`/products/${r.id}`}
                  sag={<span className="font-semibold tabular-nums text-rose-300">{formatCurrency(r.netProfit, { decimals: 0 })}</span>}
                />
              </li>
            ))}
          </ol>
        )}
        {veri.missingCostProducts > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground/80">
            {formatNumber(veri.missingCostProducts)} ürünün maliyeti girilmemiş, listede yok.
          </p>
        )}
      </div>
    </div>
  );
}

function Satir({
  sira,
  resim,
  ad,
  href,
  sag,
  oran,
  gecikme = 0,
}: {
  sira: number;
  resim: string | null;
  ad: string;
  href?: string;
  sag: ReactNode;
  oran?: number;
  gecikme?: number;
}) {
  const kucuk = thumbUrl(resim, 80);
  const govde = (
    <div className="group flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-white/[0.04]">
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold tabular-nums",
          sira === 1 ? "bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white" : "bg-white/[0.06] text-muted-foreground"
        )}
      >
        {sira}
      </span>
      <span className="size-9 shrink-0 overflow-hidden rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08]">
        {kucuk ? (
          <img src={kucuk} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-110" loading="lazy" />
        ) : (
          <Package className="m-2.5 size-4 text-muted-foreground/50" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium group-hover:text-foreground">{ad}</p>
        {oran != null && <DolanCubuk oran={oran} renk="linear-gradient(90deg,#9B5CFF,#4F8CFF)" className="mt-1 h-1" gecikme={150 + gecikme} />}
      </div>
      <div className="flex shrink-0 flex-col items-end text-xs">{sag}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl outline-hidden focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60">
      {govde}
    </Link>
  ) : (
    govde
  );
}
