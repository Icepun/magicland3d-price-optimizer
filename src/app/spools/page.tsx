"use client";

import { fetchJson } from "@/lib/fetch-json";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Disc3,
  Plus,
  AlertTriangle,
  Trash2,
  Pencil,
  ArrowDownToLine,
  RefreshCcw,
  X,
  PackageOpen,
  History,
  ChevronDown,
  Hourglass,
  Coins,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Spool {
  id: string;
  name: string;
  material: string;
  colorName: string | null;
  colorHex: string;
  brand: string | null;
  totalGrams: number;
  remainingGrams: number;
  spoolCost: number | null;
  reorderGrams: number;
  vendorUrl: string | null;
  /** Makaranın gerçek gram maliyeti ile maliyet ayarlarındaki değer belirgin ayrıştıysa dolu gelir. */
  costGap?: { actualPerGram: number; tablePerGram: number } | null;
}

interface ProductLite {
  id: string;
  name: string;
  cost?: { filamentWeight: number | null } | null;
}

interface UsageEntry {
  id: string;
  grams: number;
  productId: string | null;
  productName: string | null;
  note: string | null;
  createdAt: string;
}

interface UsagePace {
  gramsPerDay: number;
  sampleCount: number;
  spanDays: number;
  windowGrams: number;
}

interface UsagePage {
  items: UsageEntry[];
  nextCursor: string | null;
  pace: UsagePace | null;
  now: number;
}

const MATERIALS = ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Reçine"];

const USAGE_PAGE_SIZE = 15;
const DAY_MS = 86_400_000;

function statusOf(s: Spool): { label: string; cls: string; bar: string } {
  if (s.remainingGrams <= 0)
    return { label: "Bitti", cls: "bg-destructive/15 text-destructive border-destructive/30", bar: "bg-destructive" };
  if (s.remainingGrams <= s.reorderGrams)
    return { label: "Sipariş ver", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30", bar: "bg-amber-500" };
  return { label: "Yeterli", cls: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30", bar: "bg-green-500" };
}

export default function SpoolsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Spool[]>({
    queryKey: ["spools"],
    queryFn: () => fetchJson("/api/spools"),
    // Makaralar nadir değişir + mutasyonlar (ekle/düzenle/tüket) ["spools"]'u invalidate ediyor
    // → her ziyarette yeniden çekme, sekmeye dönünce anında gel.
    staleTime: 10 * 60_000,
  });
  const spools = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const [editing, setEditing] = useState<Spool | "new" | null>(null);
  const [consuming, setConsuming] = useState<Spool | null>(null);

  const lowSpools = spools.filter((s) => s.remainingGrams <= s.reorderGrams && s.remainingGrams > 0);
  const emptySpools = spools.filter((s) => s.remainingGrams <= 0);
  const alertCount = lowSpools.length + emptySpools.length;

  const del = useMutation({
    mutationFn: (id: string) => fetch(`/api/spools/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: (_result, id) => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      // Silinen makaranın geçmişi bellekte kalmasın.
      qc.removeQueries({ queryKey: ["spool-usage", id] });
      toast.success("Makara silindi");
    },
  });

  const refill = useMutation({
    mutationFn: (s: Spool) =>
      fetch(`/api/spools/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remainingGrams: s.totalGrams }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      toast.success("Makara dolu olarak işaretlendi");
    },
  });

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Disc3 className="h-6 w-6 text-primary" /> Filament
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Makara envanteri — her baskıda kullanılan filamenti düş, kritik seviyede sipariş uyarısı al.
          </p>
        </div>
        <Button size="sm" className="gap-2 shrink-0" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> Makara Ekle
        </Button>
      </div>

      {alertCount > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-600 dark:text-amber-400">
                {emptySpools.length > 0 && `${emptySpools.length} makara bitti. `}
                {lowSpools.length > 0 && `${lowSpools.length} makara kritik seviyede.`}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {[...emptySpools, ...lowSpools].map((s) => s.name).join(", ")} — sipariş vermeyi unutma.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[150px] w-full rounded-xl" />
          ))}
        </div>
      ) : spools.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="Henüz makara yok"
          description="Stoktaki filament makaralarını ekle; baskı yaptıkça düş, kritik seviyede uyaralım."
          action={
            <Button size="sm" onClick={() => setEditing("new")} className="gap-2">
              <Plus className="h-4 w-4" /> İlk makarayı ekle
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-start">
          {spools.map((s, index) => (
            <SpoolCard
              key={s.id}
              spool={s}
              index={index}
              onConsume={() => setConsuming(s)}
              onEdit={() => setEditing(s)}
              onRefill={() => refill.mutate(s)}
              onDelete={() => {
                if (confirm(`"${s.name}" makarası silinsin mi?`)) del.mutate(s.id);
              }}
            />
          ))}
        </div>
      )}

      {editing && <SpoolModal spool={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {consuming && <ConsumeModal spool={consuming} onClose={() => setConsuming(null)} />}
    </div>
  );
}

