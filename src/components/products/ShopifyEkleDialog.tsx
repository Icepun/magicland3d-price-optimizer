"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  EyeOff,
  ExternalLink,
  Link2,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingBag,
  Trash2,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { fetchJson } from "@/lib/fetch-json";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  varyantTamAdi,
  type FarkUrunu,
  type FarkVaryanti,
  type KalkanUrun,
  type KatalogFarki,
} from "@/lib/shopify-katalog";

type KatalogYaniti = { bagli: false } | ({ bagli: true; magaza: string } & KatalogFarki);
type Sekme = "yeni" | "kalkan" | "gizli";

export const SHOPIFY_KATALOG_ANAHTARI = ["shopify-katalog"] as const;
export const SHOPIFY_OZET_ANAHTARI = ["shopify-katalog-ozet"] as const;

/** Tek istekte en fazla bu kadar ürün (ilerleme çubuğu dilim dilim dolar). */
const DILIM = 5;

interface Taslak {
  ad: string;
  /** Kullanıcı adı elle değiştirdi mi? (Değiştirmediyse seçim değişince ad kendini uyarlar.) */
  adDegisti: boolean;
  siparisUzerine: boolean;
  stok: string;
  varyantlar: Record<string, { secili: boolean; etiket: string }>;
}

function varsayilanAd(u: FarkUrunu, seciliVaryantlar: FarkVaryanti[]): string {
  return seciliVaryantlar.length === 1 ? varyantTamAdi(u.baslik, seciliVaryantlar[0].etiket) : u.baslik;
}

function varsayilanTaslak(u: FarkUrunu): Taslak {
  return {
    ad: varsayilanAd(u, u.varyantlar),
    adDegisti: false,
    siparisUzerine: true,
    stok: "0",
    varyantlar: Object.fromEntries(u.varyantlar.map((v) => [v.id, { secili: true, etiket: v.etiket }])),
  };
}

