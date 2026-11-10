"use client";
/**
 * HIZLI HESAP — her sayfadan açılan yan çekmece: ürünü kaydetmeden fiyat dene.
 *
 * Gramaj, filament, süre, desi ve komisyonu gir → yazdığın satış fiyatında net kâr ve marj ANINDA.
 * Hesap ürün ekranının kendisi (`core/hizli-hesap` → `core/client-pricing`), yani rakamlar Ürünler
 * sayfasıyla ve telefondaki Hızlı hesapla birebir aynı. Girdiler bu cihazda hatırlanır (bir sonraki
 * ürün aynı ayarlarla başlar).
 *
 * Açma: `openHizliHesap()` (kenar çubuğu, Panel, komut paleti).
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Calculator, ChevronDown, RotateCcw, Target, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { PlatformLogo } from "@/components/PlatformLogo";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPercent } from "@/lib/format";
import { fetchJson } from "@/lib/fetch-json";
import { parsePackagingSettings } from "@/core/packaging";
import {
  fiyatDagilimi, hizliHesapla, sayiOku,
  type HizliHesapBaglam, type HizliHesapGirdi, type HizliPlatform,
} from "@/core/hizli-hesap";
import type { CargoRuleInput, CommissionRuleInput, ExpenseRuleInput } from "@/core/types";

const ACMA_OLAYI = "hizli-hesap:ac";
const SAKLAMA_ANAHTARI = "hizliHesap.form.v1";

/** Her sayfadan çağrılabilir: çekmeceyi açar. */
export function openHizliHesap(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACMA_OLAYI));
}

interface Form {
  platform: HizliPlatform;
  filamentTypeId: string;
  gram: string;
  saat: string;
  dakika: string;
  desi: string;
  fire: string;
  paket: string;
  naylon: string;
  bant: boolean;
  /** Platform başına ayrı: Trendyol ↔ HB arasında geçince oran kaybolmasın. */
  komisyon: Record<HizliPlatform, string>;
  fiyat: string;
}

const BOS_FORM: Form = {
  platform: "trendyol",
  filamentTypeId: "",
  gram: "",
  saat: "",
  dakika: "",
  desi: "1",
  fire: "0",
  // Canlı veride en sık seçim: küçük kargo poşeti + az naylon, bantsız.
  paket: "poset-kucuk",
  naylon: "low",
  bant: false,
  komisyon: { trendyol: "", hepsiburada: "", shopify: "" },
  fiyat: "",
};

const PLATFORMLAR: { id: HizliPlatform; ad: string }[] = [
  { id: "trendyol", ad: "Trendyol" },
  { id: "hepsiburada", ad: "Hepsiburada" },
  { id: "shopify", ad: "Shopify" },
];

/** Fiyat çubuğunun dilim renkleri — döküm satırlarındaki noktalarla aynı (lejant görevi). */
const DILIM: Record<"maliyet" | "komisyon" | "kargo" | "gider" | "kdv" | "kar", { ad: string; renk: string }> = {
  maliyet: { ad: "Ürün + paketleme", renk: "oklch(0.62 0.13 278)" },
  komisyon: { ad: "Komisyon", renk: "oklch(0.70 0.15 320)" },
  kargo: { ad: "Kargo", renk: "oklch(0.72 0.12 230)" },
  gider: { ad: "Hizmet bedeli", renk: "oklch(0.74 0.10 195)" },
  kdv: { ad: "KDV (net)", renk: "oklch(0.55 0.02 270)" },
  kar: { ad: "Net kâr", renk: "oklch(0.74 0.17 155)" },
};

function formuOku(): Form {
  try {
    const ham = localStorage.getItem(SAKLAMA_ANAHTARI);
    if (!ham) return BOS_FORM;
    const j = JSON.parse(ham) as Partial<Form>;
    return { ...BOS_FORM, ...j, komisyon: { ...BOS_FORM.komisyon, ...(j.komisyon ?? {}) } };
  } catch {
    return BOS_FORM;
  }
}