function SpoolCard({
  spool,
  index,
  onConsume,
  onEdit,
  onRefill,
  onDelete,
}: {
  spool: Spool;
  index: number;
  onConsume: () => void;
  onEdit: () => void;
  onRefill: () => void;
  onDelete: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  // Bir kez açıldıktan sonra içerik takılı kalır: kapanış animasyonu boş kutuya değil,
  // gerçek listeye uygulanır (ve tekrar açınca veri anında hazır).
  const [historyMounted, setHistoryMounted] = useState(false);
  const st = statusOf(spool);
  const pct = Math.max(0, Math.min(100, Math.round((spool.remainingGrams / Math.max(1, spool.totalGrams)) * 100)));
  const gap = spool.costGap ?? null;

  return (
    <Card
      className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 transition-shadow hover:shadow-md"
      style={{ animationDelay: `${Math.min(index, 11) * 40}ms`, animationFillMode: "backwards" }}
    >
      <div className="h-1.5 w-full" style={{ background: spool.colorHex }} />
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="h-8 w-8 rounded-full border shrink-0"
              style={{ background: spool.colorHex }}
              title={spool.colorName ?? spool.colorHex}
            />
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate leading-tight">{spool.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {spool.material}
                {spool.brand ? ` · ${spool.brand}` : ""}
              </p>
            </div>
          </div>
          <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0", st.cls)}>
            {st.label}
          </span>
        </div>

        <div className="space-y-1">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all duration-700 ease-out", st.bar)}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] tabular-nums">
            <span className="font-medium">
              <AnimatedNumber value={spool.remainingGrams} format={(n) => formatNumber(n, 0)} /> g kaldı
            </span>
            <span className="text-muted-foreground">
              / {formatNumber(spool.totalGrams, 0)} g · %
              <AnimatedNumber value={pct} format={(n) => formatNumber(n, 0)} />
            </span>
          </div>
        </div>

        {gap && (
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-600 dark:text-amber-400 animate-in fade-in duration-500">
            <Coins className="h-3.5 w-3.5 shrink-0 mt-px" />
            <span className="text-muted-foreground">
              Bu makaranın gerçek maliyeti{" "}
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                {formatCurrency(gap.actualPerGram)}/g
              </span>
              ; tabloda {formatCurrency(gap.tablePerGram)}/g yazıyor.{" "}
              <Link
                href="/cost-templates"
                className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
              >
                Maliyet ayarları <ArrowRight className="h-3 w-3" />
              </Link>
            </span>
          </p>
        )}

        <div className="flex items-center gap-1 pt-0.5">
          <Button size="sm" variant="outline" className="h-7 flex-1 gap-1 text-xs" onClick={onConsume}>
            <ArrowDownToLine className="h-3.5 w-3.5" /> Düş
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={cn("h-7 w-7", historyOpen && "bg-muted text-foreground")}
            title="Geçmiş"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryMounted(true);
              setHistoryOpen((v) => !v);
            }}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Dolu işaretle" onClick={onRefill}>
            <RefreshCcw className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Düzenle" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive/70 hover:text-destructive"
            title="Sil"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Çekmece: grid satırını 0fr→1fr akıtmak, sabit bir max-height uydurmadan
            içeriğe göre yumuşak açılma verir. */}
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-out",
            historyOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="overflow-hidden">
            <div className="pt-3 border-t">{historyMounted && <UsageHistory spool={spool} />}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageHistory({ spool }: { spool: Spool }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["spool-usage", spool.id],
    queryFn: ({ pageParam }) =>
      fetchJson<UsagePage>(
        `/api/spools/${spool.id}/usage?limit=${USAGE_PAGE_SIZE}` +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "")
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 60_000,
  });

  const entries = useMemo(() => (data?.pages ?? []).flatMap((p) => p.items), [data]);
  const firstPage = data?.pages?.[0];
  const pace = firstPage?.pace ?? null;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full rounded-md" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <p className="text-[11px] text-muted-foreground">Geçmiş şu an açılamadı, birazdan tekrar dene.</p>;
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Henüz düşüm yok"
        description="Bu makaradan filament düştükçe burada tarih tarih listelenir."
        className="py-6"
      />
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Tüketim geçmişi</p>

      <RunOutEstimate remainingGrams={spool.remainingGrams} pace={pace} now={firstPage?.now ?? 0} />

      <ul className="space-y-2">
        {entries.map((entry, i) => (
          <li
            key={entry.id}
            className="relative pl-4 animate-in fade-in slide-in-from-left-1 duration-300"
            style={{ animationDelay: `${Math.min(i, 9) * 35}ms`, animationFillMode: "backwards" }}
            title={formatDateTime(entry.createdAt)}
          >
            <span
              className="absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full ring-2 ring-background"
              style={{ background: spool.colorHex }}
            />
            {i < entries.length - 1 && (
              <span className="absolute left-[2.5px] top-3.5 bottom-[-8px] w-px bg-border" />
            )}
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs truncate">{entry.productName ?? "Elle düşüldü"}</span>
              <span className="text-xs font-semibold tabular-nums shrink-0">
                -{formatNumber(entry.grams, 0)} g
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] text-muted-foreground truncate">{entry.note ?? ""}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatRelativeTime(entry.createdAt)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full gap-1 text-[11px]"
          disabled={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          {isFetchingNextPage ? (
            "Yükleniyor…"
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" /> Daha eskisini göster
            </>
          )}
        </Button>
      )}
    </div>
  );
}

