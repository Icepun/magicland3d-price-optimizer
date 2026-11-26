"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus, Pencil, Search, Trash2, Percent, SearchX, ShoppingBag, AlertTriangle, RefreshCw, Layers, ChevronDown,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";
import { formatCurrency, formatNumber } from "@/lib/format";
import { komisyonOzeti, type KomisyonSiparisi } from "@/lib/komisyon-ozeti";
import { PLATFORM_RENGI } from "@/components/reports/rapor-platformlar";

interface CommissionRule {
  id: string;
  name: string;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number;
  fixedCommission: number;
  priority: number;
  isActive: boolean;
  /** "trendyol" | "hepsiburada"; boş = eski kural (Trendyol). */
  platform: string | null;
  validFrom: string | null;
  validTo: string | null;
}

type Pazaryeri = "trendyol" | "hepsiburada";
const PAZARYERLERI: { key: Pazaryeri; ad: string; renk: string }[] = [
  { key: "trendyol", ad: "Trendyol", renk: "#F27A1A" },
  { key: "hepsiburada", ad: "Hepsiburada", renk: "#4F8CFF" },
];
const pazaryeriOf = (r: CommissionRule): Pazaryeri => (r.platform === "hepsiburada" ? "hepsiburada" : "trendyol");

/** Kural şu an yürürlükte mi (çekirdekteki tanımla aynı: aktif + tarih aralığında). */
function yururlukte(r: CommissionRule, an = Date.now()): boolean {
  if (!r.isActive) return false;
  const bas = r.validFrom ? Date.parse(r.validFrom) : null;
  const bit = r.validTo ? Date.parse(r.validTo) : null;
  return (bas == null || !Number.isFinite(bas) || bas <= an) && (bit == null || !Number.isFinite(bit) || bit >= an);
}