/** Shopify görselinin küçük hâli (liste 80 görselle açılıyor; tam boy gereksiz). */
function kucukGorsel(url: string | null, genislik = 160): string | null {
  if (!url) return null;
  if (!/cdn\.shopify\.com|\/cdn\/shop\//.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${genislik}`;
}

function normalize(s: string): string {
  return s.toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tarihKisa(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
}

function fiyatAraligi(v: readonly { fiyat: number }[]): string {
  const fiyatlar = v.map((x) => x.fiyat).filter((x) => x > 0);
  if (fiyatlar.length === 0) return "—";
  const min = Math.min(...fiyatlar);
  const max = Math.max(...fiyatlar);
  return min === max ? formatCurrency(min) : `${formatCurrency(min)} – ${formatCurrency(max)}`;
}

function Gorsel({ src, alt, boyut = 56 }: { src: string | null; alt: string; boyut?: number }) {
  const [yuklendi, setYuklendi] = useState(false);
  const kucuk = kucukGorsel(src, boyut * 3);
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border bg-muted"
      style={{ width: boyut, height: boyut }}
    >
      {kucuk ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={kucuk}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setYuklendi(true)}
          className={cn(
            "h-full w-full object-cover transition-[opacity,transform] duration-500",
            yuklendi ? "opacity-100 scale-100" : "opacity-0 scale-105"
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Package className="h-5 w-5 text-muted-foreground/60" />
        </div>
      )}
    </div>
  );
}

/**
 * SHOPIFY'DAN ÜRÜN EKLE — mağazadaki, uygulamada olmayan ürünler.
 *
 *   Yeni      → seç, adını ver, ekle (görsel ve fiyat Shopify'dan). Benzeri varsa "bağla".
 *   Kalkanlar → uygulamada olup Shopify'dan kaldırılanlar: gizle, sil ya da yeni hâline bağla.
 *   Gizlenen  → "bunu ekleme" denenler; geri alınabilir.
 */
export function ShopifyEkleDialog({ onClose, ilkSekme = "yeni" }: { onClose: () => void; ilkSekme?: Sekme }) {
  const qc = useQueryClient();
  const [sekme, setSekme] = useState<Sekme>(ilkSekme);
  const [arama, setArama] = useState("");
  const [acik, setAcik] = useState<string | null>(null);
  const [secili, setSecili] = useState<Set<string>>(new Set());
  const [taslaklar, setTaslaklar] = useState<Record<string, Taslak>>({});
  const [cikanlar, setCikanlar] = useState<Set<string>>(new Set());
  const [ilerleme, setIlerleme] = useState<{ biten: number; toplam: number } | null>(null);
  const [tazeleniyor, setTazeleniyor] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<KatalogYaniti>({
    queryKey: SHOPIFY_KATALOG_ANAHTARI,
    queryFn: () => fetchJson("/api/shopify/katalog"),
    staleTime: 60_000,
    refetchOnMount: true,
  });
  const fark = data && data.bagli ? data : null;

  /** Ürün eklendi/bağlandı/silindi → pencere, rozet ve ürün listesi birlikte tazelensin. */
  const tazelenmeli = () => {
    void qc.invalidateQueries({ queryKey: SHOPIFY_KATALOG_ANAHTARI });
    void qc.invalidateQueries({ queryKey: SHOPIFY_OZET_ANAHTARI });
    void qc.invalidateQueries({ queryKey: ["products"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" });
  };

  /** Kartı kayarak çıkar, sonra listeden düşür (sunucu yanıtını beklemeden). */
  const cikar = (anahtarlar: string[]) => {
    setCikanlar((s) => new Set([...s, ...anahtarlar]));
    setSecili((s) => {
      const y = new Set(s);
      for (const a of anahtarlar) y.delete(a);
      return y;
    });
    if (acik && anahtarlar.includes(acik)) setAcik(null);
  };

  const taslakAl = (u: FarkUrunu): Taslak => taslaklar[u.id] ?? varsayilanTaslak(u);
  const taslakDegistir = (u: FarkUrunu, degis: (t: Taslak) => Taslak) =>
    setTaslaklar((t) => ({ ...t, [u.id]: degis(t[u.id] ?? varsayilanTaslak(u)) }));

  /** Seçilen ürünleri dilim dilim ekler; ilerleme GERÇEK (biten ürün / toplam). */
  async function ekle(urunler: FarkUrunu[]) {
    if (ilerleme || urunler.length === 0) return;
    const istekler = urunler
      .map((u) => {
        const t = taslakAl(u);
        const varyantlar = u.varyantlar
          .filter((v) => t.varyantlar[v.id]?.secili !== false)
          .map((v) => ({ id: v.id, etiket: t.varyantlar[v.id]?.etiket?.trim() || v.etiket || null }));
        return {
          urun: u,
          govde: {
            shopifyUrunId: u.id,
            ad: t.ad.trim(),
            siparisUzerine: t.siparisUzerine,
            stok: Math.max(0, Math.floor(Number(t.stok.replace(",", ".")) || 0)),
            varyantlar,
          },
        };
      })
      .filter((x) => x.govde.varyantlar.length > 0);
    if (istekler.length === 0) {
      toast.error("En az bir seçenek seç");
      return;
    }
    setIlerleme({ biten: 0, toplam: istekler.length });
    let eklenen = 0;
    const atlananlar: string[] = [];
    try {
      for (let i = 0; i < istekler.length; i += DILIM) {
        const dilim = istekler.slice(i, i + DILIM);
        const r = await fetchJson<{ eklenen: number; atlanan: { ad: string; neden: string }[] }>(
          "/api/shopify/urun-ekle",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urunler: dilim.map((d) => d.govde) }),
          }
        );
        eklenen += r.eklenen;
        atlananlar.push(...r.atlanan.map((a) => `${a.ad}: ${a.neden}`));
        cikar(dilim.map((d) => d.urun.id));
        setIlerleme({ biten: Math.min(istekler.length, i + dilim.length), toplam: istekler.length });
      }
      if (eklenen > 0) toast.success(eklenen === 1 ? "Ürün eklendi" : `${eklenen} ürün eklendi`);
      if (atlananlar.length > 0) {
        toast.warning(`${atlananlar.length} seçenek eklenmedi`, { description: atlananlar.slice(0, 3).join(" · ") });
      }
    } catch (e) {
      toast.error("Eklenemedi", { description: e instanceof Error ? e.message : undefined });
    } finally {
      tazelenmeli();
      window.setTimeout(() => setIlerleme(null), 700);
    }
  }

  const gizle = useMutation({
    mutationFn: ({ varyantlar, geriAl }: { varyantlar: string[]; geriAl: boolean; anahtar: string }) =>
      fetchJson("/api/shopify/yoksay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ varyantlar, geriAl }),
      }),
    onMutate: ({ anahtar }) => cikar([anahtar]),
    onSuccess: (_r, { geriAl }) => toast.success(geriAl ? "Yeni ürünlere geri alındı" : "Gizlendi"),
    onError: () => toast.error("Kaydedilemedi"),
    onSettled: tazelenmeli,
  });

  const bagla = useMutation({
    mutationFn: ({ varyantId, urunId }: { varyantId: string; urunId: string; anahtar: string; ad: string }) =>
      fetchJson("/api/shopify/bagla", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ varyantId, urunId }),
      }),
    onSuccess: (_r, { anahtar, ad }) => {
      cikar([anahtar]);
      toast.success(`${ad} Shopify'a bağlandı`);
    },
    onError: (e) => toast.error("Bağlanamadı", { description: e instanceof Error ? e.message : undefined }),
    onSettled: tazelenmeli,
  });

  const urunGizle = useMutation({
    mutationFn: ({ urunId }: { urunId: string; anahtar: string }) =>
      fetchJson("/api/products/bulk-visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [urunId], hidden: true }),
      }),
    onMutate: ({ anahtar }) => cikar([anahtar]),
    onSuccess: () => toast.success("Ürün gizlendi — \"Gizlenenler\" sekmesinden geri getirebilirsin"),
    onError: () => toast.error("Gizlenemedi"),
    onSettled: tazelenmeli,
  });

  const urunSil = useMutation({
    mutationFn: ({ urunId }: { urunId: string; anahtar: string }) =>
      fetchJson(`/api/products/${urunId}`, { method: "DELETE" }),
    onMutate: ({ anahtar }) => cikar([anahtar]),
    onSuccess: () => toast.success("Ürün silindi"),
    onError: () => toast.error("Silinemedi"),
    onSettled: tazelenmeli,
  });

  async function shopifydanTazele() {
    setTazeleniyor(true);
    try {
      const yeni = await fetchJson<KatalogYaniti>("/api/shopify/katalog?tazele=1");
      qc.setQueryData(SHOPIFY_KATALOG_ANAHTARI, yeni);
      void qc.invalidateQueries({ queryKey: SHOPIFY_OZET_ANAHTARI });
      setCikanlar(new Set());
    } catch (e) {
      toast.error("Shopify'a ulaşılamadı", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setTazeleniyor(false);
    }
  }

  const q = normalize(arama.trim());
  const eslesir = (metin: string) => !q || normalize(metin).includes(q);
  const yeniListe = (fark?.yeni ?? []).filter(
    (u) => !cikanlar.has(u.id) && (eslesir(u.baslik) || u.varyantlar.some((v) => eslesir(v.etiket)))
  );
  const kalkanListe = (fark?.kalkan ?? []).filter((k) => !cikanlar.has(k.urunId) && eslesir(k.ad));
  const gizliListe = (fark?.gizli ?? []).filter((u) => !cikanlar.has(`gizli:${u.id}`) && eslesir(u.baslik));

  const sayilar = {
    yeni: (fark?.yeni ?? []).filter((u) => !cikanlar.has(u.id)).length,
    kalkan: (fark?.kalkan ?? []).filter((k) => !cikanlar.has(k.urunId)).length,
    gizli: (fark?.gizli ?? []).filter((u) => !cikanlar.has(`gizli:${u.id}`)).length,
  };

  const seciliUrunler = yeniListe.filter((u) => secili.has(u.id));
  const hepsiSecili = yeniListe.length > 0 && seciliUrunler.length === yeniListe.length;

  return (
    <Dialog open onOpenChange={(o) => !o && !ilerleme && onClose()}>
      <DialogContent className="max-w-3xl h-[86vh] flex flex-col gap-3 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0 space-y-1">
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-emerald-500" />
            Shopify&apos;dan Ürün Ekle
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Mağazandaki yeni ürünleri seç, adını ver. Görsel ve fiyat Shopify&apos;dan gelir.
          </p>
        </DialogHeader>

        {data && !data.bagli ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center animate-in fade-in duration-300">
            <ShoppingBag className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">Shopify bağlı değil</p>
            <Link href="/api-settings" className={buttonVariants({ variant: "outline", size: "sm" })} onClick={onClose}>
              Bağlantı ayarlarına git
            </Link>
          </div>
        ) : (
          <>
            <div className="px-5 space-y-2.5">
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-lg bg-muted p-1 gap-0.5">
                  {(
                    [
                      ["yeni", "Yeni"],
                      ["kalkan", "Shopify'dan kalkan"],
                      ["gizli", "Gizlenen"],
                    ] as const
                  ).map(([k, etiket]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        setSekme(k);
                        setAcik(null);
                      }}
                      className={cn(
                        "relative flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 active:scale-95",
                        sekme === k ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {etiket}
                      {fark && (
                        <span
                          className={cn(
                            "min-w-[18px] rounded-full px-1.5 text-[10px] tabular-nums leading-4 transition-colors",
                            k === "yeni" && sayilar.yeni > 0
                              ? "bg-emerald-500/15 text-emerald-500"
                              : k === "kalkan" && sayilar.kalkan > 0
                                ? "bg-amber-500/15 text-amber-500"
                                : "bg-muted-foreground/10"
                          )}
                        >
                          <AnimatedNumber value={sayilar[k]} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={arama}
                    onChange={(e) => setArama(e.target.value)}
                    placeholder="Ürün ara"
                    className="h-8 pl-8 pr-7 text-sm"
                  />
                  {arama && (
                    <button
                      type="button"
                      onClick={() => setArama("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="Aramayı temizle"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={tazeleniyor || isLoading}
                  onClick={() => void shopifydanTazele()}
                  title="Shopify'daki güncel ürünleri çek"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", (tazeleniyor || isFetching) && "animate-spin")} />
                  Tazele
                </Button>
              </div>

              {sekme === "yeni" && yeniListe.length > 0 && (
                <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none animate-in fade-in duration-300">
                  <Checkbox
                    checked={hepsiSecili}
                    onCheckedChange={(c) =>
                      setSecili(c ? new Set(yeniListe.map((u) => u.id)) : new Set())
                    }
                  />
                  {hepsiSecili ? "Seçimi kaldır" : `Tümünü seç (${yeniListe.length})`}
                </label>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {isLoading ? (
                <YukleniyorListesi />
              ) : error && !fark ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center animate-in fade-in duration-300">
                  <p className="text-sm">Shopify ürünleri alınamadı.</p>
                  <p className="max-w-md text-xs text-muted-foreground">
                    {error instanceof Error ? error.message : ""}
                  </p>
                  <Button size="sm" variant="outline" onClick={() => void refetch()}>
                    Tekrar dene
                  </Button>
                </div>
              ) : sekme === "yeni" ? (
                yeniListe.length === 0 ? (
                  <BosDurum
                    ikon={<CheckCircle2 className="h-9 w-9 text-emerald-500" />}
                    baslik={q ? `"${arama}" için sonuç yok` : "Mağazandaki bütün ürünler uygulamada"}
                    aciklama={q ? undefined : "Shopify'a yeni ürün ekleyince burada görünür."}
                  />
                ) : (
                  <div className="space-y-2">
                    {yeniListe.map((u, i) => (
                      <YeniUrunKarti
                        key={u.id}
                        urun={u}
                        sira={i}
                        magaza={fark?.magaza ?? ""}
                        acik={acik === u.id}
                        secili={secili.has(u.id)}
                        taslak={taslakAl(u)}
                        mesgul={Boolean(ilerleme) || bagla.isPending}
                        onAc={() => setAcik((a) => (a === u.id ? null : u.id))}
                        onSec={(s) =>
                          setSecili((onceki) => {
                            const y = new Set(onceki);
                            if (s) y.add(u.id);
                            else y.delete(u.id);
                            return y;
                          })
                        }
                        onTaslak={(degis) => taslakDegistir(u, degis)}
                        onEkle={() => void ekle([u])}
                        onGizle={() =>
                          gizle.mutate({ varyantlar: u.varyantlar.map((v) => v.id), geriAl: false, anahtar: u.id })
                        }
                        onBagla={(v) =>
                          v.oneri &&
                          bagla.mutate({
                            varyantId: v.id,
                            urunId: v.oneri.urunId,
                            anahtar: u.varyantlar.length === 1 ? u.id : `__${v.id}`,
                            ad: v.oneri.ad,
                          })
                        }
                      />
                    ))}
                  </div>
                )
              ) : sekme === "kalkan" ? (
                fark?.kalkanSupheli ? (
                  <BosDurum
                    ikon={<AlertTriangle className="h-9 w-9 text-amber-500" />}
                    baslik="Şu an kontrol edilemedi"
                    aciklama="Shopify listesi eksik geldi. Tazele ile tekrar dene."
                  />
                ) : kalkanListe.length === 0 ? (
                  <BosDurum
                    ikon={<CheckCircle2 className="h-9 w-9 text-emerald-500" />}
                    baslik="Shopify'dan kaldırılan ürün yok"
                    aciklama="Shopify'da silinen bir ürün uygulamada kalırsa burada görünür."
                  />
                ) : (
                  <div className="space-y-2">
                    {kalkanListe.map((k, i) => (
                      <KalkanKarti
                        key={k.urunId}
                        kalkan={k}
                        sira={i}
                        mesgul={bagla.isPending || urunSil.isPending || urunGizle.isPending}
                        onGizle={() => urunGizle.mutate({ urunId: k.urunId, anahtar: k.urunId })}
                        onSil={() => urunSil.mutate({ urunId: k.urunId, anahtar: k.urunId })}
                        onBagla={(varyantId) =>
                          bagla.mutate({ varyantId, urunId: k.urunId, anahtar: k.urunId, ad: k.ad })
                        }
                      />
                    ))}
                  </div>
                )
              ) : gizliListe.length === 0 ? (
                <BosDurum
                  ikon={<EyeOff className="h-9 w-9 text-muted-foreground/50" />}
                  baslik="Gizlenen ürün yok"
                  aciklama="Eklemek istemediğin ürünleri gizleyince burada durur."
                />
              ) : (
                <div className="space-y-2">
                  {gizliListe.map((u, i) => (
                    <div
                      key={u.id}
                      style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
                      className="flex items-center gap-3 rounded-lg border p-2.5 animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
                    >
                      <Gorsel src={u.gorsel} alt={u.baslik} boyut={44} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.baslik}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {u.varyantlar.length > 1 ? `${u.varyantlar.length} seçenek · ` : ""}
                          {fiyatAraligi(u.varyantlar)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={gizle.isPending}
                        onClick={() =>
                          gizle.mutate({
                            varyantlar: u.varyantlar.map((v) => v.id),
                            geriAl: true,
                            anahtar: `gizli:${u.id}`,
                          })
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        Geri al
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {(seciliUrunler.length > 0 || ilerleme) && sekme === "yeni" && (
              <div className="border-t bg-card/95 px-5 py-3 backdrop-blur animate-in fade-in slide-in-from-bottom-2 duration-300">
                {ilerleme ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        {ilerleme.biten >= ilerleme.toplam ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {ilerleme.biten >= ilerleme.toplam ? "Tamamlandı" : "Ürünler ekleniyor…"}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {ilerleme.biten}/{ilerleme.toplam} · %{Math.round((ilerleme.biten / ilerleme.toplam) * 100)}
                      </span>
                    </div>
                    <Progress value={(ilerleme.biten / ilerleme.toplam) * 100} className="h-1.5" />
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm">
                      <span className="font-semibold tabular-nums">
                        <AnimatedNumber value={seciliUrunler.length} />
                      </span>{" "}
                      ürün seçili
                    </p>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setSecili(new Set())}>
                        Vazgeç
                      </Button>
                      <Button size="sm" onClick={() => void ekle(seciliUrunler)}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />
                        {seciliUrunler.length} ürünü ekle
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function YukleniyorListesi() {
  return (
    <div className="space-y-2 pt-1">
      <p className="flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-300">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Shopify&apos;daki ürünler alınıyor…
      </p>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          style={{ animationDelay: `${i * 60}ms` }}
          className="flex items-center gap-3 rounded-lg border p-2.5 animate-in fade-in fill-mode-both duration-500"
        >
          <Skeleton className="h-14 w-14 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-8 w-16 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function BosDurum({ ikon, baslik, aciklama }: { ikon: ReactNode; baslik: string; aciklama?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="animate-in zoom-in-50 fade-in duration-500">{ikon}</div>
      <p className="text-sm font-medium animate-in fade-in slide-in-from-bottom-1 duration-500">{baslik}</p>
      {aciklama && <p className="text-xs text-muted-foreground animate-in fade-in duration-700">{aciklama}</p>}
    </div>
  );
}

function YeniUrunKarti({
  urun,
  sira,
  magaza,
  acik,
  secili,
  taslak,
  mesgul,
  onAc,
  onSec,
  onTaslak,
  onEkle,
  onGizle,
  onBagla,
}: {
  urun: FarkUrunu;
  sira: number;
  magaza: string;
  acik: boolean;
  secili: boolean;
  taslak: Taslak;
  mesgul: boolean;
  onAc: () => void;
  onSec: (s: boolean) => void;
  onTaslak: (degis: (t: Taslak) => Taslak) => void;
  onEkle: () => void;
  onGizle: () => void;
  onBagla: (v: FarkVaryanti) => void;
}) {
  const adRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (acik) adRef.current?.focus({ preventScroll: true });
  }, [acik]);

  const cokluVaryant = urun.varyantlar.length > 1;
  const seciliVaryantlar = urun.varyantlar.filter((v) => taslak.varyantlar[v.id]?.secili !== false);
  const oneri = urun.varyantlar.find((v) => v.oneri)?.oneri ?? null;
  const tarih = tarihKisa(urun.eklendi);

  const varyantSec = (v: FarkVaryanti, s: boolean) =>
    onTaslak((t) => {
      const varyantlar = { ...t.varyantlar, [v.id]: { ...(t.varyantlar[v.id] ?? { etiket: v.etiket }), secili: s } };
      const secilen = urun.varyantlar.filter((x) => varyantlar[x.id]?.secili !== false);
      // Ad elle değiştirilmediyse seçim tek varyanta inince "Başlık — Seçenek" olsun.
      return { ...t, varyantlar, ad: t.adDegisti ? t.ad : varsayilanAd(urun, secilen) };
    });

  return (
    <div
      style={{ animationDelay: `${Math.min(sira, 12) * 35}ms` }}
      className={cn(
        "rounded-lg border transition-[border-color,background-color,box-shadow] duration-200",
        "animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300",
        acik ? "border-primary/40 bg-primary/[0.03] shadow-sm" : secili ? "border-primary/30" : "hover:border-foreground/20"
      )}
    >
      <div className="flex items-center gap-3 p-2.5">
        <Checkbox checked={secili} onCheckedChange={(c) => onSec(Boolean(c))} aria-label="Seç" />
        <button type="button" onClick={onAc} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Gorsel src={urun.gorsel} alt={urun.baslik} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-1 text-sm font-medium">{urun.baslik}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
              {tarih && <span>{tarih}</span>}
              {cokluVaryant && (
                <>
                  {tarih && <span>·</span>}
                  <span>{urun.varyantlar.length} seçenek</span>
                </>
              )}
              {!urun.satista && <span className="text-amber-500">· Tükendi</span>}
            </p>
            {oneri && (
              <p className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-500">
                <ArrowRightLeft className="h-3 w-3 shrink-0" />
                <span className="truncate">Uygulamada benzeri var: {oneri.ad}</span>
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold tabular-nums">{fiyatAraligi(urun.varyantlar)}</p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={onGizle}
            disabled={mesgul}
            title="Bunu ekleme — gizle"
            aria-label="Gizle"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant={acik ? "secondary" : "default"} className="h-8" onClick={onAc} disabled={mesgul}>
            {acik ? <ChevronDown className="h-3.5 w-3.5 mr-1 rotate-180 transition-transform" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
            {acik ? "Kapat" : "Ekle"}
          </Button>
        </div>
      </div>

      {acik && (
        <div className="space-y-3 border-t px-3 pb-3 pt-3 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {cokluVaryant && seciliVaryantlar.length > 1 ? "Grup adı" : "Ürün adı"}
            </label>
            <Input
              ref={adRef}
              value={taslak.ad}
              maxLength={200}
              onChange={(e) => onTaslak((t) => ({ ...t, ad: e.target.value, adDegisti: true }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !mesgul) onEkle();
              }}
              placeholder={urun.baslik}
              className="h-9"
            />
          </div>

          {cokluVaryant && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">Seçenekler</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {urun.varyantlar.map((v) => {
                  const durum = taslak.varyantlar[v.id] ?? { secili: true, etiket: v.etiket };
                  return (
                    <div
                      key={v.id}
                      className={cn(
                        "flex items-center gap-2 rounded-md border p-1.5 transition-[opacity,border-color] duration-200",
                        durum.secili ? "border-primary/30" : "opacity-55"
                      )}
                    >
                      <Checkbox checked={durum.secili} onCheckedChange={(c) => varyantSec(v, Boolean(c))} />
                      <Gorsel src={v.gorsel} alt={v.etiket} boyut={32} />
                      <Input
                        value={durum.etiket}
                        maxLength={80}
                        disabled={!durum.secili}
                        onChange={(e) =>
                          onTaslak((t) => ({
                            ...t,
                            varyantlar: { ...t.varyantlar, [v.id]: { ...durum, etiket: e.target.value } },
                          }))
                        }
                        className="h-7 min-w-0 flex-1 px-2 text-xs"
                      />
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatCurrency(v.fiyat)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs select-none">
              <Checkbox
                checked={taslak.siparisUzerine}
                onCheckedChange={(c) => onTaslak((t) => ({ ...t, siparisUzerine: Boolean(c) }))}
              />
              Sipariş üzerine üretilir
            </label>
            {!taslak.siparisUzerine && (
              <label className="flex items-center gap-2 text-xs animate-in fade-in slide-in-from-left-1 duration-200">
                Elimdeki stok
                <Input
                  value={taslak.stok}
                  inputMode="numeric"
                  onChange={(e) => onTaslak((t) => ({ ...t, stok: e.target.value.replace(/[^\d]/g, "").slice(0, 6) }))}
                  className="h-7 w-16 px-2 text-xs tabular-nums"
                />
                {cokluVaryant && <span className="text-muted-foreground">(her seçenek için)</span>}
              </label>
            )}
            {magaza && urun.handle && (
              <a
                href={`https://${magaza}/products/${urun.handle}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                Mağazada gör
              </a>
            )}
          </div>

          {oneri && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs animate-in fade-in duration-300">
              <Link2 className="h-3.5 w-3.5 shrink-0 text-sky-500" />
              <span className="min-w-0 flex-1">
                Yeni ürün açmak yerine <strong>{oneri.ad}</strong> ürününe bağlayabilirsin.
              </span>
              <div className="flex flex-wrap gap-1">
                {urun.varyantlar
                  .filter((v) => v.oneri)
                  .map((v) => (
                    <Button
                      key={v.id}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={mesgul}
                      onClick={() => onBagla(v)}
                    >
                      {cokluVaryant ? `${v.etiket} ile bağla` : "Bağla"}
                    </Button>
                  ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onAc}>
              Vazgeç
            </Button>
            <Button size="sm" onClick={onEkle} disabled={mesgul || seciliVaryantlar.length === 0}>
              {mesgul ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
              {cokluVaryant && seciliVaryantlar.length > 1 ? `${seciliVaryantlar.length} seçeneği ekle` : "Uygulamaya ekle"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function KalkanKarti({
  kalkan,
  sira,
  mesgul,
  onGizle,
  onSil,
  onBagla,
}: {
  kalkan: KalkanUrun;
  sira: number;
  mesgul: boolean;
  onGizle: () => void;
  onSil: () => void;
  onBagla: (varyantId: string) => void;
}) {
  const [silSor, setSilSor] = useState(false);
  return (
    <div
      style={{ animationDelay: `${Math.min(sira, 12) * 35}ms` }}
      className="space-y-2 rounded-lg border p-2.5 animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
    >
      <div className="flex items-center gap-3">
        <Gorsel src={kalkan.gorsel} alt={kalkan.ad} boyut={48} />
        <div className="min-w-0 flex-1">
          <Link href={`/products/${kalkan.urunId}`} className="line-clamp-1 text-sm font-medium hover:underline">
            {kalkan.ad}
          </Link>
          <p className="text-[11px] text-amber-500">Shopify&apos;da artık yok</p>
        </div>
        {silSor ? (
          <div className="flex shrink-0 items-center gap-1 animate-in fade-in slide-in-from-right-1 duration-200">
            <span className="mr-1 text-xs text-muted-foreground">Kalıcı silinsin mi?</span>
            <Button size="sm" variant="destructive" className="h-8" disabled={mesgul} onClick={onSil}>
              Sil
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setSilSor(false)}>
              Vazgeç
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="outline" className="h-8" disabled={mesgul} onClick={onGizle} title="Listeden gizle, silme">
              <EyeOff className="h-3.5 w-3.5 mr-1.5" />
              Gizle
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              disabled={mesgul}
              onClick={() => setSilSor(true)}
              title="Ürünü sil"
              aria-label="Ürünü sil"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      {kalkan.oneriler.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs animate-in fade-in duration-300">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-sky-500" />
          <span className="mr-1">Shopify&apos;daki yeni hâline bağla:</span>
          {kalkan.oneriler.map((o) => (
            <Button
              key={o.varyantId}
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={mesgul}
              onClick={() => onBagla(o.varyantId)}
              title={varyantTamAdi(o.baslik, o.etiket)}
            >
              {o.etiket || "Bağla"}
              <span className="ml-1.5 tabular-nums text-muted-foreground">{formatCurrency(o.fiyat)}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