export function HizliHesap() {
  const [acik, setAcik] = useState(false);
  // İlk açılışa kadar hiçbir şey yüklenmez; sonra kapanış animasyonu için yerinde kalır.
  const [yuklendi, setYuklendi] = useState(false);

  useEffect(() => {
    const ac = () => { setYuklendi(true); setAcik(true); };
    window.addEventListener(ACMA_OLAYI, ac);
    return () => window.removeEventListener(ACMA_OLAYI, ac);
  }, []);

  useEffect(() => {
    if (!acik) return;
    const tus = (e: KeyboardEvent) => { if (e.key === "Escape") setAcik(false); };
    window.addEventListener("keydown", tus);
    return () => window.removeEventListener("keydown", tus);
  }, [acik]);

  if (!yuklendi) return null;
  return (
    <>
      <div
        aria-hidden
        onClick={() => setAcik(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] transition-opacity duration-300",
          acik ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        role="dialog"
        aria-label="Hızlı hesap"
        aria-hidden={!acik}
        inert={!acik}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[100vw] flex-col border-l border-border/70 bg-card shadow-2xl",
          "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          acik ? "translate-x-0" : "translate-x-full",
        )}
        style={{ boxShadow: "-24px 0 60px -20px oklch(0.4 0.2 278 / 35%)" }}
      >
        <HizliHesapIcerik acik={acik} onKapat={() => setAcik(false)} />
      </aside>
    </>
  );
}

