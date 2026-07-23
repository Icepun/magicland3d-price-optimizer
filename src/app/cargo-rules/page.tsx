"use client";

/* eslint-disable react/no-unescaped-entities */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Settings2, ChevronDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { cn, formatCurrency } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

interface CargoRule {
  id: string;
  name: string;
  platform: string | null;
  cargoProvider: string | null;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  vatIncluded: boolean;
  priority: number;
  isActive: boolean;
}

type Platform = "shopify" | "trendyol" | "hepsiburada";
type CargoMode = "standart" | "avantajli";

const Schema = z.object({
  name: z.string().min(1, "Ad zorunlu"),
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]).default("trendyol"),
  cargoProvider: z.string().optional(),
  categoryName: z.string().optional(),
  minPrice: z.coerce.number().min(0).default(0),
  maxPrice: z.coerce.number().min(0).default(999999),
  minDesi: z.coerce.number().min(0).default(0),
  maxDesi: z.coerce.number().min(0).default(999),
  cargoCost: z.coerce.number().min(0),
  vatIncluded: z.boolean().default(true),
  priority: z.coerce.number().int().default(10),
  isActive: z.boolean().default(true),
});

type FormData = z.infer<typeof Schema>;

function RuleForm({
  defaultValues,
  onSubmit,
  isPending,
}: {
  defaultValues?: Partial<FormData>;
  onSubmit: (d: FormData) => void;
  isPending: boolean;
}) {
  const form = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: {
      platform: "trendyol",
      minPrice: 0,
      maxPrice: 999999,
      minDesi: 0,
      maxDesi: 999,
      vatIncluded: true,
      priority: 10,
      isActive: true,
      ...defaultValues,
    },
  });
  const isActive = useWatch({ control: form.control, name: "isActive" });
  const vatIncluded = useWatch({ control: form.control, name: "vatIncluded" });
  const platform = useWatch({ control: form.control, name: "platform" });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kural Adı *</Label>
          <Input {...form.register("name")} />
        </div>
        <div>
          <Label>Platform *</Label>
          <select
            value={platform}
            onChange={(e) => form.setValue("platform", e.target.value as Platform)}
            className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="trendyol">Trendyol</option>
            <option value="shopify">Shopify</option>
            <option value="hepsiburada">Hepsiburada</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kargo Firması</Label>
          <Input {...form.register("cargoProvider")} placeholder="Yurtiçi" />
        </div>
        <div>
          <Label>Kategori (opsiyonel)</Label>
          <Input {...form.register("categoryName")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Min. Fiyat (TL)</Label>
          <Input type="number" step="0.01" {...form.register("minPrice")} />
        </div>
        <div>
          <Label>Max. Fiyat (TL)</Label>
          <Input type="number" step="0.01" {...form.register("maxPrice")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Min. Desi</Label>
          <Input type="number" step="0.1" {...form.register("minDesi")} />
        </div>
        <div>
          <Label>Max. Desi</Label>
          <Input type="number" step="0.1" {...form.register("maxDesi")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kargo Maliyeti (TL) *</Label>
          <Input type="number" step="0.01" {...form.register("cargoCost")} />
        </div>
        <div>
          <Label>Öncelik</Label>
          <Input type="number" {...form.register("priority")} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={isActive} onCheckedChange={(v) => form.setValue("isActive", v)} />
        <Label>Aktif</Label>
      </div>
      <div className="flex items-center justify-between rounded-md border px-3 py-2">
        <div>
          <Label>Kargo tutarı KDV dahil</Label>
          <p className="text-[11px] text-muted-foreground">
            Kapalıysa KDV faturaya eklenir ve KDV İadesi'nde ayrılır.
          </p>
        </div>
        <Switch
          checked={vatIncluded}
          onCheckedChange={(v) => form.setValue("vatIncluded", v)}
        />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Kaydediliyor..." : "Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Bir platformun kargo kurallarını ham tablo halinde gösterir (gelişmiş düzenleme). */
function RulesTable({
  rules,
  onEdit,
  onDelete,
  onToggle,
}: {
  rules: CargoRule[];
  onEdit: (r: CargoRule) => void;
  onDelete: (id: string) => void;
  onToggle: (r: CargoRule, v: boolean) => void;
}) {
  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        Bu platform için henüz kargo kuralı yok.
      </div>
    );
  }
  return (
    <div className="rounded-lg border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Kural</th>
            <th className="text-right font-medium px-3 py-2">Fiyat (₺)</th>
            <th className="text-right font-medium px-3 py-2">Desi</th>
            <th className="text-right font-medium px-3 py-2">Kargo</th>
            <th className="text-center font-medium px-3 py-2 w-16">Aktif</th>
            <th className="px-2 py-2 w-16" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className={cn("border-t border-border/60", !r.isActive && "opacity-45")}>
              <td className="px-3 py-2">
                <div className="font-medium leading-tight">{r.name}</div>
                {r.cargoProvider && (
                  <div className="text-[10px] text-muted-foreground">{r.cargoProvider}</div>
                )}
              </td>
              <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
                {r.minPrice} – {r.maxPrice === 999999 ? "∞" : r.maxPrice}
              </td>
              <td className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
                {r.minDesi} – {r.maxDesi === 999 ? "∞" : r.maxDesi}
              </td>
              <td className="text-right px-3 py-2 font-semibold text-primary tabular-nums whitespace-nowrap">
                <div>{formatCurrency(r.cargoCost)}</div>
                <div className="text-[9px] font-normal text-muted-foreground">
                  {r.vatIncluded ? "KDV dahil" : "KDV hariç"}
                </div>
              </td>
              <td className="text-center px-3 py-2">
                <Switch checked={r.isActive} onCheckedChange={(v) => onToggle(r, v)} />
              </td>
              <td className="px-2 py-2">
                <div className="flex items-center justify-end gap-0.5">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="Düzenle" onClick={() => onEdit(r)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive/70 hover:text-destructive" title="Sil" onClick={() => onDelete(r.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HbCargo {
  mode: CargoMode;
  applied: boolean;
  desiBrackets: { fromDesi: number; toDesi: number; cost: number }[];
  flatTiers: { minPrice: number; maxPrice: number; cost: number }[];
}

interface FlatTier { minPrice: number; maxPrice: number; cost: number }
interface DesiBracket { fromDesi: number; toDesi: number; cost: number }

function desiLabel(from: number, to: number): string {
  if (to >= 999) return `${Math.ceil(from)}+`;
  if (from === 0) return `0 – ${to}`;
  const lo = Math.ceil(from);
  return lo === to ? `${to}` : `${lo} – ${to}`;
}

const priceLabel = (v: number) => (v >= 999999 ? "∞" : Math.ceil(v));

/** "Kargo desteğinden yararlanıyor musun?" anahtarı — tüm platformlarda aynı dil. */
function CargoSupportFlag({
  mode,
  onChange,
  disabled,
}: {
  mode: CargoMode;
  onChange: (m: CargoMode) => void;
  disabled?: boolean;
}) {
  const on = mode === "avantajli";
  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3.5 py-3 gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">Kargo desteğinden yararlanıyor musun?</p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          Açık → avantajlı barem (sipariş tutarına göre ucuz sabit ücret). Kapalı → standart desi baremi.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground w-16 text-right">
          {on ? "Avantajlı" : "Standart"}
        </span>
        <Switch checked={on} disabled={disabled} onCheckedChange={(v) => onChange(v ? "avantajli" : "standart")} />
      </div>
    </div>
  );
}

/** Tek, ortak kargo barem görünümü: düz tutar kademeleri + desi tablosu. Üç platform da bunu kullanır. */
function CargoBaremView({
  provider,
  vatNote,
  flatTiers,
  desiBrackets,
  desiThreshold,
  loading,
}: {
  provider: string | null;
  vatNote?: string;
  flatTiers: FlatTier[];
  desiBrackets: DesiBracket[];
  desiThreshold: number;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (flatTiers.length === 0 && desiBrackets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        Bu platform için henüz kargo baremi yok. Aşağıdaki "Gelişmiş" bölümünden kural ekleyebilirsin.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">
        {provider ? (
          <>Kargo firması: <strong className="text-foreground">{provider}</strong></>
        ) : (
          "Kargo baremi"
        )}
        {vatNote ? ` · ${vatNote}` : ""}
      </p>

      {flatTiers.length > 0 && (
        <div className="rounded-lg border overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-300">
          <div className="bg-muted/50 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            Sipariş tutarına göre
          </div>
          <table className="w-full text-sm">
            <tbody>
              {flatTiers.map((t) => (
                <tr key={`${t.minPrice}-${t.maxPrice}`} className="border-t border-border/60">
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">
                    {t.minPrice} – {priceLabel(t.maxPrice)} ₺
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-primary tabular-nums">
                    {formatCurrency(t.cost)}
                  </td>
                </tr>
              ))}
              {desiThreshold > 0 && (
                <tr className="border-t border-border/60">
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{desiThreshold} ₺ ve üzeri</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">desi baremi (aşağıda)</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {desiBrackets.length > 0 && (
        <div className="rounded-lg border overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-300">
          <div className="bg-muted/50 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {desiThreshold > 0 ? `>${desiThreshold} ₺ — Desi baremi` : "Desi baremi"}
          </div>
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
              <tr className="border-t border-border/40">
                <th className="text-left font-medium px-3 py-1.5">Desi</th>
                <th className="text-right font-medium px-3 py-1.5">Kargo</th>
              </tr>
            </thead>
            <tbody>
              {desiBrackets.map((b) => (
                <tr key={`${b.fromDesi}-${b.toDesi}`} className="border-t border-border/40">
                  <td className="px-3 py-1.5 tabular-nums">{desiLabel(b.fromDesi, b.toDesi)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-primary tabular-nums">
                    {formatCurrency(b.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Aktif kurallardan temiz barem türet: düz tutar kademeleri (desi-bağımsız) + desi tablosu. */
function deriveBarem(rules: CargoRule[]): {
  flat: FlatTier[];
  desi: DesiBracket[];
  desiThreshold: number;
  provider: string | null;
} {
  const active = rules.filter((r) => r.isActive);
  // Düz tutar = desi-bağımsız (tüm desi aralığını kapsar: minDesi 0 → maxDesi 999). Desi baremi = alt-aralık.
  // (HB'nin son baremi 19.01–999 desi; minDesi>0 olduğu için düz değil, doğru şekilde desi sayılır.)
  const isFlat = (r: CargoRule) => r.minDesi <= 0 && r.maxDesi >= 999;
  const flat = active
    .filter(isFlat)
    .map((r) => ({ minPrice: r.minPrice, maxPrice: r.maxPrice, cost: r.cargoCost }))
    .sort((a, b) => a.minPrice - b.minPrice);
  const desiRules = active.filter((r) => !isFlat(r));
  const desi = desiRules
    .map((r) => ({ fromDesi: r.minDesi, toDesi: r.maxDesi, cost: r.cargoCost }))
    .sort((a, b) => a.fromDesi - b.fromDesi);
  const desiThreshold = desiRules.length > 0 ? Math.min(...desiRules.map((r) => r.minPrice)) : 0;
  const provider = rules.find((r) => r.cargoProvider)?.cargoProvider ?? null;
  return { flat, desi, desiThreshold, provider };
}

const isTex = (r: CargoRule) => /tex/i.test(r.cargoProvider ?? "") || /tex/i.test(r.name);

/** Gelişmiş: ham kuralları düzenle (katlanır). */
function AdvancedRules({
  rules,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
}: {
  rules: CargoRule[];
  onAdd: () => void;
  onEdit: (r: CargoRule) => void;
  onDelete: (id: string) => void;
  onToggle: (r: CargoRule, v: boolean) => void;
}) {
  return (
    <details className="group rounded-lg border bg-muted/10">
      <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <Settings2 className="h-3.5 w-3.5" />
        Gelişmiş: kuralları düzenle
        <span className="text-muted-foreground/60">({rules.length})</span>
        <ChevronDown className="h-3.5 w-3.5 ml-auto transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3 pb-3 space-y-3">
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4 mr-2" /> Kural Ekle
          </Button>
        </div>
        <RulesTable rules={rules} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} />
      </div>
    </details>
  );
}

export default function CargoRulesPage() {
  const [tab, setTab] = useState<Platform>("trendyol");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CargoRule | null>(null);
  const queryClient = useQueryClient();

  // Kargo değişimi kâr/marj hesabını etkiler → fiyatlamaya bağlı TÜM sorguları tazele.
  // ÖNEMLİ: Ürünler sayfası staleTime:Infinity + refetchOnMount:false kullanıyor → yalnız
  // invalidate onu tazelemez (bu yüzden eskiden ancak yeniden başlatınca düzeliyordu). removeQueries
  // önbelleği SİLER → sayfaya girince taze çeker. Orders sunucu önbeleği ayrıca route'ta düşürüldü.
  const bustPricingQueries = () => clearPricingQueryCache(queryClient);

  const { data: rules = [], isLoading } = useQuery<CargoRule[]>({
    queryKey: ["cargo-rules"],
    queryFn: () => fetchJson("/api/cargo-rules"),
  });

  const { data: hb } = useQuery<HbCargo>({
    queryKey: ["hb-cargo"],
    queryFn: () => fetchJson("/api/cargo-rules/hepsiburada"),
  });

  const applyHb = useMutation({
    mutationFn: (mode: CargoMode) =>
      fetchJson("/api/cargo-rules/hepsiburada", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }),
    onSuccess: (_d, mode) => {
      queryClient.invalidateQueries({ queryKey: ["hb-cargo"] });
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      bustPricingQueries();
      toast.success(mode === "avantajli" ? "Avantajlı barem uygulandı" : "Standart barem uygulandı");
    },
    onError: () => toast.error("Barem uygulanamadı"),
  });

  // İlk kurulumda HB baremi hiç yazılmadıysa mevcut modu otomatik uygula → HB kargosu hemen çalışsın.
  useEffect(() => {
    if (hb && !hb.applied && !applyHb.isPending) applyHb.mutate(hb.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hb?.applied]);

  // ── Platform bazlı kural setleri (TEX = Trendyol; kalan platform-bazlı/eski null kurallar Shopify) ──
  const trendyolRules = rules.filter((r) => r.platform === "trendyol" || isTex(r));
  const shopifyRules = rules.filter((r) => r.platform === "shopify" || (!r.platform && !isTex(r)));
  const trendyolMode: CargoMode = trendyolRules.some((r) => /avantaj/i.test(r.name) && r.isActive)
    ? "avantajli"
    : "standart";

  // Trendyol kargo desteği: TEX düz baremlerinin isActive'ini çevirir (optimistic → anında).
  const applyTrendyol = useMutation({
    mutationFn: (mode: CargoMode) =>
      fetchJson("/api/cargo-rules/trendyol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }),
    onMutate: async (mode: CargoMode) => {
      await queryClient.cancelQueries({ queryKey: ["cargo-rules"] });
      const prev = queryClient.getQueryData<CargoRule[]>(["cargo-rules"]);
      queryClient.setQueryData<CargoRule[]>(["cargo-rules"], (old) =>
        Array.isArray(old)
          ? old.map((r) => {
              if (!isTex(r)) return r;
              if (/avantaj/i.test(r.name)) return { ...r, isActive: mode === "avantajli" };
              if (/standart/i.test(r.name)) return { ...r, isActive: mode === "standart" };
              return r;
            })
          : old
      );
      return { prev };
    },
    onError: (_e, _m, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["cargo-rules"], ctx.prev);
      toast.error("Mod değiştirilemedi");
    },
    onSuccess: (_d, mode) =>
      toast.success(mode === "avantajli" ? "Avantajlı barem aktif" : "Standart barem aktif"),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      bustPricingQueries();
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetchJson("/api/cargo-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      bustPricingQueries();
      toast.success("Kural eklendi");
      setOpen(false);
    },
    onError: () => toast.error("Eklenemedi"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      fetchJson(`/api/cargo-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      bustPricingQueries();
      toast.success("Kural güncellendi");
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/cargo-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      bustPricingQueries();
      toast.success("Kural silindi");
    },
  });

  const onToggleRule = (r: CargoRule, v: boolean) =>
    updateMutation.mutate({ id: r.id, data: { isActive: v } as Partial<FormData> as FormData });

  const trendyolBarem = deriveBarem(trendyolRules);
  const shopifyBarem = deriveBarem(shopifyRules);
  const hepsiburadaRules = rules.filter((r) => r.platform === "hepsiburada");
  const hepsiburadaBarem = deriveBarem(hepsiburadaRules);
  const vatNote = (platformRules: CargoRule[]) => {
    const active = platformRules.filter((rule) => rule.isActive);
    if (active.length === 0) return undefined;
    if (active.every((rule) => rule.vatIncluded)) return "Fiyatlar KDV dahil";
    if (active.every((rule) => !rule.vatIncluded)) return "Fiyatlar KDV hariç";
    return "KDV durumu kurala göre";
  };

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Kargo Kuralları</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Her platformun kargo baremi ayrı. Kural yalnızca kendi platformunun siparişlerine uygulanır.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Platform)}>
        <TabsList>
          <TabsTrigger value="shopify" className="data-[state=active]:text-emerald-500">Shopify</TabsTrigger>
          <TabsTrigger value="trendyol" className="data-[state=active]:text-orange-500">Trendyol</TabsTrigger>
          <TabsTrigger value="hepsiburada" className="data-[state=active]:text-violet-500">Hepsiburada</TabsTrigger>
        </TabsList>

        {/* SHOPIFY — temiz barem görünümü (flag yok) */}
        <TabsContent value="shopify" className="space-y-4 mt-4">
          <Card>
            <CardContent className="pt-4 space-y-4">
              <CargoBaremView
                provider={shopifyBarem.provider}
                vatNote={vatNote(shopifyRules)}
                flatTiers={shopifyBarem.flat}
                desiBrackets={shopifyBarem.desi}
                desiThreshold={shopifyBarem.desiThreshold}
                loading={isLoading}
              />
              {!isLoading && (
                <AdvancedRules
                  rules={shopifyRules}
                  onAdd={() => setOpen(true)}
                  onEdit={setEditing}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onToggle={onToggleRule}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TRENDYOL — temiz barem + kargo desteği flag'i (TEX) */}
        <TabsContent value="trendyol" className="space-y-4 mt-4">
          <Card>
            <CardContent className="pt-4 space-y-4">
              <CargoSupportFlag
                mode={trendyolMode}
                disabled={applyTrendyol.isPending || isLoading}
                onChange={(m) => applyTrendyol.mutate(m)}
              />
              <CargoBaremView
                provider={trendyolBarem.provider}
                vatNote={vatNote(trendyolRules)}
                flatTiers={trendyolBarem.flat}
                desiBrackets={trendyolBarem.desi}
                desiThreshold={trendyolBarem.desiThreshold}
                loading={isLoading}
              />
              {!isLoading && (
                <AdvancedRules
                  rules={trendyolRules}
                  onAdd={() => setOpen(true)}
                  onEdit={setEditing}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onToggle={onToggleRule}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* HEPSIBURADA — HepsiJet baremi + kargo desteği flag'i */}
        <TabsContent value="hepsiburada" className="space-y-4 mt-4">
          <Card>
            <CardContent className="pt-4 space-y-4">
              <CargoSupportFlag
                mode={hb?.mode ?? "standart"}
                disabled={applyHb.isPending || !hb}
                onChange={(m) => applyHb.mutate(m)}
              />
              <CargoBaremView
                provider="HepsiJet"
                vatNote={`Fiyatlar KDV dahil (%20)${applyHb.isPending ? " · uygulanıyor…" : ""}`}
                flatTiers={hepsiburadaBarem.flat}
                desiBrackets={hepsiburadaBarem.desi}
                desiThreshold={hepsiburadaBarem.desiThreshold}
                loading={isLoading || applyHb.isPending}
              />
              {!isLoading && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-muted-foreground">
                    Kargo fiyatı değişince buradan güncelle. Üstteki desteği açıp kapatmak baremi resmi tarifeye sıfırlar.
                  </p>
                  <AdvancedRules
                    rules={hepsiburadaRules}
                    onAdd={() => setOpen(true)}
                    onEdit={setEditing}
                    onDelete={(id) => deleteMutation.mutate(id)}
                    onToggle={onToggleRule}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kargo Kuralı Ekle</DialogTitle>
          </DialogHeader>
          <RuleForm
            defaultValues={{ platform: tab }}
            onSubmit={(d) => createMutation.mutate(d)}
            isPending={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kuralı Düzenle</DialogTitle>
          </DialogHeader>
          {editing && (
            <RuleForm
              defaultValues={{
                ...editing,
                platform: (editing.platform as Platform) ?? "trendyol",
                cargoProvider: editing.cargoProvider ?? undefined,
                categoryName: editing.categoryName ?? undefined,
              }}
              onSubmit={(d) => updateMutation.mutate({ id: editing.id, data: d })}
              isPending={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