function tarihMetni(iso: string | null): string {
  if (!iso) return "başlangıçtan";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

/** "Üst sınır yok" — boş bırakılan max fiyat. */
const SINIRSIZ = 999999;

const KART = "rounded-2xl bg-card ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none";
const GIRDI = "rounded-xl border-white/[0.08] bg-white/[0.03] dark:bg-white/[0.03] tabular-nums transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25";
const BIRINCIL = "h-9 gap-2 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] px-3.5 text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:-translate-y-px hover:brightness-110 active:scale-[0.97] motion-reduce:hover:translate-y-0";

/** "1,5" / "1.5" → 1.5 · boş ya da geçersiz → null (BOŞ ≠ SIFIR). */
function sayi(metin: string | null | undefined): number | null {
  const t = String(metin ?? "").trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Kesir oran → "%21,5" (Türkçe, gereksiz sıfır yok). */
function oranMetni(kesir: number): string {
  return `%${(Math.round(kesir * 10000) / 100).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`;
}

/** Yüzde sayısı → form metni ("21.5" değil "21,5"; kayan nokta artığı yok). */
function yuzdeMetni(kesir: number): string {
  return String(Math.round(kesir * 10000) / 100).replace(".", ",");
}

/**
 * Kural formu — alanlar METİN olarak tutulur, sayıya kaydederken çevrilir.
 * Eskiden boş oran sessizce %0 kural oluşturuyordu (kâr şişerdi), boş max fiyat 0 olup kural
 * hiç eşleşmiyordu, min > max serbestti (denetim, 23 Kas 2026).
 */
const FormSemasi = z
  .object({
    name: z.string().trim().min(1, "Kural adı gerekli"),
    categoryName: z.string(),
    minPrice: z.string(),
    maxPrice: z.string(),
    commissionRate: z.string(),
    fixedCommission: z.string(),
    priority: z.string(),
    platform: z.enum(["trendyol", "hepsiburada"]),
  })
  .superRefine((d, ctx) => {
    const oran = sayi(d.commissionRate);
    if (oran == null) ctx.addIssue({ code: "custom", path: ["commissionRate"], message: "Komisyon oranı gerekli" });
    else if (oran < 0 || oran > 100) ctx.addIssue({ code: "custom", path: ["commissionRate"], message: "0 ile 100 arasında olmalı" });
    const min = d.minPrice.trim() ? sayi(d.minPrice) : 0;
    const max = d.maxPrice.trim() ? sayi(d.maxPrice) : SINIRSIZ;
    if (min == null || min < 0) ctx.addIssue({ code: "custom", path: ["minPrice"], message: "Geçersiz fiyat" });
    if (max == null || max < 0) ctx.addIssue({ code: "custom", path: ["maxPrice"], message: "Geçersiz fiyat" });
    else if (min != null && max < min) ctx.addIssue({ code: "custom", path: ["maxPrice"], message: "Min fiyattan küçük olamaz" });
    const sabit = d.fixedCommission.trim() ? sayi(d.fixedCommission) : 0;
    if (sabit == null || sabit < 0) ctx.addIssue({ code: "custom", path: ["fixedCommission"], message: "Geçersiz tutar" });
    const oncelik = d.priority.trim() ? sayi(d.priority) : 10;
    if (oncelik == null || !Number.isInteger(oncelik)) ctx.addIssue({ code: "custom", path: ["priority"], message: "Tam sayı olmalı" });
  });

type FormVerisi = z.infer<typeof FormSemasi>;

interface KuralGovdesi {
  name: string;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number;
  fixedCommission: number;
  priority: number;
  platform: Pazaryeri;
}

function govdeyeCevir(d: FormVerisi): KuralGovdesi {
  return {
    name: d.name.trim(),
    categoryName: d.categoryName.trim() || null,
    minPrice: d.minPrice.trim() ? (sayi(d.minPrice) ?? 0) : 0,
    maxPrice: d.maxPrice.trim() ? (sayi(d.maxPrice) ?? SINIRSIZ) : SINIRSIZ,
    commissionRate: (sayi(d.commissionRate) ?? 0) / 100,
    fixedCommission: d.fixedCommission.trim() ? (sayi(d.fixedCommission) ?? 0) : 0,
    priority: d.priority.trim() ? Math.trunc(sayi(d.priority) ?? 10) : 10,
    platform: d.platform,
  };
}

function formaCevir(r: CommissionRule | null): FormVerisi {
  return {
    name: r?.name ?? "",
    categoryName: r?.categoryName ?? "",
    minPrice: r ? String(r.minPrice).replace(".", ",") : "0",
    maxPrice: r && r.maxPrice < SINIRSIZ ? String(r.maxPrice).replace(".", ",") : "",
    commissionRate: r ? yuzdeMetni(r.commissionRate) : "",
    fixedCommission: r && r.fixedCommission ? String(r.fixedCommission).replace(".", ",") : "",
    priority: String(r?.priority ?? 10),
    platform: r ? pazaryeriOf(r) : "trendyol",
  };
}

function Alan({ etiket, ipucu, hata, children }: { etiket: string; ipucu?: string; hata?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{etiket}</Label>
      {children}
      {hata ? (
        <p className="text-[11px] font-medium text-rose-300 animate-in fade-in duration-200">{hata}</p>
      ) : ipucu ? (
        <p className="text-[11px] text-muted-foreground">{ipucu}</p>
      ) : null}
    </div>
  );
}

function RuleForm({
  kural,
  onSubmit,
  isPending,
  onKirli,
}: {
  kural: CommissionRule | null;
  onSubmit: (d: KuralGovdesi) => void;
  isPending: boolean;
  onKirli: (kirli: boolean) => void;
}) {
  const form = useForm<FormVerisi>({ resolver: zodResolver(FormSemasi), defaultValues: formaCevir(kural) });
  const platform = useWatch({ control: form.control, name: "platform" });
  const e = form.formState.errors;
  const kayit = (ad: keyof FormVerisi) =>
    form.register(ad, { onChange: () => onKirli(true) });

  return (
    <form onSubmit={form.handleSubmit((d) => onSubmit(govdeyeCevir(d)))} className="space-y-3">
      <Alan etiket="Kural adı" hata={e.name?.message}>
        <Input className={GIRDI} {...kayit("name")} placeholder="ör. Trendyol Oyuncak" />
      </Alan>
      <Alan etiket="Pazaryeri" ipucu="Kural yalnız bu pazaryerinin ilanlarına uygulanır.">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/[0.03] p-1 ring-1 ring-white/[0.08]">
          {PAZARYERLERI.map((pz) => (
            <button
              key={pz.key}
              type="button"
              onClick={() => {
                form.setValue("platform", pz.key);
                onKirli(true);
              }}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-all duration-200 active:scale-[0.98]",
                platform === pz.key ? "bg-white/[0.08] font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="size-1.5 rounded-full" style={{ background: pz.renk }} />
              {pz.ad}
            </button>
          ))}
        </div>
      </Alan>
      <Alan etiket="Kategori" ipucu="Boş bırakırsan tüm kategorilere uygulanır.">
        <Input className={GIRDI} {...kayit("categoryName")} placeholder="ör. Gamepad Standı" />
      </Alan>
      <div className="grid grid-cols-2 gap-3">
        <Alan etiket="Min. fiyat (₺)" hata={e.minPrice?.message}>
          <Input className={GIRDI} inputMode="decimal" {...kayit("minPrice")} placeholder="0" />
        </Alan>
        <Alan etiket="Max. fiyat (₺)" hata={e.maxPrice?.message} ipucu="Boş = üst sınır yok">
          <Input className={GIRDI} inputMode="decimal" {...kayit("maxPrice")} placeholder="sınırsız" />
        </Alan>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Alan etiket="Komisyon oranı (%)" hata={e.commissionRate?.message}>
          <Input className={GIRDI} inputMode="decimal" {...kayit("commissionRate")} placeholder="ör. 21,5" />
        </Alan>
        <Alan etiket="Sabit komisyon (₺)" hata={e.fixedCommission?.message}>
          <Input className={GIRDI} inputMode="decimal" {...kayit("fixedCommission")} placeholder="0" />
        </Alan>
      </div>
      <Alan etiket="Öncelik" hata={e.priority?.message} ipucu="Aynı ürüne birden çok kural uyarsa yüksek olan geçerli.">
        <Input className={GIRDI} inputMode="numeric" {...kayit("priority")} />
      </Alan>
      <p className="text-[11px] text-muted-foreground">Değişiklik bu ayın başından geçerli olur; önceki aylar değişmez.</p>
      <DialogFooter>
        <Button type="submit" className={BIRINCIL} disabled={isPending}>
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PazaryeriRozeti({ platform }: { platform: Pazaryeri }) {
  const pz = PAZARYERLERI.find((x) => x.key === platform)!;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1"
      style={{ color: pz.renk, background: `${pz.renk}14`, ["--tw-ring-color" as string]: `${pz.renk}40` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: pz.renk }} />
      {pz.ad}
    </span>
  );
}

/** Kısa hata kartı — veri gelmediyse "kural yok" değil, bu görünür. */
function HataKarti({ baslik, yukleniyor, onRetry }: { baslik: string; yukleniyor: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-rose-500/[0.05] px-4 py-10 text-center ring-1 ring-rose-400/25 animate-in fade-in duration-300">
      <AlertTriangle className="h-8 w-8 text-rose-300/80" />
      <p className="font-medium">{baslik}</p>
      <p className="text-sm text-muted-foreground">Bağlantını kontrol edip tekrar dene.</p>
      <Button variant="outline" size="sm" className="gap-1.5 rounded-xl" disabled={yukleniyor} onClick={onRetry}>
        <RefreshCw className={cn("h-3.5 w-3.5", yukleniyor && "animate-spin")} /> Tekrar dene
      </Button>
    </div>
  );
}

export default function CommissionRulesPage() {
  /** Açık pencere: yeni kural ("yeni") ya da düzenlenen kural. */
  const [pencere, setPencere] = useState<CommissionRule | "yeni" | null>(null);
  const [kirli, setKirli] = useState(false);
  const [kapatSor, setKapatSor] = useState(false);
  const [silinecek, setSilinecek] = useState<CommissionRule | null>(null);
  const [search, setSearch] = useState("");
  const [gecmisAcik, setGecmisAcik] = useState(false);
  const queryClient = useQueryClient();

  const {
    data: rules = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery<CommissionRule[]>({
    queryKey: ["commission-rules"],
    queryFn: () => fetchJson("/api/commission-rules"),
    // Telefondan yapılan değişiklik görünsün; eski listeden kaydedip telefonun yazdığını ezmeyelim.
    refetchOnMount: "always",
  });
  const veriYok = isError && !rules.length;

  const pencereyiKapat = () => {
    setPencere(null);
    setKirli(false);
    setKapatSor(false);
  };
  const kapatmayiDene = () => (kirli ? setKapatSor(true) : pencereyiKapat());

  const sonrasi = (mesaj: string) => {
    void queryClient.invalidateQueries({ queryKey: ["commission-rules"] });
    clearPricingQueryCache(queryClient);
    toast.success(mesaj);
  };

  const createMutation = useMutation({
    mutationFn: (data: KuralGovdesi) =>
      fetchJson("/api/commission-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      sonrasi("Kural eklendi");
      pencereyiKapat();
    },
    onError: (e: Error) => toast.error(e.message || "Kural eklenemedi"),
  });

  const updateMutation = useMutation({
    // Yalnız DEĞİŞEN alanlar gönderilir: telefonda değiştirilen bir alan masaüstünden ezilmesin.
    mutationFn: ({ id, data }: { id: string; data: Partial<KuralGovdesi> }) =>
      fetchJson(`/api/commission-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      sonrasi("Kural güncellendi");
      pencereyiKapat();
    },
    onError: (e: Error) => toast.error(e.message || "Kural güncellenemedi"),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, tamamen }: { id: string; tamamen: boolean }) =>
      fetchJson<{ kapatildi?: boolean }>(`/api/commission-rules/${id}${tamamen ? "?tamamen=1" : ""}`, { method: "DELETE" }),
    onSuccess: (r) => {
      sonrasi(r?.kapatildi ? "Kural bu aydan itibaren kaldırıldı" : "Kural silindi");
      setSilinecek(null);
    },
    onError: (e: Error) => toast.error(e.message || "Kural silinemedi"),
  });

  const yeniden = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/commission-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      }),
    onSuccess: () => sonrasi("Kural yeniden açıldı"),
    onError: (e: Error) => toast.error(e.message || "Kural açılamadı"),
  });

  const aranan = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("tr-TR");
    if (!q) return rules;
    return rules.filter((rule) =>
      [rule.name, rule.categoryName]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("tr-TR").includes(q))
    );
  }, [rules, search]);
  // Yürürlükteki kurallar listede; kapanmış dönemler geçmiş siparişler için ayrı, kapalı bölümde.
  const filteredRules = useMemo(() => aranan.filter((r) => yururlukte(r)), [aranan]);
  const gecmisKurallar = useMemo(() => aranan.filter((r) => !yururlukte(r)), [aranan]);
  const yururlukteSayisi = useMemo(() => rules.filter((r) => yururlukte(r)).length, [rules]);

  const kaydet = (govde: KuralGovdesi) => {
    if (pencere === "yeni") {
      createMutation.mutate(govde);
      return;
    }
    if (!pencere) return;
    const eski = govdeyeCevir(formaCevir(pencere));
    const degisen = Object.fromEntries(
      (Object.keys(govde) as (keyof KuralGovdesi)[])
        .filter((k) => govde[k] !== eski[k])
        .map((k) => [k, govde[k]])
    ) as Partial<KuralGovdesi>;
    if (Object.keys(degisen).length === 0) {
      pencereyiKapat();
      return;
    }
    updateMutation.mutate({ id: pencere.id, data: degisen });
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <Percent className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Komisyonlar</h1>
            <p className="text-xs text-muted-foreground">
              Siparişlerde pazaryerinin kestiği komisyon esas alınır; kurallar oranı bilinmeyen ilanlar içindir.
            </p>
          </div>
        </div>
        <Button onClick={() => setPencere("yeni")} size="sm" className={BIRINCIL}>
          <Plus className="h-4 w-4" /> Kural Ekle
        </Button>
      </header>

      <GerceklesenKomisyonKarti />

      <ShopifyCommissionCard />

      <N11KomisyonKarti />

      <section className={cn(KART, "space-y-4 p-4")} style={{ animationDelay: "160ms" }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="grid size-7 place-items-center rounded-lg bg-white/[0.05] text-[#C9D2F2] ring-1 ring-white/[0.08]">
                <Layers className="size-3.5" />
              </span>
              Komisyon kuralları
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              İlanında komisyon oranı olmayan ürünlere kategori ve fiyat aralığına göre uygulanır.
            </p>
          </div>
          {rules.length > 0 && (
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Kategori veya kural ara…"
                className={cn(GIRDI, "pl-9")}
              />
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="grid gap-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : veriYok ? (
          <HataKarti baslik="Kurallar yüklenemedi" yukleniyor={isFetching} onRetry={() => void refetch()} />
        ) : yururlukteSayisi === 0 && !search.trim() ? (
          <EmptyState
            icon={Percent}
            title="Henüz komisyon kuralı yok"
            description="İlanlarda oran yoksa buraya genel bir kural ekleyebilirsin."
            action={
              <Button onClick={() => setPencere("yeni")} size="sm" className={BIRINCIL}>
                <Plus className="h-4 w-4" /> İlk Kuralı Ekle
              </Button>
            }
          />
        ) : filteredRules.length === 0 ? (
          <EmptyState icon={SearchX} title="Aramaya uygun kural yok" description={`"${search}" için sonuç bulunamadı.`} />
        ) : (
          <div className="grid gap-2">
            {filteredRules.map((rule, index) => (
              <div
                key={rule.id}
                className={cn(
                  "group flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.02] px-3 py-2.5 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.04]",
                  "animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
                )}
                style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <PazaryeriRozeti platform={pazaryeriOf(rule)} />
                    {rule.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    {rule.categoryName ?? "Tüm kategoriler"} · {formatCurrency(rule.minPrice, { decimals: 0 })} –{" "}
                    {rule.maxPrice >= SINIRSIZ ? "sınırsız" : formatCurrency(rule.maxPrice, { decimals: 0 })} · öncelik {rule.priority}
                  </p>
                </div>
                <span className="rounded-full bg-[#7A7EFF]/15 px-2.5 py-1 text-xs font-semibold text-[#E4E7FF] ring-1 ring-[#7A7EFF]/35 tabular-nums">
                  {oranMetni(rule.commissionRate)}
                  {rule.fixedCommission > 0 && ` + ${formatCurrency(rule.fixedCommission)}`}
                </span>
                <div className="flex items-center gap-0.5">
                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" title="Düzenle" onClick={() => setPencere(rule)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                    title="Sil"
                    onClick={() => setSilinecek(rule)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {gecmisKurallar.length > 0 && (
          <div className="border-t border-white/[0.06] pt-3">
            <button
              type="button"
              onClick={() => setGecmisAcik((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition-transform duration-200", gecmisAcik && "rotate-180")} />
              Geçmiş kurallar ({gecmisKurallar.length})
            </button>
            {gecmisAcik && (
              <div className="mt-2 grid gap-1.5 animate-in fade-in slide-in-from-top-1 duration-300">
                {gecmisKurallar.map((rule) => (
                  <div key={rule.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.015] px-3 py-2 ring-1 ring-white/[0.05]">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <PazaryeriRozeti platform={pazaryeriOf(rule)} />
                        {rule.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground/80 tabular-nums">
                        {tarihMetni(rule.validFrom)} – {rule.validTo ? tarihMetni(rule.validTo) : "açık"} · {oranMetni(rule.commissionRate)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-lg text-xs text-[#A9AEFF] hover:bg-[#7A7EFF]/10"
                      disabled={yeniden.isPending}
                      onClick={() => yeniden.mutate(rule.id)}
                    >
                      Yeniden aç
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Ekle / düzenle — kaydedilmemiş değişiklikle kapatılırsa sorulur. */}
      <Dialog open={pencere != null} onOpenChange={(o) => !o && kapatmayiDene()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pencere === "yeni" ? "Komisyon Kuralı Ekle" : "Kuralı Düzenle"}</DialogTitle>
          </DialogHeader>
          {pencere != null && (
            <RuleForm
              key={pencere === "yeni" ? "yeni" : pencere.id}
              kural={pencere === "yeni" ? null : pencere}
              onSubmit={kaydet}
              isPending={createMutation.isPending || updateMutation.isPending}
              onKirli={setKirli}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={kapatSor} onOpenChange={(o) => !o && setKapatSor(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Kaydedilmemiş değişiklik var</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Kapatırsan yazdıkların kaybolur.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setKapatSor(false)}>
              Düzenlemeye dön
            </Button>
            <Button size="sm" className="bg-rose-500 text-white hover:bg-rose-500/90" onClick={pencereyiKapat}>
              Kaydetmeden kapat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={silinecek != null} onOpenChange={(o) => !o && !deleteMutation.isPending && setSilinecek(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Kural kaldırılsın mı?</DialogTitle>
          </DialogHeader>
          {silinecek && <p className="text-sm font-medium">{silinecek.name}</p>}
          <p className="text-xs text-muted-foreground">Bu ayın başından itibaren uygulanmaz. Önceki aylar değişmez.</p>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={deleteMutation.isPending} onClick={() => setSilinecek(null)}>
              Vazgeç
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
              disabled={deleteMutation.isPending}
              onClick={() => silinecek && deleteMutation.mutate({ id: silinecek.id, tamamen: true })}
            >
              Geçmişten de sil
            </Button>
            <Button
              size="sm"
              className={BIRINCIL}
              disabled={deleteMutation.isPending}
              onClick={() => silinecek && deleteMutation.mutate({ id: silinecek.id, tamamen: false })}
            >
              {deleteMutation.isPending ? "Kaldırılıyor…" : "Bu aydan kaldır"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Shopify sabit komisyon kartı — AppSetting.shopifyCommissionRate (yüzde).
 * Ayar gelmeden alan ve düğme KİLİTLİ: eskiden yüklenirken "3.2" gösteriyor, Kaydet'e basılırsa
 * gerçek oranı eziyordu; boş kayıt da tüm Shopify siparişlerini %0 komisyonlu yapıyordu.
 */
function ShopifyCommissionCard() {
  const qc = useQueryClient();
  const { data: settings, isLoading, isError, isFetching, refetch } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
    refetchOnMount: true,
  });
  const kayitli = settings?.shopifyCommissionRate ?? "3.2";
  const [value, setValue] = useState<string | null>(null);
  const current = value ?? kayitli.replace(".", ",");
  const oran = sayi(current);
  const hata = oran == null ? "Oran gerekli" : oran < 0 || oran > 100 ? "0 ile 100 arasında olmalı" : null;
  const degisti = oran != null && oran !== sayi(kayitli);

  const save = useMutation({
    mutationFn: (rate: string) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopifyCommissionRate: rate }),
      }),
    onSuccess: () => {
      setValue(null);
      void qc.invalidateQueries({ queryKey: ["app-settings"] });
      clearPricingQueryCache(qc, { ayarlarDokunma: true });
      toast.success("Shopify komisyonu kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message || "Kaydedilemedi"),
  });

  return (
    <section
      className="rounded-2xl bg-card p-4 ring-1 ring-[#34D399]/25 animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
      style={{ animationDelay: "80ms" }}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span className="grid size-7 place-items-center rounded-lg bg-[#34D399]/10 text-[#34D399] ring-1 ring-[#34D399]/25">
          <ShoppingBag className="size-3.5" />
        </span>
        Shopify sabit komisyonu
      </h2>
      {isError && !settings ? (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span className="text-rose-300">Ayar yüklenemedi.</span>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-xl" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-start gap-3">
            <div className="w-40 space-y-1">
              <Label className="text-xs">Komisyon oranı (%)</Label>
              {isLoading ? (
                <Skeleton className="h-9 w-full rounded-xl" />
              ) : (
                <Input
                  className={GIRDI}
                  inputMode="decimal"
                  value={current}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
              {hata && !isLoading && <p className="text-[11px] font-medium text-rose-300">{hata}</p>}
            </div>
            <Button
              size="sm"
              className={cn(BIRINCIL, "mt-5")}
              onClick={() => oran != null && save.mutate(String(oran))}
              disabled={isLoading || save.isPending || hata != null || !degisti}
            >
              {save.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Tüm Shopify ürünlerinde aynı oran kullanılır. Bir ilana özel oran girersen o geçerli olur.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * n11 komisyonu — kural girilmez: oranı n11 her siparişte bildirir (kampanyada %0) ve kâra o girer.
 * Kart ilanlardaki oranları özetler; n11 ilanı yoksa hiç görünmez.
 */
function N11KomisyonKarti() {
  const { data } = useQuery<Array<{ commissionRate: number | null }>>({
    queryKey: ["listings", "n11"],
    queryFn: () => fetchJson("/api/listings?platform=n11"),
    staleTime: 5 * 60_000,
  });
  const ozet = useMemo(() => {
    const sayac = new Map<number, number>();
    for (const l of data ?? []) {
      if (l.commissionRate == null) continue;
      // İlanda KDV hariç oran saklı; n11 "%X + KDV" diye bildirir — ekranda n11'in yazdığı gibi.
      const yuzde = Math.round(l.commissionRate * 1000) / 10;
      sayac.set(yuzde, (sayac.get(yuzde) ?? 0) + 1);
    }
    return [...sayac.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);
  if (!data || data.length === 0) return null;
  return (
    <section
      className="rounded-2xl bg-card p-4 ring-1 ring-[#FF44EE]/25 animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
      style={{ animationDelay: "120ms" }}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span className="grid size-7 place-items-center rounded-lg bg-[#FF44EE]/10 text-[#FF44EE] ring-1 ring-[#FF44EE]/25">
          <Percent className="size-3.5" />
        </span>
        n11 komisyonu
      </h2>
      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-2">
        {ozet.slice(0, 4).map(([yuzde, adet], i) => (
          <div key={yuzde} className="animate-in fade-in zoom-in-95 fill-mode-both duration-500" style={{ animationDelay: `${150 + i * 70}ms` }}>
            <p className="text-xl font-semibold tabular-nums">%{String(yuzde).replace(".", ",")}</p>
            <p className="text-[11px] text-muted-foreground tabular-nums">{formatNumber(adet, 0)} ilanda</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Oranı n11 belirler; her siparişte kendiliğinden kullanılır, kural girmen gerekmez.
      </p>
    </section>
  );
}

const PLATFORM_ADI: Record<string, string> = { trendyol: "Trendyol", hepsiburada: "Hepsiburada", n11: "n11", shopify: "Shopify" };

/**
 * Son 30 günde GERÇEKLEŞEN komisyon — platform başına. Siparişler sayfasıyla aynı önbellek.
 * Ortalama yalnız komisyonu BİLİNEN siparişlerden: eşleşmeyen / kısmi siparişler ayrı sayılır
 * (eskiden 0 komisyonla ortalamaya girip oranı düşük gösteriyordu).
 */
function GerceklesenKomisyonKarti() {
  const { data, isLoading, isError, isFetching, refetch } = useQuery<{ orders?: KomisyonSiparisi[]; dataComplete?: boolean }>({
    queryKey: ["orders"],
    queryFn: ({ signal }) => fetchJson("/api/orders", { signal }),
    staleTime: 5 * 60_000,
  });
  const satirlar = useMemo(() => komisyonOzeti(data?.orders ?? []), [data]);
  return (
    <section className={cn(KART, "p-4")}>
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span className="grid size-7 place-items-center rounded-lg bg-white/[0.05] text-[#C9D2F2] ring-1 ring-white/[0.08]">
          <Percent className="size-3.5" />
        </span>
        Son 30 günde ödenen komisyon
      </h2>
      <div className="mt-3">
        {isLoading ? (
          <Skeleton className="h-28 w-full rounded-xl" />
        ) : isError && !data ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-rose-300">Siparişler alınamadı.</span>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-xl" disabled={isFetching} onClick={() => void refetch()}>
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
            </Button>
          </div>
        ) : satirlar.length === 0 ? (
          <p className="text-sm text-muted-foreground">Son 30 günde pazaryeri siparişi yok.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 font-medium">Platform</th>
                    <th className="py-2 text-right font-medium">Sipariş</th>
                    <th className="py-2 text-right font-medium">Ciro</th>
                    <th className="py-2 text-right font-medium">Komisyon</th>
                    <th className="py-2 text-right font-medium">Ortalama</th>
                    <th className="py-2 pl-4 font-medium">Kaynak</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {satirlar.map((p, i) => (
                    <tr
                      key={p.platform}
                      className="border-t border-white/[0.06] transition-colors hover:bg-white/[0.02] animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <td className="py-2.5 font-medium">
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{ background: PLATFORM_RENGI[p.platform as keyof typeof PLATFORM_RENGI] ?? "#C9D2F2" }}
                          />
                          {PLATFORM_ADI[p.platform] ?? p.platform}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">{formatNumber(p.siparis, 0)}</td>
                      <td className="py-2.5 text-right">{formatCurrency(p.ciro)}</td>
                      <td className="py-2.5 text-right">{formatCurrency(p.komisyon)}</td>
                      <td className="py-2.5 text-right font-semibold">{p.oran == null ? "—" : oranMetni(p.oran)}</td>
                      <td className="py-2.5 pl-4 text-xs text-muted-foreground">
                        {[
                          p.gercekAdet ? `${p.gercekAdet} gerçek` : null,
                          p.tahminAdet ? `${p.tahminAdet} tahmini` : null,
                          p.bilinmeyenAdet ? `${p.bilinmeyenAdet} bilinmiyor` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data?.dataComplete === false && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-[#C9D2F2]">
                <AlertTriangle className="h-3.5 w-3.5 text-[#A9AEFF]" /> Bazı pazaryerlerinden veri gelmedi — rakamlar eksik olabilir.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