function HizliHesapIcerik({ acik, onKapat }: { acik: boolean; onKapat: () => void }) {
  const [form, setForm] = useState<Form>(formuOku);
  const [ayrinti, setAyrinti] = useState(false);
  const gramRef = useRef<HTMLInputElement>(null);
  const fiyatRef = useRef<HTMLInputElement>(null);

  // Girdiler bu cihazda hatırlanır (bir sonraki ürün aynı filament/komisyonla başlar).
  useEffect(() => {
    try { localStorage.setItem(SAKLAMA_ANAHTARI, JSON.stringify(form)); } catch { /* gizli pencere vb. */ }
  }, [form]);

  // Açılınca imleç ilk boş alana: gramaj boşsa oraya, doluysa fiyata.
  useEffect(() => {
    if (!acik) return;
    const t = setTimeout(() => (form.gram ? fiyatRef.current : gramRef.current)?.focus(), 320);
    return () => clearTimeout(t);
    // Yalnız açılışta — her tuşta odak kaydırılmaz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acik]);

  const set = useCallback(<K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v })), []);

  // Ürün ekranıyla AYNI sorgu anahtarları → önbellek paylaşılır, açılış anında hazır.
  const filamentQ = useQuery<Array<{ id: string; name: string; costPerGram: number }>>({
    queryKey: ["filament-types"], queryFn: () => fetchJson("/api/filament-types"), staleTime: 10 * 60_000,
  });
  const ayarQ = useQuery<Record<string, string>>({ queryKey: ["app-settings"], queryFn: () => fetchJson("/api/settings") });
  const komisyonQ = useQuery<CommissionRuleInput[]>({
    queryKey: ["commission-rules"], queryFn: () => fetchJson("/api/commission-rules"), staleTime: 5 * 60_000,
  });
  const kargoQ = useQuery<CargoRuleInput[]>({
    queryKey: ["cargo-rules"], queryFn: () => fetchJson("/api/cargo-rules"), staleTime: 5 * 60_000,
  });
  const giderQ = useQuery<ExpenseRuleInput[]>({
    queryKey: ["expense-rules"], queryFn: () => fetchJson("/api/expense-rules"), staleTime: 5 * 60_000,
  });
  const reklamQ = useQuery<{ oranlar: Record<string, { oran: number }> }>({
    queryKey: ["ad-budgets"], queryFn: () => fetchJson("/api/ad-budgets"), staleTime: 5 * 60_000,
  });
  const sikQ = useQuery<{ komisyonlar: Record<"trendyol" | "hepsiburada", number[]> }>({
    queryKey: ["hizli-hesap"], queryFn: () => fetchJson("/api/hizli-hesap"), staleTime: 10 * 60_000,
  });

  const ayarlar = useMemo(() => ayarQ.data ?? {}, [ayarQ.data]);
  const paketAyari = useMemo(() => parsePackagingSettings(ayarlar), [ayarlar]);
  const filamentler = useMemo(() => filamentQ.data ?? [], [filamentQ.data]);

  const baglam = useMemo<HizliHesapBaglam | null>(() => {
    if (!filamentQ.data || !ayarQ.data || !komisyonQ.data || !kargoQ.data || !giderQ.data) return null;
    return {
      filaments: filamentQ.data,
      settings: ayarQ.data,
      commissionRules: komisyonQ.data,
      cargoRules: kargoQ.data,
      expenseRules: giderQ.data,
      adRates: Object.fromEntries(Object.entries(reklamQ.data?.oranlar ?? {}).map(([p, o]) => [p, o.oran])),
    };
  }, [filamentQ.data, ayarQ.data, komisyonQ.data, kargoQ.data, giderQ.data, reklamQ.data]);
  const yukleniyor = !baglam && !(filamentQ.isError || ayarQ.isError || komisyonQ.isError || kargoQ.isError || giderQ.isError);

  const shopifyVarsayilan = Number(ayarlar.shopifyCommissionRate ?? 3.2);
  const komisyonMetni = form.komisyon[form.platform];
  const girdi = useMemo<HizliHesapGirdi>(() => {
    const saat = (sayiOku(form.saat) ?? 0) + (sayiOku(form.dakika) ?? 0) / 60;
    return {
      platform: form.platform,
      filamentTypeId: form.filamentTypeId,
      gram: sayiOku(form.gram) ?? 0,
      saat,
      desi: sayiOku(form.desi),
      firePct: sayiOku(form.fire) ?? 0,
      packagingOptionId: form.paket,
      nylonLevel: form.naylon,
      tapeUsed: form.bant,
      komisyonPct: sayiOku(komisyonMetni),
      fiyat: sayiOku(form.fiyat),
    };
  }, [form, komisyonMetni]);

  // Canlı kâr: ucuz → her tuşta. Hedef fiyatlar: ikili arama → fiyat dışındaki girdilerle, ertelenmiş.
  const kar = useMemo(() => (baglam ? hizliHesapla(girdi, baglam, { hedefler: false }) : null), [girdi, baglam]);
  // Shopify'da sepet minimumunun üstündeki ürünün hedefi de üstünde aranır (ürün ekranıyla aynı kural);
  // başka her durumda fiyat hedefleri etkilemez → fiyat yazarken hedef araması yeniden koşmaz.
  const hedefFiyat = girdi.platform === "shopify" && (girdi.fiyat ?? 0) >= 150 ? girdi.fiyat : null;
  const { platform, filamentTypeId, gram, saat, desi, firePct, packagingOptionId, nylonLevel, tapeUsed, komisyonPct } = girdi;
  const hedefGirdisi = useMemo<HizliHesapGirdi>(
    () => ({ platform, filamentTypeId, gram, saat, desi, firePct, packagingOptionId, nylonLevel, tapeUsed, komisyonPct, fiyat: hedefFiyat }),
    [platform, filamentTypeId, gram, saat, desi, firePct, packagingOptionId, nylonLevel, tapeUsed, komisyonPct, hedefFiyat],
  );
  const ertelenmisHedef = useDeferredValue(hedefGirdisi);
  const hedef = useMemo(() => (baglam ? hizliHesapla(ertelenmisHedef, baglam) : null), [ertelenmisHedef, baglam]);

  const sonuc = kar?.sonuc ?? null;
  const maliyetBiliniyor = kar?.maliyet.biliniyor ?? false;
  const zarar = sonuc ? sonuc.netProfit < 0 : false;
  const ince = sonuc ? !zarar && sonuc.profitMargin < 0.1 : false;
  const karRengi = zarar ? "text-destructive" : ince ? "text-yellow-400" : "text-emerald-400";
  const sik = form.platform === "shopify" ? [] : (sikQ.data?.komisyonlar?.[form.platform] ?? []);

  const sifirla = () => {
    // Filament, paketleme ve komisyonlar kalır (çoğu ürün aynı); ürüne özgü alanlar temizlenir.
    setForm((f) => ({ ...BOS_FORM, platform: f.platform, filamentTypeId: f.filamentTypeId, paket: f.paket,
      naylon: f.naylon, bant: f.bant, fire: f.fire, komisyon: f.komisyon }));
    gramRef.current?.focus();
  };

  return (
    <>
      {/* Başlık */}
      <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/15 text-primary shadow-[0_0_18px_-4px_oklch(0.66_0.2_278/60%)]">
          <Calculator className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">Hızlı hesap</p>
          <p className="text-[11px] text-muted-foreground">Ürünü kaydetmeden fiyat dene.</p>
        </div>
        <button
          type="button" onClick={sifirla} title="Ürün bilgilerini temizle"
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-90"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          type="button" onClick={onKapat} title="Kapat (Esc)"
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-90"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* Platform */}
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted/40 p-1">
          {PLATFORMLAR.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => set("platform", p.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-all duration-200 active:scale-95",
                form.platform === p.id
                  ? "bg-card text-foreground shadow-sm ring-1 ring-primary/40"
                  : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
              )}
            >
              <PlatformLogo platform={p.id} className="h-3.5 w-3.5" />
              {p.ad}
            </button>
          ))}
        </div>

        <Alan etiket="Filament" gecikme={0}>
          <select
            value={form.filamentTypeId}
            onChange={(e) => set("filamentTypeId", e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">Seç…</option>
            {filamentler.map((f) => (
              <option key={f.id} value={f.id}>{f.name} ({formatCurrency(f.costPerGram)}/g)</option>
            ))}
          </select>
        </Alan>

        <div className="grid grid-cols-2 gap-3">
          <Alan etiket="Gramaj" gecikme={30}>
            <SayiGirisi ref={gramRef} deger={form.gram} onDegis={(v) => set("gram", v)} birim="g" yer="örn. 85" />
          </Alan>
          <Alan etiket="Desi" gecikme={60}>
            <SayiGirisi deger={form.desi} onDegis={(v) => set("desi", v)} yer="örn. 2" />
          </Alan>
        </div>

        <Alan etiket="Baskı süresi" gecikme={90}>
          <div className="grid grid-cols-2 gap-3">
            <SayiGirisi deger={form.saat} onDegis={(v) => set("saat", v)} birim="sa" yer="0" />
            <SayiGirisi deger={form.dakika} onDegis={(v) => set("dakika", v)} birim="dk" yer="0" />
          </div>
        </Alan>

        <Alan etiket="Komisyon" gecikme={120}>
          <SayiGirisi
            deger={komisyonMetni}
            onDegis={(v) => setForm((f) => ({ ...f, komisyon: { ...f.komisyon, [f.platform]: v } }))}
            birim="%"
            yer={form.platform === "shopify" ? String(shopifyVarsayilan).replace(".", ",") : "örn. 21"}
          />
          {sik.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1 motion-safe:animate-in motion-safe:fade-in duration-300">
              {sik.map((y) => {
                const secili = sayiOku(komisyonMetni) === y;
                return (
                  <button
                    key={y}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, komisyon: { ...f.komisyon, [f.platform]: String(y).replace(".", ",") } }))}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] tabular-nums transition-all duration-150 active:scale-95",
                      secili ? "border-primary bg-primary/15 font-semibold text-foreground" : "text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    %{String(y).replace(".", ",")}
                  </button>
                );
              })}
            </div>
          )}
        </Alan>

        {/* Ayrıntılar: fire + paketleme — çoğu üründe aynı, kapalı durur */}
        <div className="rounded-xl border border-border/60">
          <button
            type="button"
            onClick={() => setAyrinti((a) => !a)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>
              Fire ve paketleme
              <span className="ml-1.5 text-muted-foreground/70">
                · %{form.fire || "0"} · {paketAyari.options.find((o) => o.id === form.paket)?.name ?? "paketsiz"}
              </span>
            </span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", ayrinti && "rotate-180")} />
          </button>
          <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out", ayrinti ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
            <div className="overflow-hidden">
              <div className="grid grid-cols-2 gap-3 border-t border-border/60 p-3">
                <Alan etiket="Fire">
                  <SayiGirisi deger={form.fire} onDegis={(v) => set("fire", v)} birim="%" yer="0" />
                </Alan>
                <Alan etiket="Poşet / koli">
                  <select
                    value={form.paket}
                    onChange={(e) => set("paket", e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Yok</option>
                    {paketAyari.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </Alan>
                <Alan etiket="Naylon">
                  <select
                    value={form.naylon}
                    onChange={(e) => set("naylon", e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="none">Yok</option>
                    <option value="low">Az</option>
                    <option value="medium">Orta</option>
                    <option value="high">Çok</option>
                  </select>
                </Alan>
                <Alan etiket="Bant">
                  <select
                    value={form.bant ? "evet" : "hayir"}
                    onChange={(e) => set("bant", e.target.value === "evet")}
                    className="h-9 w-full rounded-md border bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="hayir">Yok</option>
                    <option value="evet">Var</option>
                  </select>
                </Alan>
              </div>
            </div>
          </div>
        </div>

        {/* Maliyet özeti */}
        {kar && maliyetBiliniyor && (
          <div className="flex items-center justify-between rounded-xl bg-muted/30 px-3 py-2 text-xs motion-safe:animate-in motion-safe:fade-in duration-300">
            <span className="text-muted-foreground">Ürün maliyeti</span>
            <span className="tabular-nums">
              <AnimatedNumber value={kar.maliyet.toplam} durationMs={400} format={(n) => formatCurrency(n)} className="font-semibold" />
              <span className="ml-1.5 text-muted-foreground">
                (üretim {formatCurrency(kar.maliyet.uretim)} + paket {formatCurrency(kar.maliyet.paketleme)})
              </span>
            </span>
          </div>
        )}

        {/* Hedef fiyatlar — tıkla, fiyat olarak gelsin */}
        {hedef && maliyetBiliniyor && hedef.hedefler.length > 0 && (
          <div className="space-y-1.5 motion-safe:animate-in motion-safe:fade-in duration-300">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Target className="h-3.5 w-3.5" /> Bu marj için en düşük fiyat
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {hedef.hedefler.map((h, i) => (
                <button
                  key={h.marj}
                  type="button"
                  disabled={h.fiyat == null}
                  onClick={() => h.fiyat != null && set("fiyat", (Math.ceil(h.fiyat * 100) / 100).toFixed(2).replace(".", ","))}
                  className="group rounded-lg border border-border/60 px-1.5 py-1.5 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/10 active:scale-95 disabled:opacity-40 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
                  style={{ animationDelay: `${i * 40}ms`, animationFillMode: "both" }}
                >
                  <span className="block text-[10px] text-muted-foreground group-hover:text-primary">%{h.marj}</span>
                  <span className="block text-xs font-semibold tabular-nums">{h.fiyat != null ? formatCurrency(h.fiyat) : "—"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Döküm */}
        {sonuc && (
          <div className="space-y-1 rounded-xl border border-border/60 p-3 text-[12px] tabular-nums motion-safe:animate-in motion-safe:fade-in duration-300">
            {sonuc.minOrderQty > 1 && (
              <p className="pb-1 text-[11px] text-yellow-400">
                Trendyol bu fiyatta en az {sonuc.minOrderQty} adet sattırır — rakamlar {sonuc.minOrderQty} adet için.
              </p>
            )}
            <Satir renk={DILIM.maliyet.renk} ad="Ürün + paketleme" tutar={sonuc.productCost + sonuc.packagingCost} />
            <Satir
              renk={DILIM.komisyon.renk}
              ad={`Komisyon${girdi.komisyonPct != null ? ` (%${String(girdi.komisyonPct).replace(".", ",")})` : form.platform === "shopify" ? ` (%${String(shopifyVarsayilan).replace(".", ",")})` : ""}`}
              tutar={sonuc.commissionCost}
            />
            <Satir renk={DILIM.kargo.renk} ad="Kargo" tutar={sonuc.cargoCost} />
            {sonuc.appliedExpenseRules.filter((x) => x.amount !== 0).map((x) => (
              <Satir key={x.id} renk={DILIM.gider.renk} ad={x.name} tutar={x.type === "percentage" ? x.amount * sonuc.minOrderQty : x.amount} />
            ))}
            {sonuc.adCost > 0 && <Satir renk={DILIM.gider.renk} ad="Reklam payı" tutar={sonuc.adCost} />}
            <Satir
              renk={DILIM.kdv.renk}
              ad={`KDV (%${sonuc.vatRate}, iade düşülmüş)`}
              tutar={sonuc.vatAmount * sonuc.minOrderQty - sonuc.inputVatCredit}
            />
            <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-1.5 font-semibold">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: DILIM.kar.renk }} /> Net kâr
              </span>
              <span className={karRengi}>{formatCurrency(sonuc.netProfit)}</span>
            </div>
          </div>
        )}

        {/* Uyarılar — kısa, ne yapacağını söyler */}
        {kar && (
          <div className="space-y-1">
            {!maliyetBiliniyor && (
              <Uyari>Filament seç ve gramajı gir.</Uyari>
            )}
            {maliyetBiliniyor && kar.desiVarsayildi && <Uyari>Desi girilmedi — 1 desi sayıldı.</Uyari>}
            {kar.kargoFiyatiYok && <Uyari kirmizi>Bu desiye uyan kargo fiyatı yok — kargo ₺0 sayıldı.</Uyari>}
            {form.platform !== "shopify" && girdi.komisyonPct == null && maliyetBiliniyor && (
              <Uyari>Komisyonu gir — boşken komisyon kesilmez.</Uyari>
            )}
          </div>
        )}
        {yukleniyor && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" style={{ animationDelay: `${i * 120}ms` }} />)}
          </div>
        )}
      </div>

      {/* Sabit alt bölüm: fiyat + sonuç her zaman görünür */}
      <div className="border-t border-border/60 bg-card/95 px-4 pb-4 pt-3 backdrop-blur">
        <div className="flex items-end gap-3">
          <div className="w-[150px] shrink-0">
            <p className="mb-1 text-[11px] text-muted-foreground">Satış fiyatı (KDV dahil)</p>
            <SayiGirisi ref={fiyatRef} deger={form.fiyat} onDegis={(v) => set("fiyat", v)} birim="₺" yer="0,00" buyuk />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">Net kâr</p>
            {sonuc ? (
              <AnimatedNumber value={sonuc.netProfit} durationMs={420} format={(n) => formatCurrency(n)}
                className={cn("block truncate text-xl font-bold tabular-nums transition-colors duration-300", karRengi)} />
            ) : (
              <p className="text-xl font-bold text-muted-foreground/40">—</p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[11px] text-muted-foreground">Marj</p>
            {sonuc ? (
              <AnimatedNumber value={sonuc.profitMargin} durationMs={420} format={(n) => formatPercent(n)}
                className={cn("block text-xl font-bold tabular-nums transition-colors duration-300", karRengi)} />
            ) : (
              <p className="text-xl font-bold text-muted-foreground/40">—</p>
            )}
          </div>
        </div>
        <FiyatCubugu sonuc={sonuc} />
      </div>
    </>
  );
}

/** Fiyatın nereye gittiği: dilimler genişlik değişimiyle akar; zarar kırmızı taşma olarak görünür. */
function FiyatCubugu({ sonuc }: { sonuc: ReturnType<typeof hizliHesapla>["sonuc"] }) {
  const d = sonuc ? fiyatDagilimi(sonuc) : null;
  const toplam = d ? d.dilimler.reduce((a, x) => a + x.tutar, 0) + d.zarar : 0;
  return (
    <div className="mt-3">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/50">
        {d && toplam > 0 && d.dilimler.map((x) => (
          <span
            key={x.anahtar}
            title={`${DILIM[x.anahtar].ad}: ${formatCurrency(x.tutar)}`}
            className="h-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${(x.tutar / toplam) * 100}%`, background: DILIM[x.anahtar].renk }}
          />
        ))}
        {d && toplam > 0 && d.zarar > 0 && (
          <span
            title={`Zarar: ${formatCurrency(d.zarar)}`}
            className="h-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${(d.zarar / toplam) * 100}%`, background: "repeating-linear-gradient(45deg, oklch(0.62 0.22 25), oklch(0.62 0.22 25) 4px, oklch(0.5 0.2 25) 4px, oklch(0.5 0.2 25) 8px)" }}
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        {(Object.keys(DILIM) as (keyof typeof DILIM)[]).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: DILIM[k].renk }} /> {DILIM[k].ad}
          </span>
        ))}
      </div>
    </div>
  );
}

function Alan({ etiket, gecikme, children }: { etiket: string; gecikme?: number; children: React.ReactNode }) {
  return (
    <div
      className={gecikme != null ? "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 duration-300" : undefined}
      style={gecikme != null ? { animationDelay: `${gecikme}ms`, animationFillMode: "both" } : undefined}
    >
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">{etiket}</p>
      {children}
    </div>
  );
}

function SayiGirisi({ deger, onDegis, birim, yer, buyuk, ref }: {
  deger: string; onDegis: (v: string) => void; birim?: string; yer?: string; buyuk?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="relative">
      <Input
        ref={ref}
        inputMode="decimal"
        value={deger}
        placeholder={yer}
        onChange={(e) => onDegis(e.target.value.replace(/[^0-9.,]/g, ""))}
        onFocus={(e) => e.currentTarget.select()}
        className={cn("tabular-nums", birim && "pr-8", buyuk ? "h-10 text-lg font-semibold" : "h-9")}
      />
      {birim && (
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">{birim}</span>
      )}
    </div>
  );
}

function Satir({ renk, ad, tutar }: { renk: string; ad: string; tutar: number }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: renk }} /> {ad}
      </span>
      {/* Eksi tutar kesinti değil alacak (ör. düşük fiyatta KDV iadesi ödenecek KDV'yi aşar). */}
      <span className={tutar < 0 ? "text-emerald-400" : undefined}>
        {tutar < 0 ? "+" : "−"}{formatCurrency(Math.abs(tutar))}
      </span>
    </div>
  );
}

function Uyari({ children, kirmizi }: { children: React.ReactNode; kirmizi?: boolean }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-[11px] leading-snug motion-safe:animate-in motion-safe:fade-in duration-300", kirmizi ? "text-destructive" : "text-yellow-400")}>
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{children}</span>
    </p>
  );
}
