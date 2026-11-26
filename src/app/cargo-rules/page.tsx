"use client";

/* eslint-disable react/no-unescaped-entities */

import { useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CargoCoverageCard } from "./cargo-coverage-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Settings2, ChevronDown, ChevronRight, CalendarClock, Truck } from "lucide-react";
import { NewTariffDialog } from "./new-tariff-dialog";
import { PazaryeriTarifesi } from "./pazaryeri-tarifesi";
import { KargoDenetimiGorunumu } from "./kargo-denetimi";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useForm, useWatch, type Resolver } from "react-hook-form";
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
  /**
   * Geçerlilik penceresi. API bunları hep gönderiyordu ama bu tipte YOKTU — arayüz de
   * göremediği için süresi dolmuş baremleri güncel olanlarla aynı tabloda çiziyordu.
   * Kullanıcının gördüğü "her barem iki kez, iki farklı fiyat" bundan kaynaklanıyordu.
   */
  validFrom: string | null;
  validTo: string | null;
}

type Platform = "shopify" | "trendyol" | "hepsiburada";
type Sekme = Platform | "n11" | "denetim";

/** Boş alan → tanımsız (varsayılan ya da "gerekli" hatası); BOŞ ≠ SIFIR. Virgül kabul. */
const bos = (v: unknown) => (v === "" || v == null ? undefined : typeof v === "string" ? v.replace(",", ".") : v);
const Schema = z
  .object({
    name: z.string().trim().min(1, "Kural adı gerekli"),
    // Trendyol / Hepsiburada kargosu pazaryeri tarifesinden; elle kural yalnız Shopify için.
    platform: z.enum(["shopify"]).default("shopify"),
    cargoProvider: z.string().optional(),
    categoryName: z.string().optional(),
    minPrice: z.preprocess(bos, z.coerce.number({ message: "Geçersiz fiyat" }).min(0, "Fiyat eksi olamaz").default(0)),
    maxPrice: z.preprocess(bos, z.coerce.number({ message: "Geçersiz fiyat" }).min(0, "Fiyat eksi olamaz").default(999999)),
    minDesi: z.preprocess(bos, z.coerce.number({ message: "Geçersiz desi" }).min(0, "Desi eksi olamaz").default(0)),
    maxDesi: z.preprocess(bos, z.coerce.number({ message: "Geçersiz desi" }).min(0, "Desi eksi olamaz").default(999)),
    // Boş kargo bedeli eskiden 0 TL'lik kural oluşturuyordu (kâr şişerdi).
    cargoCost: z.preprocess(bos, z.coerce.number({ message: "Kargo bedeli gerekli" }).min(0, "Kargo bedeli eksi olamaz")),
    vatIncluded: z.boolean().default(true),
    priority: z.preprocess(bos, z.coerce.number().int("Öncelik tam sayı olmalı").default(10)),
    isActive: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (d.maxPrice < d.minPrice) ctx.addIssue({ code: "custom", path: ["maxPrice"], message: "Max fiyat min fiyattan küçük olamaz" });
    if (d.maxDesi < d.minDesi) ctx.addIssue({ code: "custom", path: ["maxDesi"], message: "Max desi min desiden küçük olamaz" });
  });