/**
 * "Tahminen N gün sonra biter". Hız yoksa (yeterli geçmiş yok) HİÇBİR ŞEY gösterilmez —
 * iki baskılık veriden çıkan tahmin yanıltıcı olur.
 */
function RunOutEstimate({
  remainingGrams,
  pace,
  now,
}: {
  remainingGrams: number;
  pace: UsagePace | null;
  now: number;
}) {
  if (!pace || !(pace.gramsPerDay > 0) || remainingGrams <= 0 || !(now > 0)) return null;

  const days = remainingGrams / pace.gramsPerDay;
  const perDay = `günde ~${formatNumber(pace.gramsPerDay, pace.gramsPerDay < 10 ? 1 : 0)} g`;

  let headline: React.ReactNode;
  if (days > 180) {
    headline = <>Bu hızla 6 aydan uzun süre yeter</>;
  } else if (days < 1) {
    headline = <>Bu hızla bugün bitebilir</>;
  } else {
    headline = (
      <>
        Tahminen <AnimatedNumber value={days} format={(n) => formatNumber(n, 0)} className="font-semibold" /> gün
        sonra biter · {formatDate(now + days * DAY_MS)}
      </>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/60 px-2.5 py-2 animate-in fade-in duration-500">
      <Hourglass className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-[11px] font-medium leading-tight">{headline}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Son kullanıma göre {perDay}.</p>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={onClose} />
      <Card className="relative w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function SpoolModal({ spool, onClose }: { spool: Spool | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(spool?.name ?? "");
  const [material, setMaterial] = useState(spool?.material ?? "PLA");
  const [colorName, setColorName] = useState(spool?.colorName ?? "");
  const [colorHex, setColorHex] = useState(spool?.colorHex ?? "#e23b3b");
  const [brand, setBrand] = useState(spool?.brand ?? "");
  const [totalGrams, setTotalGrams] = useState(String(spool?.totalGrams ?? 1000));
  const [remainingGrams, setRemainingGrams] = useState(String(spool?.remainingGrams ?? spool?.totalGrams ?? 1000));
  const [reorderGrams, setReorderGrams] = useState(String(spool?.reorderGrams ?? 200));
  const [spoolCost, setSpoolCost] = useState(spool?.spoolCost != null ? String(spool.spoolCost) : "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        material,
        colorName: colorName || null,
        colorHex,
        brand: brand || null,
        totalGrams: Number(totalGrams) || 1000,
        remainingGrams: Number(remainingGrams) || 0,
        reorderGrams: Number(reorderGrams) || 0,
        spoolCost: spoolCost ? Number(spoolCost) : null,
      };
      return fetch(spool ? `/api/spools/${spool.id}` : "/api/spools", {
        method: spool ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => {
        if (!r.ok) throw new Error("Kaydedilemedi");
        return r.json();
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      toast.success(spool ? "Makara güncellendi" : "Makara eklendi");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal title={spool ? "Makarayı Düzenle" : "Yeni Makara"} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label className="text-xs">Ad</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="örn. eSun PLA+ Kırmızı" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Malzeme</Label>
            <select
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm"
            >
              {MATERIALS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Marka</Label>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="eSun, Bambu…" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Renk adı</Label>
            <Input value={colorName} onChange={(e) => setColorName(e.target.value)} placeholder="Kırmızı" />
          </div>
          <div>
            <Label className="text-xs">Renk</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={colorHex} onChange={(e) => setColorHex(e.target.value)} className="h-9 w-12 rounded-md border bg-background cursor-pointer" />
              <Input value={colorHex} onChange={(e) => setColorHex(e.target.value)} className="flex-1" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label className="text-xs">Toplam (g)</Label>
            <Input type="number" value={totalGrams} onChange={(e) => setTotalGrams(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Kalan (g)</Label>
            <Input type="number" value={remainingGrams} onChange={(e) => setRemainingGrams(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Uyarı eşiği (g)</Label>
            <Input type="number" value={reorderGrams} onChange={(e) => setReorderGrams(e.target.value)} />
          </div>
        </div>
        <div>
          <Label className="text-xs">Makara fiyatı (TL, opsiyonel)</Label>
          <Input type="number" value={spoolCost} onChange={(e) => setSpoolCost(e.target.value)} placeholder="örn. 550" />
        </div>
        <Button className="w-full" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
          {save.isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </div>
    </Modal>
  );
}

function ConsumeModal({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: products } = useQuery<ProductLite[]>({
    // Aktif ürünler (~442KB) — Ürünler/Üretim/Raporlar ile AYNI key → tek fetch, sayfalar arası paylaşılır.
    queryKey: ["products", "active"],
    queryFn: () => fetchJson("/api/products?filter=active"),
    staleTime: 60_000,
  });

  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [grams, setGrams] = useState("");
  const [note, setNote] = useState("");

  const productList = Array.isArray(products) ? products : [];

  function onPickProduct(id: string) {
    setProductId(id);
    const p = productList.find((x) => x.id === id);
    const w = p?.cost?.filamentWeight ?? 0;
    if (w > 0) setGrams(String(Math.round(w * (Number(qty) || 1))));
  }
  function onQty(v: string) {
    setQty(v);
    const p = productList.find((x) => x.id === productId);
    const w = p?.cost?.filamentWeight ?? 0;
    if (w > 0) setGrams(String(Math.round(w * (Number(v) || 1))));
  }

  const consume = useMutation({
    mutationFn: () => {
      const p = productList.find((x) => x.id === productId);
      return fetch(`/api/spools/${spool.id}/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grams: Number(grams) || 0,
          productId: productId || null,
          productName: p?.name ?? null,
          note: note || null,
        }),
      }).then((r) => {
        if (!r.ok) throw new Error("Düşülemedi");
        return r.json();
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      // Yeni düşüm kaydı geçmişte ve "ne zaman biter" tahmininde anında görünsün.
      qc.invalidateQueries({ queryKey: ["spool-usage", spool.id] });
      toast.success(`${grams} g düşüldü — ${spool.name}`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal title={`Filament Düş — ${spool.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Kalan: <span className="font-medium text-foreground">{formatNumber(spool.remainingGrams, 0)} g</span>. Ürün
          seçersen gramaj maliyet bilgisinden otomatik gelir.
        </p>
        <div>
          <Label className="text-xs">Ürün (opsiyonel)</Label>
          <select
            value={productId}
            onChange={(e) => onPickProduct(e.target.value)}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Seçilmedi (manuel gram gir)</option>
            {productList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.cost?.filamentWeight ? ` (${Math.round(p.cost.filamentWeight)}g)` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Adet</Label>
            <Input type="number" min="1" value={qty} onChange={(e) => onQty(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Düşülecek gram</Label>
            <Input type="number" min="0" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder="örn. 45" />
          </div>
        </div>
        <div>
          <Label className="text-xs">Not (opsiyonel)</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="örn. sipariş #1234" />
        </div>
        <Button
          className="w-full"
          disabled={consume.isPending || !(Number(grams) > 0)}
          onClick={() => consume.mutate()}
        >
          {consume.isPending ? "Düşülüyor…" : `${Number(grams) || 0} g Düş`}
        </Button>
      </div>
    </Modal>
  );
}