type FormData = z.output<typeof Schema>;

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
    // Ön işleme (boş alan → varsayılan) girdi tipini değiştirdiği için çözümleyici tipi daraltılıyor.
    resolver: zodResolver(Schema) as unknown as Resolver<FormData>,
    defaultValues: {
      platform: "shopify",
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
  const ilkHata = Object.values(form.formState.errors)[0]?.message;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kural Adı *</Label>
          <Input {...form.register("name")} />
        </div>
        <div>
          <Label>Platform</Label>
          <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground">
            Shopify
          </div>
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
          <Input type="number" {...form.register("priority")} title="Aynı siparişe birden çok kural uyarsa yüksek olan geçerli" />
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
      {typeof ilkHata === "string" && (
        <p className="text-[12px] font-medium text-rose-300 animate-in fade-in duration-200">{ilkHata}</p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Dönemi bitmiş kural (validTo geçmişte) — düzenlenemez/silinemez. */
function suresiDoldu(r: { validTo?: string | Date | null }, simdiMs: number): boolean {
  if (!r.validTo) return false;
  const t = new Date(r.validTo).getTime();
  return Number.isFinite(t) && t < simdiMs;
}

/** Bir platformun kargo kurallarını ham tablo halinde gösterir (gelişmiş düzenleme). */
function RulesTable({
  rules,
  simdiMs,
  onEdit,
  onDelete,
  onToggle,
}: {
  rules: CargoRule[];
  simdiMs: number;
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
            <tr
              key={r.id}
              className={cn(
                "border-t border-border/60 transition-colors",
                !r.isActive && "opacity-45",
                !yururlukteMi(r, simdiMs) && "bg-muted/30"
              )}
            >
              <td className="px-3 py-2">
                <div className="font-medium leading-tight">{r.name}</div>
                {r.cargoProvider && (
                  <div className="text-[10px] text-muted-foreground">{r.cargoProvider}</div>
                )}
                {!yururlukteMi(r, simdiMs) && r.validTo && (
                  <div className="text-[10px] text-[#A9AEFF]">
                    süresi doldu · {kisaTarih(r.validTo)}
                  </div>
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
                <Switch
                  checked={r.isActive}
                  disabled={suresiDoldu(r, simdiMs)}
                  onCheckedChange={(v) => onToggle(r, v)}
                />
              </td>
              <td className="px-2 py-2">
                {/* Geçmiş dönemin kuralı KİLİTLİ: değiştirmek o dönemin siparişlerinin kargosunu sessizce değiştirirdi. */}
                {suresiDoldu(r, simdiMs) ? (
                  <span className="block text-right text-[10px] text-muted-foreground">kilitli</span>
                ) : (
                <div className="flex items-center justify-end gap-0.5">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="Düzenle" onClick={() => onEdit(r)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200" title="Sil" onClick={() => onDelete(r.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

/** Tek, ortak kargo barem görünümü: düz tutar kademeleri + desi tablosu. Üç platform da bunu kullanır. */
function CargoBaremView({
  provider,
  vatNote,
  flatTiers,
  desiBrackets,
  desiThreshold,
  loading,
  maxDesi,
}: {
  provider: string | null;
  vatNote?: string;
  flatTiers: FlatTier[];
  desiBrackets: DesiBracket[];
  desiThreshold: number;
  loading?: boolean;
  /** Ürünlerdeki en büyük desi — bunun üstündeki baremler katlanır. */
  maxDesi?: number | null;
}) {
  const [hepsiniGoster, setHepsiniGoster] = useState(false);
  /**
   * Görünen baremler: ürünlerin en büyüğünü kapsayan barem DAHİL, üstü katlanır.
   *
   * Ölçüldü (14 Ağu 2026): en büyük ürün 6 desi, oysa tablolar 30-40 desiye kadar gidiyor.
   * Kullanılmayan baremler tabloyu uzatıp taranmasını zorlaştırıyordu. Silinmiyorlar —
   * yarın daha büyük bir ürün çıkarsa tarife hazır olsun.
   *
   * Sınır bilinmiyorsa (hiç desi girilmemiş) hepsi gösterilir: tahminle gizlemeyiz.
   */
  const { gorunenBaremler, gizliSayi } = useMemo(() => {
    if (hepsiniGoster || maxDesi == null) {
      return { gorunenBaremler: desiBrackets, gizliSayi: 0 };
    }
    const kapsayanIndeks = desiBrackets.findIndex((b) => b.toDesi >= maxDesi);
    if (kapsayanIndeks < 0) return { gorunenBaremler: desiBrackets, gizliSayi: 0 };
    // Kapsayan baremin bir üstünü de göster: sınırın hemen ötesi görünsün.
    const kesim = Math.min(desiBrackets.length, kapsayanIndeks + 2);
    return {
      gorunenBaremler: desiBrackets.slice(0, kesim),
      gizliSayi: desiBrackets.length - kesim,
    };
  }, [desiBrackets, maxDesi, hepsiniGoster]);

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
              {gorunenBaremler.map((b) => (
                <tr key={`${b.fromDesi}-${b.toDesi}`} className="border-t border-border/40">
                  <td className="px-3 py-1.5 tabular-nums">{desiLabel(b.fromDesi, b.toDesi)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-primary tabular-nums">
                    {formatCurrency(b.cost)}
                  </td>
                </tr>
              ))}
              {/* Ürünlerinin en büyüğünün ÜSTÜNDEKİ baremler katlanır: tabloyu uzatıp
                  tarattırıyorlar ama pratikte hiç eşleşmiyorlar. Silinmiyorlar — yarın
                  daha büyük bir ürün çıkarsa tarife hazır olsun. */}
              {gizliSayi > 0 && (
                <tr className="border-t border-border/40">
                  <td colSpan={2} className="px-3 py-1.5">
                    <button
                      type="button"
                      onClick={() => setHepsiniGoster((v) => !v)}
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {hepsiniGoster
                        ? "Büyük desileri gizle"
                        : `+${gizliSayi} barem daha (en büyük ürünün ${maxDesi} desi)`}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Bir kural verilen anda YÜRÜRLÜKTE mi?
 *
 * Kargo tarifeleri dönem dönem değişiyor ve eski kurallar SİLİNMİYOR — `validTo` ile kapanıyor,
 * çünkü geçmiş siparişler kendi dönemlerinin fiyatıyla hesaplanmaya devam etmeli
 * (`core/order-profit.ts → orderedAt`). Bu yüzden "hangi barem şu an geçerli" sorusu
 * `isActive`'e değil, tarih penceresine bakar.
 */
function yururlukteMi(r: CargoRule, simdiMs: number): boolean {
  if (r.validFrom && new Date(r.validFrom).getTime() > simdiMs) return false;
  if (r.validTo && new Date(r.validTo).getTime() < simdiMs) return false;
  return true;
}

/**
 * HENÜZ BAŞLAMAMIŞ tarifeleri başlangıç tarihine göre grupla (en yakın olan üstte).
 *
 * İleri tarihli bir tarife başlatıldığında bu kurallar ne yürürlüktedir ne de süresi dolmuştur;
 * gösterilmezse kullanıcı işlemin başarısız olduğunu sanır.
 */
function gelecekDonemler(rules: CargoRule[], simdiMs: number): { baslangic: string; kurallar: CargoRule[] }[] {
  const gruplar = new Map<string, CargoRule[]>();
  for (const r of rules) {
    if (!r.validFrom) continue;
    if (new Date(r.validFrom).getTime() <= simdiMs) continue;
    const mevcut = gruplar.get(r.validFrom);
    if (mevcut) mevcut.push(r);
    else gruplar.set(r.validFrom, [r]);
  }
  return [...gruplar.entries()]
    .map(([baslangic, kurallar]) => ({ baslangic, kurallar }))
    .sort((a, b) => new Date(a.baslangic).getTime() - new Date(b.baslangic).getTime());
}

/** Süresi dolmuş kuralları kapanış tarihine göre grupla (en yeni dönem üstte). */
function gecmisDonemler(rules: CargoRule[], simdiMs: number): { bitis: string; kurallar: CargoRule[] }[] {
  const gruplar = new Map<string, CargoRule[]>();
  for (const r of rules) {
    if (yururlukteMi(r, simdiMs) || !r.validTo) continue;
    const anahtar = r.validTo;
    const mevcut = gruplar.get(anahtar);
    if (mevcut) mevcut.push(r);
    else gruplar.set(anahtar, [r]);
  }
  return [...gruplar.entries()]
    .map(([bitis, kurallar]) => ({ bitis, kurallar }))
    .sort((a, b) => new Date(b.bitis).getTime() - new Date(a.bitis).getTime());
}

/** Verilen kural setinden temiz barem kur: düz tutar kademeleri (desi-bağımsız) + desi tablosu. */
function baremKur(active: CargoRule[]): {
  flat: FlatTier[];
  desi: DesiBracket[];
  desiThreshold: number;
  provider: string | null;
} {
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
  const provider = active.find((r) => r.cargoProvider)?.cargoProvider ?? null;
  return { flat, desi, desiThreshold, provider };
}

/**
 * Sayfanın gösterdiği barem: yalnız BUGÜN yürürlükte olan ve açık kurallar.
 *
 * Eskiden yalnız `isActive`'e bakılıyordu; süresi dolmuş tarife de aynı tabloya giriyor ve
 * her barem iki kez, iki farklı fiyatla görünüyordu. Eski kurallar silinmez — aşağıdaki
 * "Geçmiş tarifeler" bölümünde durur.
 */
function deriveBarem(rules: CargoRule[], simdiMs: number) {
  return baremKur(rules.filter((r) => r.isActive && yururlukteMi(r, simdiMs)));
}

const isTex = (r: CargoRule) => /tex/i.test(r.cargoProvider ?? "") || /tex/i.test(r.name);

/** "31 Tem 2026" — Türkiye saatiyle kısa tarih. */
function kisaTarih(iso: string): string {
  return new Date(iso).toLocaleDateString("tr-TR", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Istanbul",
  });
}

/**
 * Yeni tarife başlatma düğmesi + diyaloğu (platform başına).
 *
 * Kargo zamları dönem dönem geliyor; eskiden yeni tarife girmek KOD değişikliği gerektiriyordu.
 * Diyalog yürürlükteki tarifenin kopyasıyla açılır, kaydedince eski dönem kapanır ve yenisi başlar.
 */
function YeniTarifeAksiyonu({
  platform,
  platformAdi,
  rules,
  simdiMs,
}: {
  platform: "trendyol" | "shopify" | "hepsiburada";
  platformAdi: string;
  rules: CargoRule[];
  simdiMs: number;
}) {
  const [acik, setAcik] = useState(false);
  // Pasif baremler de taşınır — barem modu (Avantajlı/Standart) yeni dönemde de çalışsın.
  const yururlukte = rules.filter((r) => yururlukteMi(r, simdiMs));
  if (yururlukte.length === 0) return null;
  return (
    <>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setAcik(true)}>
          <CalendarClock className="h-3.5 w-3.5" />
          Yeni tarife başlat
        </Button>
      </div>
      <NewTariffDialog
        open={acik}
        onOpenChange={setAcik}
        platform={platform}
        platformAdi={platformAdi}
        yururluktekiKurallar={yururlukte}
      />
    </>
  );
}

/**
 * YAKLAŞAN TARİFE — başlangıcı geleceğe kurulmuş barem.
 *
 * Yürürlükte değil (henüz başlamadı) ve süresi de dolmadı; gösterilmezse hiçbir yerde
 * görünmez ve kullanıcı "tarife başlat" işleminin çalışmadığını sanır. Ayrıca o tarih
 * geldiğinde fiyatların değişeceğini önceden görmek işin doğası.
 */
function YaklasanTarifeler({ rules, simdiMs }: { rules: CargoRule[]; simdiMs: number }) {
  const donemler = useMemo(() => gelecekDonemler(rules, simdiMs), [rules, simdiMs]);
  if (donemler.length === 0) return null;

  return (
    <div className="space-y-2.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      {donemler.map((d) => {
        const barem = baremKur(d.kurallar.filter((r) => r.isActive));
        return (
          <div key={d.baslangic} className="rounded-lg border border-primary/30 bg-primary/5 overflow-hidden">
            <div className="px-3 py-2 flex items-center gap-2">
              <CalendarClock className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-xs font-medium">{kisaTarih(d.baslangic)} tarihinde başlayacak</span>
              <span className="text-[11px] text-muted-foreground">yeni tarife hazır</span>
            </div>
            <div className="px-3 pb-3">
              <div className="rounded-md border border-border/50 overflow-hidden bg-background/40">
                <table className="w-full text-xs">
                  <tbody>
                    {barem.flat.map((t) => (
                      <tr key={`f-${t.minPrice}-${t.maxPrice}`} className="border-b border-border/40 last:border-0">
                        <td className="px-2.5 py-1.5 text-muted-foreground tabular-nums">
                          {t.minPrice} – {priceLabel(t.maxPrice)} ₺
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums font-medium">{formatCurrency(t.cost)}</td>
                      </tr>
                    ))}
                    {barem.desi.map((b) => (
                      <tr key={`d-${b.fromDesi}-${b.toDesi}`} className="border-b border-border/40 last:border-0">
                        <td className="px-2.5 py-1.5 text-muted-foreground tabular-nums">
                          {desiLabel(b.fromDesi, b.toDesi)} desi
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums font-medium">{formatCurrency(b.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * GEÇMİŞ TARİFELER — süresi dolmuş baremler.
 *
 * Silinmiyorlar: o dönemde verilen siparişlerin kargo maliyeti hâlâ bunlardan hesaplanıyor
 * (`core/order-profit.ts` siparişin KENDİ tarihine göre kural seçer). Silinseydi geçmiş
 * ayların kâr rakamları sessizce değişirdi. Burada katlanmış duruyorlar ki güncel barem
 * tablosu tek ve net kalsın.
 */
function GecmisTarifeler({ rules, simdiMs }: { rules: CargoRule[]; simdiMs: number }) {
  const [acik, setAcik] = useState(false);
  const donemler = useMemo(() => gecmisDonemler(rules, simdiMs), [rules, simdiMs]);
  if (donemler.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setAcik((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", acik && "rotate-90")}
        />
        <span className="text-xs font-medium">Geçmiş tarifeler</span>
        <span className="text-[11px] text-muted-foreground">
          {donemler.length === 1
            ? `${kisaTarih(donemler[0].bitis)} tarihine kadar geçerliydi`
            : `${donemler.length} eski dönem`}
        </span>
      </button>

      {acik && (
        <div className="px-3 pb-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Bu fiyatlar artık kullanılmıyor; o tarihlerdeki siparişler için saklanıyor.
          </p>
          {donemler.map((d) => {
            const barem = baremKur(d.kurallar.filter((r) => r.isActive));
            return (
              <div key={d.bitis} className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {kisaTarih(d.bitis)} tarihine kadar
                </div>
                <div className="rounded-md border border-border/50 overflow-hidden opacity-75">
                  <table className="w-full text-xs">
                    <tbody>
                      {barem.flat.map((t) => (
                        <tr key={`f-${t.minPrice}-${t.maxPrice}`} className="border-b border-border/40 last:border-0">
                          <td className="px-2.5 py-1.5 text-muted-foreground tabular-nums">
                            {t.minPrice} – {priceLabel(t.maxPrice)} ₺
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{formatCurrency(t.cost)}</td>
                        </tr>
                      ))}
                      {barem.desi.map((b) => (
                        <tr key={`d-${b.fromDesi}-${b.toDesi}`} className="border-b border-border/40 last:border-0">
                          <td className="px-2.5 py-1.5 text-muted-foreground tabular-nums">
                            {desiLabel(b.fromDesi, b.toDesi)} desi
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{formatCurrency(b.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Gelişmiş: ham kuralları düzenle (katlanır). */
function AdvancedRules({
  rules,
  simdiMs,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
}: {
  rules: CargoRule[];
  simdiMs: number;
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
        <RulesTable rules={rules} simdiMs={simdiMs} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} />
      </div>
    </details>
  );
}

export default function CargoRulesPage() {
  // Bildirimden gelince (?sekme=denetim) doğrudan denetim sekmesi açılır; kullanıcı seçince o kazanır.
  const sekmeAdresi = useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).get("sekme"),
    () => null
  );
  const [secilenSekme, setTab] = useState<Sekme | null>(null);
  const tab: Sekme = secilenSekme ?? (sekmeAdresi === "denetim" ? "denetim" : "trendyol");
  /**
   * Geçerlilik penceresi için TEK bir "şimdi" — sayfa açıkken sabit kalır.
   * Her render'da yeniden okunsaydı hesap saf olmazdı; tarifeler zaten aylık ölçekte değişiyor,
   * sayfa açıkken donmuş bir an yeterli.
   */
  const [simdiMs] = useState(() => Date.now());
  /**
   * Kapsam bilgisi — ürünlerdeki en büyük desiyi buradan alıyoruz.
   * Kart zaten aynı ucu çekiyor; TanStack aynı anahtarı paylaştığı için EK istek olmuyor.
   */
  const { data: kapsam } = useQuery<{ maxDesi: number | null }>({
    queryKey: ["cargo-coverage"],
    queryFn: () => fetchJson("/api/cargo-rules/coverage"),
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CargoRule | null>(null);
  const queryClient = useQueryClient();

  // Kargo değişimi kâr/marj hesabını etkiler → fiyatlamaya bağlı TÜM sorguları tazele.
  // ÖNEMLİ: Ürünler sayfası staleTime:Infinity + refetchOnMount:false kullanıyor → yalnız
  // invalidate onu tazelemez (bu yüzden eskiden ancak yeniden başlatınca düzeliyordu). removeQueries
  // önbelleği SİLER → sayfaya girince taze çeker. Orders sunucu önbeleği ayrıca route'ta düşürüldü.
  const bustPricingQueries = () => clearPricingQueryCache(queryClient);

  const {
    data: rules = [],
    isLoading,
    isError: kuralHatasi,
    isFetching: kurallarCekiliyor,
    refetch: kurallariYenidenCek,
  } = useQuery<CargoRule[]>({
    queryKey: ["cargo-rules"],
    queryFn: () => fetchJson("/api/cargo-rules"),
    // Telefondan yapılan değişiklik görünsün.
    refetchOnMount: "always",
  });
  /** Okunamadı ≠ kural yok: "kural ekleyebilirsin" denince mükerrer kural doğuyordu. */
  const kuralYok = kuralHatasi && rules.length === 0;
  const [silinecekId, setSilinecekId] = useState<string | null>(null);

  // ── Shopify kuralları (platform-bazlı + eski platformsuz kurallar; TEX'li olanlar Trendyol'undu) ──
  // Trendyol ve Hepsiburada kargosu artık pazaryeri tarifesinden (düzenlenmez) — kural tablosundaki
  // eski satırları yalnız tarife öncesi siparişler kullanır; burada gösterilmez.
  const shopifyRules = rules.filter((r) => r.platform === "shopify" || (!r.platform && !isTex(r)));

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
    onError: (e: Error) => toast.error(e.message || "Kural eklenemedi"),
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
    onError: (e: Error) => toast.error(e.message || "Kural güncellenemedi"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/cargo-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      bustPricingQueries();
      toast.success("Kural silindi");
      setSilinecekId(null);
    },
    onError: (e: Error) => toast.error(e.message || "Kural silinemedi"),
  });

  const onToggleRule = (r: CargoRule, v: boolean) =>
    updateMutation.mutate({ id: r.id, data: { isActive: v } as Partial<FormData> as FormData });

  const shopifyBarem = deriveBarem(shopifyRules, simdiMs);
  const vatNote = (platformRules: CargoRule[]) => {
    const active = platformRules.filter((rule) => rule.isActive && yururlukteMi(rule, simdiMs));
    if (active.length === 0) return undefined;
    if (active.every((rule) => rule.vatIncluded)) return "Fiyatlar KDV dahil";
    if (active.every((rule) => !rule.vatIncluded)) return "Fiyatlar KDV hariç";
    return "KDV durumu kurala göre";
  };

  return (
    <div className="p-6 space-y-5 mx-auto w-full max-w-6xl">
      <header className="flex min-w-0 items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
          <Truck className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Kargo</h1>
          <p className="text-xs text-muted-foreground">
            Trendyol, Hepsiburada ve n11 fiyatları pazaryerinin kendi listesi — Shopify kargonu buradan düzenlersin.
          </p>
        </div>
      </header>

      {/* Kurallar doğru olsa bile ürünün desisi yoksa kargo bedeli tahmin ediliyor —
          sayfanın söylemediği en önemli şey buydu. */}
      <CargoCoverageCard />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Sekme)}>
        <TabsList className="h-auto gap-0.5 rounded-xl bg-white/[0.03] p-0.5 ring-1 ring-white/[0.08]">
          {([
            ["trendyol", "Trendyol", "#F27A1A"],
            ["hepsiburada", "Hepsiburada", "#4F8CFF"],
            ["n11", "n11", "#FF44EE"],
            ["shopify", "Shopify", "#34D399"],
            ["denetim", "Denetim", "#A9AEFF"],
          ] as const).map(([deger, ad, renk]) => (
            <TabsTrigger
              key={deger}
              value={deger}
              className="gap-1.5 rounded-lg px-3 py-1.5 transition-all active:scale-[0.97] data-[state=active]:bg-white/[0.07] data-[state=active]:shadow-[0_6px_18px_-10px_rgba(122,126,255,0.9)]"
            >
              <span className="size-1.5 rounded-full" style={{ background: renk }} />
              {ad}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* SHOPIFY — temiz barem görünümü (flag yok) */}
        <TabsContent value="shopify" className="space-y-4 mt-4">
          <Card className="rounded-2xl border-0 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
            <CardContent className="pt-4 space-y-4">
              {kuralYok ? (
                <div className="flex flex-col items-center gap-3 rounded-2xl bg-rose-500/[0.05] px-4 py-10 text-center ring-1 ring-rose-400/25 animate-in fade-in duration-300">
                  <p className="font-medium">Kargo kuralları yüklenemedi</p>
                  <p className="text-sm text-muted-foreground">Bağlantını kontrol edip tekrar dene.</p>
                  <Button variant="outline" size="sm" className="rounded-xl" disabled={kurallarCekiliyor} onClick={() => void kurallariYenidenCek()}>
                    Tekrar dene
                  </Button>
                </div>
              ) : (
              <CargoBaremView
                maxDesi={kapsam?.maxDesi ?? null}
                provider={shopifyBarem.provider}
                vatNote={vatNote(shopifyRules)}
                flatTiers={shopifyBarem.flat}
                desiBrackets={shopifyBarem.desi}
                desiThreshold={shopifyBarem.desiThreshold}
                loading={isLoading}
              />
              )}
              {!isLoading && !kuralYok && (
                <YeniTarifeAksiyonu platform="shopify" platformAdi="Shopify" rules={shopifyRules} simdiMs={simdiMs} />
              )}
              {!isLoading && !kuralYok && <YaklasanTarifeler rules={shopifyRules} simdiMs={simdiMs} />}
              {!isLoading && !kuralYok && <GecmisTarifeler rules={shopifyRules} simdiMs={simdiMs} />}
              {!isLoading && !kuralYok && (
                <AdvancedRules
                  rules={shopifyRules}
                  simdiMs={simdiMs}
                  onAdd={() => setOpen(true)}
                  onEdit={setEditing}
                  onDelete={(id) => setSilinecekId(id)}
                  onToggle={onToggleRule}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TRENDYOL / HEPSİBURADA — pazaryerinin fiyat listesi; düzenlenmez (core/kargo-tarife). */}
        <TabsContent value="trendyol" className="space-y-4 mt-4">
          <Card className="rounded-2xl border-0 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
            <CardContent className="pt-4">
              <PazaryeriTarifesi platform="trendyol" maxDesi={kapsam?.maxDesi ?? null} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hepsiburada" className="space-y-4 mt-4">
          <Card className="rounded-2xl border-0 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
            <CardContent className="pt-4">
              <PazaryeriTarifesi platform="hepsiburada" maxDesi={kapsam?.maxDesi ?? null} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="n11" className="space-y-4 mt-4">
          <Card className="rounded-2xl border-0 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
            <CardContent className="pt-4">
              <PazaryeriTarifesi platform="n11" maxDesi={kapsam?.maxDesi ?? null} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="denetim" className="space-y-4 mt-4">
          <Card className="rounded-2xl border-0 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
            <CardContent className="pt-4">
              <KargoDenetimiGorunumu />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Silme onayı — eskiden tek tıkla kalıcı siliyordu. */}
      <Dialog open={silinecekId != null} onOpenChange={(o) => !o && !deleteMutation.isPending && setSilinecekId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base text-rose-300">Kural silinsin mi?</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-medium">{rules.find((r) => r.id === silinecekId)?.name}</p>
          <p className="text-xs text-muted-foreground">
            Bu işlem geri alınamaz. Kuralın geçtiği siparişlerin kargosu yeniden hesaplanır — istersen pasif yapabilirsin.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" disabled={deleteMutation.isPending} onClick={() => setSilinecekId(null)}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              className="bg-rose-500 text-white hover:bg-rose-500/90"
              disabled={deleteMutation.isPending}
              onClick={() => silinecekId && deleteMutation.mutate(silinecekId)}
            >
              {deleteMutation.isPending ? "Siliniyor…" : "Sil"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kargo Kuralı Ekle</DialogTitle>
          </DialogHeader>
          <RuleForm
            defaultValues={{ platform: "shopify" }}
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
                platform: "shopify",
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
