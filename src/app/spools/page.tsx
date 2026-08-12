"use client";

import { fetchJson } from "@/lib/fetch-json";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Disc3, Plus, AlertTriangle, Trash2, Pencil, ArrowDownToLine,
  X, PackageOpen, Copy, Search, BellOff, Bell, Check, Minus,
  History, ChevronDown, Hourglass, Coins, ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { SpoolDisk, SpoolPips, ColorDot } from "@/components/spools/spool-visuals";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  FILAMENT_BRANDS, FILAMENT_COLORS, DEFAULT_LOW_SPOOL_COUNT,
  groupSpools, buildFilamentAlerts, isSealed, isEmptySpool, parseThreshold,
  type FilamentGroup, type SpoolLike,
} from "@/core/filament-groups";

/**
 * FİLAMENT — KAPALI MAKARA ENVANTERİ.
 *
 * Sayfanın birimi tek tek makara DEĞİL, GRUP: tür ailesi + renk tonu (marka gruba girmez).
 * Ana soru: "hangi renkten kaç kapalı makaram var" ve "neyim bitiyor". Gram bilgisi duruyor ama
 * ikincil: kartta toplam kilo, detayda tek tek kalan gram. Ekleme formunda gram HİÇ sorulmuyor.
 *
 * Tek tek makaranın tüketim geçmişi ve "ne zaman biter" tahmini grup detayında, makara satırının
 * altındaki çekmecede duruyor — envanterin ana ekranını kalabalıklaştırmadan erişilebilir kalsın.
 */

/** Alış bedelinden çıkan gerçek gram maliyeti ile maliyet tablosundaki değerin farkı. */
interface CostGap {
  actualPerGram: number;
  tablePerGram: number;
}

interface Spool extends SpoolLike {
  id: string;
  name: string;
  spoolCost: number | null;
  vendorUrl: string | null;
  /** Makaranın gerçek gram maliyeti ile maliyet ayarlarındaki değer belirgin ayrıştıysa dolu gelir. */
  costGap?: CostGap | null;
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

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "Reçine"];
const WEIGHTS = [1000, 750, 500, 2000, 5000];
const KEY_THRESHOLD = "filamentLowSpoolCount";

const USAGE_PAGE_SIZE = 15;
const DAY_MS = 86_400_000;

/** Renk ailesi başlıkları — tonlar ayrı kart, ama aile altında toplanır (kullanıcı kararı). */
const FAMILY_LABELS: Record<string, string> = {
  siyah: "Siyah", beyaz: "Beyaz", gri: "Gri", kirmizi: "Kırmızı", turuncu: "Turuncu",
  sari: "Sarı", yesil: "Yeşil", mavi: "Mavi", mor: "Mor", pembe: "Pembe",
  kahverengi: "Kahverengi", seffaf: "Şeffaf", diger: "Diğer",
};

/** Grup satırları `SpoolLike` taşır; fiyat farkı yalnız listeden gelen kayıtlarda dolu olur. */
function costGapOf(spool: SpoolLike): CostGap | null {
  return (spool as Spool).costGap ?? null;
}

/**
 * Son makarası silinen grubun BOŞ hâli.
 *
 * NEDEN gerekli: gruplar canlı makara satırlarından türetilir, yani son satır gidince grup da
 * listeden düşer. Detay penceresi o an açık olan grubu bulamayınca eski anlık görüntüye dönerse
 * SİLİNEN SATIRLAR GERİ GELİR — kullanıcıya "silme çalışmadı" gibi görünür. Bunun yerine grubun
 * kimliği (ad/renk) korunur, sayılar sıfırlanır.
 */
function emptiedGroup(group: FilamentGroup): FilamentGroup {
  return {
    ...group,
    sealedCount: 0, openCount: 0, emptyCount: 0, activeCount: 0,
    remainingGrams: 0, totalGrams: 0,
    spools: [],
  };
}

export default function SpoolsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<Spool[]>({
    queryKey: ["spools"],
    queryFn: () => fetchJson("/api/spools"),
    staleTime: 10 * 60_000,
  });
  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => fetchJson("/api/settings"),
    staleTime: 5 * 60_000,
  });

  const spools = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const groups = useMemo(() => groupSpools(spools), [spools]);

  const threshold = parseThreshold(settings?.[KEY_THRESHOLD], DEFAULT_LOW_SPOOL_COUNT);
  const groupThresholds = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(settings ?? {})) {
      if (k.startsWith("filamentThreshold:")) {
        const n = Number(v);
        if (isFinite(n) && n >= 0) out[k.slice("filamentThreshold:".length)] = n;
      }
    }
    return out;
  }, [settings]);
  const mutedGroups = useMemo(
    () =>
      Object.entries(settings ?? {})
        .filter(([k, v]) => k.startsWith("filamentMute:") && v !== "0")
        .map(([k]) => k.slice("filamentMute:".length)),
    [settings]
  );

  /**
   * İZLENEN GRUPLAR — son makarası biten renkler.
   *
   * Bu liste geçilmezse sayfa ile zil AYNI gerçeği farklı söyler: zil (/api/notifications)
   * ayarların tamamını geçtiği için "Siyah PLA bitti" der, sayfada ise o rengin kartı hiç
   * kalmadığı için ne uyarı ne rozet görünür — kullanıcı alışverişe zilde yazan rengi
   * listesinde bulamadan gider.
   */
  const watchedGroups = useMemo(
    () =>
      Object.entries(settings ?? {})
        .filter(([k]) => k.startsWith("filamentWatch:"))
        .map(([k, v]) => ({
          key: k.slice("filamentWatch:".length),
          label: (v ?? "").trim() || undefined,
        })),
    [settings]
  );

  const alerts = useMemo(
    () =>
      buildFilamentAlerts(groups, { threshold, groupThresholds, mutedGroups, watchedGroups }),
    [groups, threshold, groupThresholds, mutedGroups, watchedGroups]
  );
  const alertKeys = useMemo(() => new Set(alerts.map((a) => a.groupKey)), [alerts]);

  const [query, setQuery] = useState("");
  const [materialFilter, setMaterialFilter] = useState<string>("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [adding, setAdding] = useState<Partial<AddPrefill> | null>(null);
  const [detail, setDetail] = useState<FilamentGroup | null>(null);
  const [editing, setEditing] = useState<Spool | null>(null);
  const [consuming, setConsuming] = useState<Spool | null>(null);
  const [deleting, setDeleting] = useState<SpoolLike | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    return groups.filter((g) => {
      if (materialFilter && g.material !== materialFilter) return false;
      if (onlyLow && !alertKeys.has(g.key)) return false;
      if (!q) return true;
      const hay = `${g.colorName} ${g.material} ${g.brands.join(" ")} ${g.spools.map((s) => s.name ?? "").join(" ")}`;
      return hay.toLocaleLowerCase("tr").includes(q);
    });
  }, [groups, query, materialFilter, onlyLow, alertKeys]);

  /** Aileye göre bölümlere ayır: "kaç yeşilim var" tek bakışta, tonlar ayrı kart. */
  const sections = useMemo(() => {
    const byFamily = new Map<string, FilamentGroup[]>();
    for (const g of visible) {
      const list = byFamily.get(g.colorFamily) ?? [];
      list.push(g);
      byFamily.set(g.colorFamily, list);
    }
    return Array.from(byFamily.entries())
      .map(([family, items]) => ({
        family,
        label: FAMILY_LABELS[family] ?? family,
        items,
        sealed: items.reduce((n, g) => n + g.sealedCount, 0),
        alerted: items.some((g) => alertKeys.has(g.key)),
      }))
      // ÖNCE dikkat isteyen aileler: "neyim bitiyor" ekranın üstünde olmalı, alfabe sonra gelir.
      .sort((a, b) => Number(b.alerted) - Number(a.alerted) || a.label.localeCompare(b.label, "tr"));
  }, [visible, alertKeys]);

  const totals = useMemo(() => {
    const sealed = groups.reduce((n, g) => n + g.sealedCount, 0);
    const open = groups.reduce((n, g) => n + g.openCount, 0);
    const kg = groups.reduce((n, g) => n + g.remainingGrams, 0) / 1000;
    return { sealed, open, kg, groupCount: groups.length };
  }, [groups]);

  const materialCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.material, (m.get(g.material) ?? 0) + g.sealedCount);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [groups]);

  const saveSetting = useMutation({
    mutationFn: (body: Record<string, string>) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const openSpool = useMutation({
    mutationFn: (s: Spool) =>
      fetch(`/api/spools/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openedAt: new Date().toISOString() }),
      }).then((r) => r.json()),
    onSuccess: (_d, s) => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      toast.success("Makara açık işaretlendi", {
        action: {
          label: "Geri al",
          onClick: () => {
            fetch(`/api/spools/${s.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ openedAt: null }),
            }).then(() => qc.invalidateQueries({ queryKey: ["spools"] }));
          },
        },
      });
    },
  });

  /**
   * Makara silme — onay penceresinden sonra çalışır.
   *
   * İYİMSER: satır sunucu yanıtını beklemeden listeden düşer. Uzak veritabanında her sorgu
   * sıraya girdiği için bekleme saniyeleri bulabiliyor; o süre boyunca ekranın hiç kıpırdamaması
   * "silme çalışmıyor" izlenimi veriyordu. Hata olursa liste eski hâline döner ve kısa bir
   * uyarı çıkar — sessizce yutulmaz.
   */
  const deleteSpool = useMutation<{ ok: boolean }, Error, string, { prev: Spool[] | undefined }>({
    mutationFn: (id) => fetchJson<{ ok: boolean }>(`/api/spools/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["spools"] });
      const prev = qc.getQueryData<Spool[]>(["spools"]);
      qc.setQueryData<Spool[]>(["spools"], (old) =>
        Array.isArray(old) ? old.filter((s) => s.id !== id) : old
      );
      return { prev };
    },
    onError: (_error, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["spools"], ctx.prev);
      toast.error("Makara silinemedi");
    },
    onSuccess: (_data, id) => {
      // Silinen makaranın tüketim geçmişi bellekte asılı kalmasın.
      qc.removeQueries({ queryKey: ["spool-usage", id] });
      toast.success("Makara silindi");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["spools"] }),
  });

  /** Açık detay penceresi HER ZAMAN canlı veriden beslenir (bkz. `emptiedGroup`). */
  const detailGroup = useMemo(() => {
    if (!detail) return null;
    return groups.find((g) => g.key === detail.key) ?? emptiedGroup(detail);
  }, [groups, detail]);

  function copyShoppingList() {
    const text = alerts
      .map((a) => {
        const g = groups.find((x) => x.key === a.groupKey);
        const need = Math.max(1, threshold - (g?.sealedCount ?? 0) + 1);
        const label = g?.label ?? a.body.split(" — ")[0];
        return `${label} ×${need}`;
      })
      .join(", ");
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      toast.error("Kopyalanamadı");
      return;
    }
    clipboard.writeText(text).then(
      () => toast.success("Eksik listesi kopyalandı"),
      () => toast.error("Kopyalanamadı")
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* Başlık */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="animate-in fade-in slide-in-from-bottom-1 duration-300">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Disc3 className="h-6 w-6 text-primary" /> Filament
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Kapalı makara envanteri — hangi renkten kaç makaran kaldı.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThresholdControl
            value={threshold}
            onChange={(v) => saveSetting.mutate({ [KEY_THRESHOLD]: String(v) })}
          />
          <Button size="sm" className="gap-2" onClick={() => setAdding({})}>
            <Plus className="h-4 w-4" /> Makara Ekle
          </Button>
        </div>
      </div>

      {/* Özet şeridi — sayılar yüklenmeden 0 gösterilmez, iskelet beklenir. */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Kapalı makara" value={totals.sealed} index={0} accent />
          <StatCard label="Açık makara" value={totals.open} index={1} />
          <StatCard label="Renk grubu" value={totals.groupCount} index={2} />
          <StatCard
            label="Toplam"
            value={totals.kg}
            index={3}
            suffix=" kg"
            muted
            format={(n) => formatNumber(n, 1)}
          />
        </div>
      )}

      {/* Uyarı bandı */}
      {alerts.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 animate-in fade-in slide-in-from-top-1 duration-300">
          <CardContent className="py-3 flex items-start gap-3 flex-wrap">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-1 shrink-0" />
            <div className="flex-1 min-w-[200px]">
              <p className="text-sm font-medium text-amber-400">
                <AnimatedNumber value={alerts.length} format={(n) => formatNumber(n, 0)} /> grup dikkat istiyor
              </p>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {alerts.map((a, i) => {
                  const g = groups.find((x) => x.key === a.groupKey);
                  return (
                    <button
                      key={a.id}
                      onClick={() => g && setDetail(g)}
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full border transition-all active:scale-95",
                        "animate-in fade-in zoom-in-95 fill-mode-both duration-300",
                        a.severity === "critical"
                          ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                      )}
                      style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                    >
                      {a.body}
                    </button>
                  );
                })}
              </div>
            </div>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={copyShoppingList}>
              <Copy className="h-3.5 w-3.5" /> Eksik listesini kopyala
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Filtreler */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Renk, tür, marka ara…"
            className="pl-8"
          />
        </div>
        {isLoading ? (
          <div className="flex items-center gap-1.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-16 rounded-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterChip active={!materialFilter} onClick={() => setMaterialFilter("")}>
                Hepsi {formatNumber(totals.sealed, 0)}
              </FilterChip>
              {materialCounts.map(([m, n]) => (
                <FilterChip key={m} active={materialFilter === m} onClick={() => setMaterialFilter(m)}>
                  {m} {formatNumber(n, 0)}
                </FilterChip>
              ))}
            </div>
            <FilterChip active={onlyLow} onClick={() => setOnlyLow((v) => !v)}>
              Sadece azalanlar
            </FilterChip>
          </>
        )}
      </div>

      {/* İçerik */}
      {isLoading ? (
        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, s) => (
            <div key={s} className="space-y-2">
              <Skeleton className="h-4 w-40 rounded" />
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-[132px] rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="Henüz makara yok"
          description="Elindeki kapalı filament makaralarını ekle; hangi renkten kaç tane olduğunu ve azalanları burada görürsün."
          action={<Button onClick={() => setAdding({})} className="gap-2"><Plus className="h-4 w-4" /> İlk makarayı ekle</Button>}
        />
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center animate-in fade-in duration-300">
          Filtreye uyan grup yok.
        </p>
      ) : (
        <div className="space-y-6">
          {sections.map((sec, sectionIndex) => (
            <div
              key={sec.family}
              className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
              style={{ animationDelay: `${Math.min(sectionIndex, 8) * 60}ms` }}
            >
              <div className="flex items-baseline gap-2 mb-2">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {sec.label}
                </h2>
                <span className="text-xs text-muted-foreground">
                  toplam {formatNumber(sec.sealed, 0)} kapalı makara
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {sec.items.map((g, i) => (
                  <GroupCard
                    key={g.key}
                    group={g}
                    index={sectionIndex * 2 + i}
                    threshold={groupThresholds[g.key] ?? threshold}
                    muted={mutedGroups.includes(g.key)}
                    alerted={alertKeys.has(g.key)}
                    onOpenDetail={() => setDetail(g)}
                    onAdd={() =>
                      setAdding({
                        material: g.material,
                        colorName: g.colorName,
                        colorHex: g.colorHex,
                        colorKey: g.colorKey,
                        brand: g.brands[0] ?? "",
                      })
                    }
                    onOpenSpool={(s) => openSpool.mutate(s as Spool)}
                    onToggleMute={() =>
                      saveSetting.mutate({
                        [`filamentMute:${g.key}`]: mutedGroups.includes(g.key) ? "0" : "1",
                      })
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && detailGroup && (
        <GroupDetailDialog
          group={detailGroup}
          threshold={groupThresholds[detail.key] ?? threshold}
          generalThreshold={threshold}
          onSetThreshold={(v) =>
            saveSetting.mutate({ [`filamentThreshold:${detail.key}`]: v === null ? "" : String(v) })
          }
          onClose={() => setDetail(null)}
          onEdit={(s) => setEditing(s as Spool)}
          onConsume={(s) => setConsuming(s as Spool)}
          onDelete={(s) => setDeleting(s)}
          onAdd={() =>
            setAdding({
              material: detailGroup.material,
              colorName: detailGroup.colorName,
              colorHex: detailGroup.colorHex,
              colorKey: detailGroup.colorKey,
              brand: detailGroup.brands[0] ?? "",
            })
          }
        />
      )}
      {/* Pencereler PORTAL kullanmıyor ve hepsi aynı z-50 katmanında; hangisinin üstte kaldığını
          YALNIZCA çizim sırası belirler. Bu yüzden detay penceresinden açılabilen her pencere
          (ekle / düzenle / düş / sil) ondan SONRA gelmek zorunda — aksi halde detayın arkasında
          açılır, kullanıcı ekranın karardığını görür ve düğme bozuk sanır. */}
      {adding && <AddSpoolDialog prefill={adding} onClose={() => setAdding(null)} />}
      {editing && <EditSpoolDialog spool={editing} onClose={() => setEditing(null)} />}
      {consuming && <ConsumeDialog spool={consuming} onClose={() => setConsuming(null)} />}
      {deleting && (
        <DeleteSpoolDialog
          spool={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            deleteSpool.mutate(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── küçük parçalar ─────────────────────────── */

function StatCard({
  label, value, suffix = "", accent, muted, format, index = 0,
}: {
  label: string; value: number; suffix?: string; accent?: boolean; muted?: boolean;
  format?: (n: number) => string; index?: number;
}) {
  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300",
        muted && "opacity-70"
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <CardContent className="py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("text-2xl font-bold tabular-nums mt-0.5", accent && "text-primary")}>
          <AnimatedNumber value={value} format={format ?? ((n) => formatNumber(n, 0))} />
          {suffix}
        </p>
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active, onClick, children,
}: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-xs px-2.5 py-1 rounded-full border transition-all active:scale-95",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background hover:bg-muted border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function ThresholdControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen((v) => !v)}>
        <Bell className="h-3.5 w-3.5" /> Uyarı eşiği: {value}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <Card className="absolute right-0 top-10 z-50 w-64 shadow-lg animate-in fade-in zoom-in-95 duration-200">
            <CardContent className="p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                Bir renkte bu sayıda veya daha az <b>kapalı</b> makara kalınca uyarılırsın.
              </p>
              <div className="flex items-center gap-2">
                <Button size="icon" variant="outline" className="h-8 w-8"
                  onClick={() => onChange(Math.max(0, value - 1))}>
                  <Minus className="h-3.5 w-3.5" />
                </Button>
                <span className="flex-1 text-center text-lg font-bold tabular-nums">
                  <AnimatedNumber value={value} format={(n) => formatNumber(n, 0)} durationMs={280} />
                </span>
                <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => onChange(value + 1)}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Tek tek renkler için farklı eşik: o rengin kartını aç → “Bu renk için eşik”.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function statusBadge(g: FilamentGroup, threshold: number) {
  if (g.sealedCount === 0 && g.openCount === 0)
    return { label: "Bitti", cls: "bg-destructive/15 text-destructive border-destructive/30" };
  if (g.sealedCount === 0)
    return { label: "Son makara açık", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  if (g.sealedCount <= threshold)
    return { label: "Azaldı", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  return { label: "Yeterli", cls: "bg-green-500/15 text-green-400 border-green-500/30" };
}

function GroupCard({
  group: g, index, threshold, muted, alerted, onOpenDetail, onAdd, onOpenSpool, onToggleMute,
}: {
  group: FilamentGroup; index: number; threshold: number; muted: boolean; alerted: boolean;
  onOpenDetail: () => void; onAdd: () => void; onOpenSpool: (s: SpoolLike) => void; onToggleMute: () => void;
}) {
  const badge = statusBadge(g, threshold);
  const sealedSpools = g.spools.filter((s) => isSealed(s));
  const hasCostGap = g.spools.some((s) => costGapOf(s) !== null);

  return (
    <Card
      className={cn(
        "transition-all duration-200 hover:shadow-md hover:-translate-y-0.5",
        "animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300",
        alerted && !muted && "border-amber-500/40",
        muted && "opacity-60"
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <button onClick={onOpenDetail} className="shrink-0 transition-transform hover:scale-105 active:scale-95" title="Detayları aç">
            <SpoolDisk colorHex={g.colorHex} count={g.sealedCount} />
          </button>
          <div className="min-w-0 flex-1">
            <button onClick={onOpenDetail} className="text-left w-full group/title">
              <p className="font-semibold leading-tight truncate transition-colors group-hover/title:text-primary">
                {g.label}
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {g.brands.length ? g.brands.join(" · ") : "marka girilmemiş"}
              </p>
            </button>
            <div className="mt-2">
              <SpoolPips sealed={g.sealedCount} open={g.openCount} empty={g.emptyCount} colorHex={g.colorHex} />
            </div>
          </div>
          <span className={cn("text-[11px] px-1.5 py-0.5 rounded border shrink-0", badge.cls)}>
            {badge.label}
          </span>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            <b className="text-foreground tabular-nums">
              <AnimatedNumber value={g.sealedCount} format={(n) => formatNumber(n, 0)} /> kapalı
            </b>
            {g.openCount > 0 && ` · ${formatNumber(g.openCount, 0)} açık`}
            {g.emptyCount > 0 && ` · ${formatNumber(g.emptyCount, 0)} bitti`}
          </span>
          <span className="opacity-70 tabular-nums">
            ~<AnimatedNumber value={g.remainingGrams / 1000} format={(n) => formatNumber(n, 1)} /> kg
          </span>
        </div>

        {hasCostGap && (
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground animate-in fade-in duration-500">
            <Coins className="h-3.5 w-3.5 shrink-0 mt-px text-amber-400" />
            <span>
              Makara fiyatı maliyet tablosundan farklı.{" "}
              <Link
                href="/cost-templates"
                className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
              >
                Maliyet ayarları <ArrowRight className="h-3 w-3" />
              </Link>
            </span>
          </p>
        )}

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="flex-1 gap-1.5 h-8" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" /> Makara
          </Button>
          <Button
            size="sm" variant="outline" className="flex-1 gap-1.5 h-8"
            disabled={sealedSpools.length === 0}
            onClick={() => sealedSpools[0] && onOpenSpool(sealedSpools[0])}
            title={sealedSpools.length ? "Bir kapalı makarayı aç" : "Açılacak kapalı makara yok"}
          >
            <PackageOpen className="h-3.5 w-3.5" /> Aç
          </Button>
          <Button
            size="icon" variant="ghost" className="h-8 w-8 shrink-0"
            onClick={onToggleMute}
            title={muted ? "Uyarıları aç" : "Bu grubu sustur"}
          >
            {muted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── tüketim geçmişi ─────────────────────────── */

function UsageHistory({
  spoolId, remainingGrams, colorHex,
}: { spoolId: string; remainingGrams: number; colorHex: string }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["spool-usage", spoolId],
    queryFn: ({ pageParam }) =>
      fetchJson<UsagePage>(
        `/api/spools/${spoolId}/usage?limit=${USAGE_PAGE_SIZE}` +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "")
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 60_000,
  });

  const entries = useMemo(() => (data?.pages ?? []).flatMap((p) => p.items), [data]);
  const firstPage = data?.pages?.[0];
  const pace = firstPage?.pace ?? null;
  const now = firstPage?.now ?? 0;

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

      <RunOutEstimate remainingGrams={remainingGrams} pace={pace} now={now} />

      <ul className="space-y-2">
        {entries.map((entry, i) => (
          <li
            key={entry.id}
            className="relative pl-4 animate-in fade-in slide-in-from-left-1 fill-mode-both duration-300"
            style={{ animationDelay: `${Math.min(i, 9) * 35}ms` }}
            title={formatDateTime(entry.createdAt)}
          >
            <span
              className="absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full ring-2 ring-background"
              style={{ background: colorHex }}
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
                {formatRelativeTime(entry.createdAt, now > 0 ? now : undefined)}
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

/* ─────────────────────────── diyaloglar ─────────────────────────── */

function Modal({
  title, onClose, children, wide,
}: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={onClose} />
      <Card className={cn("relative w-full animate-in fade-in zoom-in-95 duration-200", wide ? "max-w-2xl" : "max-w-md")}>
        <CardContent className="p-5 space-y-4 max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:bg-muted transition-colors active:scale-95">
              <X className="h-4 w-4" />
            </button>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

interface AddPrefill {
  material: string;
  colorName: string;
  colorHex: string;
  colorKey: string;
  brand: string;
}

/**
 * EKLEME — alan sırası kasıtlı: önce GRUPLAYAN alanlar (tür, renk), sonra detay (marka, seri).
 * Kalan gram ve uyarı eşiği burada YOK. "Kaydet ve yenisini ekle" marka+ağırlığı koruyarak
 * alışveriş dönüşü hızlı girişi mümkün kılar.
 */
function AddSpoolDialog({ prefill, onClose }: { prefill: Partial<AddPrefill>; onClose: () => void }) {
  const qc = useQueryClient();
  const [material, setMaterial] = useState(prefill.material ?? "PLA");
  const [colorKey, setColorKey] = useState(prefill.colorKey ?? "");
  const [colorName, setColorName] = useState(prefill.colorName ?? "");
  const [colorHex, setColorHex] = useState(prefill.colorHex ?? "#9ca3af");
  const [brand, setBrand] = useState(prefill.brand ?? "");
  const [customBrand, setCustomBrand] = useState("");
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const [totalGrams, setTotalGrams] = useState(1000);
  const [customWeight, setCustomWeight] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [spoolCost, setSpoolCost] = useState("");
  const [vendorUrl, setVendorUrl] = useState("");
  const [sessionCount, setSessionCount] = useState(0);

  // "Kaydet ve yenisini ekle" bayrağı: kaydetme sonrası formun kapanıp kapanmayacağını
  // TEK yerden belirler (iki ayrı başarı işleyicisi çift bildirim üretiyordu).
  const keepOpenRef = useRef(false);

  const effectiveBrand = brand === "__other__" ? customBrand.trim() : brand;
  const weight = customWeight ? Number(customWeight) || 0 : totalGrams;
  const canSave = Boolean(colorName || colorKey) && weight > 0;

  const save = useMutation({
    mutationFn: () =>
      fetch("/api/spools/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: qty,
          material,
          colorKey: colorKey || undefined,
          colorName: colorName || undefined,
          colorHex,
          brand: effectiveBrand || undefined,
          name: name.trim() || undefined,
          totalGrams: weight,
          spoolCost: spoolCost ? Number(spoolCost) : undefined,
          vendorUrl: vendorUrl.trim() || undefined,
        }),
      }).then((r) => {
        if (!r.ok) throw new Error("Kaydedilemedi");
        return r.json();
      }),
    onSuccess: (res: { count: number }) => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      toast.success(`${formatNumber(res.count, 0)} makara eklendi`);
      if (keepOpenRef.current) {
        keepOpenRef.current = false;
        setSessionCount((n) => n + res.count);
        // Marka + ağırlık KORUNUR (aynı markadan farklı renkler girmek hızlansın).
        setColorKey(""); setColorName(""); setColorHex("#9ca3af"); setName(""); setQty(1);
        return;
      }
      onClose();
    },
    onError: (e: Error) => {
      keepOpenRef.current = false;
      toast.error(e.message);
    },
  });

  function saveAndNew() {
    keepOpenRef.current = true;
    save.mutate();
  }

  const preview = `${qty} × ${colorName || "renk seç"} ${material}${effectiveBrand ? ` — ${effectiveBrand}` : ""}${name ? ` ${name}` : ""} (${formatNumber(weight / 1000, weight % 1000 === 0 ? 0 : 2)} kg)`;

  return (
    <Modal title="Makara Ekle" onClose={onClose} wide>
      <div className="space-y-4">
        {sessionCount > 0 && (
          <p className="text-xs text-green-400 flex items-center gap-1 animate-in fade-in slide-in-from-top-1 duration-300">
            <Check className="h-3.5 w-3.5" /> Bu oturumda eklenen:{" "}
            <AnimatedNumber value={sessionCount} format={(n) => formatNumber(n, 0)} className="font-semibold" />
          </p>
        )}

        <div>
          <Label className="text-xs mb-1.5 block">Tür</Label>
          <div className="flex flex-wrap gap-1.5">
            {MATERIALS.map((m) => (
              <FilterChip key={m} active={material === m} onClick={() => setMaterial(m)}>{m}</FilterChip>
            ))}
          </div>
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">
            Renk <span className="text-muted-foreground font-normal">— tek tık, ad ve renk birlikte gelir</span>
          </Label>
          <div className="grid grid-cols-6 sm:grid-cols-8 gap-1.5">
            {FILAMENT_COLORS.map((c, i) => (
              <button
                key={c.key}
                onClick={() => { setColorKey(c.key); setColorName(c.name); setColorHex(c.hex); }}
                className={cn(
                  "flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-all active:scale-95",
                  "animate-in fade-in zoom-in-95 fill-mode-both duration-200",
                  colorKey === c.key ? "border-primary bg-primary/10 scale-[1.03]" : "border-transparent hover:bg-muted"
                )}
                style={{ animationDelay: `${Math.min(i, 16) * 15}ms` }}
                title={c.name}
              >
                <ColorDot hex={c.hex} size={22} />
                <span className="text-[9px] leading-none text-muted-foreground truncate w-full text-center">
                  {c.name}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input
              type="color" value={colorHex}
              onChange={(e) => { setColorHex(e.target.value); setColorKey(""); }}
              className="h-8 w-10 rounded-md border bg-background cursor-pointer"
              title="Özel renk"
            />
            <Input
              value={colorName}
              onChange={(e) => { setColorName(e.target.value); setColorKey(""); }}
              placeholder="Özel renk adı (örn. Fıstık Yeşili)"
              className="h-8 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs mb-1.5 block">Marka</Label>
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted/40"
            >
              <option value="">Seçilmedi</option>
              {FILAMENT_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
              <option value="__other__">Diğer…</option>
            </select>
            {brand === "__other__" && (
              <Input
                value={customBrand} onChange={(e) => setCustomBrand(e.target.value)}
                placeholder="Marka adı" className="mt-1.5 h-9 animate-in fade-in slide-in-from-top-1 duration-200"
              />
            )}
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">
              Ürün adı / seri <span className="text-muted-foreground font-normal">(opsiyonel)</span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="XPLA, Silk, Matte…" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs mb-1.5 block">Adet</Label>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => setQty((n) => Math.max(1, n - 1))}>
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <span className="flex-1 text-center text-lg font-bold tabular-nums">
                <AnimatedNumber value={qty} format={(n) => formatNumber(n, 0)} durationMs={280} />
              </span>
              <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => setQty((n) => Math.min(20, n + 1))}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Makara ağırlığı</Label>
            <div className="flex flex-wrap gap-1.5">
              {WEIGHTS.map((w) => (
                <FilterChip
                  key={w}
                  active={!customWeight && totalGrams === w}
                  onClick={() => { setTotalGrams(w); setCustomWeight(""); }}
                >
                  {w >= 1000 ? `${formatNumber(w / 1000, w % 1000 === 0 ? 0 : 1)} kg` : `${formatNumber(w, 0)} g`}
                </FilterChip>
              ))}
              <Input
                value={customWeight} onChange={(e) => setCustomWeight(e.target.value)}
                placeholder="özel g" className="h-7 w-20 text-xs"
              />
            </div>
          </div>
        </div>

        <button
          onClick={() => setAdvanced((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {advanced ? "▾" : "▸"} Gelişmiş
        </button>
        {advanced && (
          <div className="grid grid-cols-2 gap-3 animate-in fade-in slide-in-from-top-1 duration-200">
            <div>
              <Label className="text-xs">Makara fiyatı (₺)</Label>
              <Input type="number" value={spoolCost} onChange={(e) => setSpoolCost(e.target.value)} placeholder="550" />
            </div>
            <div>
              <Label className="text-xs">Satıcı linki</Label>
              <Input value={vendorUrl} onChange={(e) => setVendorUrl(e.target.value)} placeholder="https://…" />
            </div>
          </div>
        )}

        <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs transition-colors">
          <span className="text-muted-foreground">Eklenecek: </span>
          <span className="font-medium">{preview}</span>
        </div>

        <div className="flex gap-2">
          <Button className="flex-1" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Kaydediliyor…" : `${formatNumber(qty, 0)} Makara Ekle`}
          </Button>
          <Button variant="outline" disabled={!canSave || save.isPending} onClick={saveAndNew}>
            Kaydet ve yenisini ekle
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function GroupDetailDialog({
  group: g, threshold, generalThreshold, onSetThreshold, onClose, onEdit, onConsume, onDelete, onAdd,
}: {
  group: FilamentGroup; threshold: number; generalThreshold: number;
  onSetThreshold: (v: number | null) => void;
  onClose: () => void; onEdit: (s: SpoolLike) => void; onConsume: (s: SpoolLike) => void;
  onDelete: (s: SpoolLike) => void; onAdd: () => void;
}) {
  const qc = useQueryClient();
  const toggleOpen = useMutation({
    mutationFn: ({ id, sealed }: { id: string; sealed: boolean }) =>
      fetch(`/api/spools/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sealed ? { openedAt: new Date().toISOString() } : { openedAt: null }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spools"] }),
  });

  const custom = threshold !== generalThreshold;

  return (
    <Modal title={g.label} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <SpoolDisk colorHex={g.colorHex} count={g.sealedCount} size={48} />
          <div className="text-sm">
            <p className="tabular-nums">
              <b>
                <AnimatedNumber value={g.sealedCount} format={(n) => formatNumber(n, 0)} />
              </b>{" "}
              kapalı · {formatNumber(g.openCount, 0)} açık · {formatNumber(g.emptyCount, 0)} bitti
            </p>
            <p className="text-xs text-muted-foreground">
              {g.brands.join(" · ") || "marka girilmemiş"} · ~{formatNumber(g.remainingGrams / 1000, 1)} kg
            </p>
          </div>
        </div>

        <div className="rounded-lg border p-3 flex items-center justify-between gap-3">
          <div className="text-xs">
            <p className="font-medium">Bu renk için eşik</p>
            <p className="text-muted-foreground">
              {custom ? `Özel: ${formatNumber(threshold, 0)} makara` : `Genel eşik kullanılıyor (${formatNumber(generalThreshold, 0)})`}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="icon" variant="outline" className="h-7 w-7"
              onClick={() => onSetThreshold(Math.max(0, threshold - 1))}>
              <Minus className="h-3 w-3" />
            </Button>
            <span className="w-6 text-center text-sm font-bold tabular-nums">
              <AnimatedNumber value={threshold} format={(n) => formatNumber(n, 0)} durationMs={280} />
            </span>
            <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => onSetThreshold(threshold + 1)}>
              <Plus className="h-3 w-3" />
            </Button>
            {custom && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onSetThreshold(null)}>
                Sıfırla
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          {g.spools.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="Bu renkten makara kalmadı"
              description="Yenisini aldığında buraya ekle; azalınca yine uyarılırsın."
              className="py-6"
              action={
                <Button size="sm" className="gap-2" onClick={onAdd}>
                  <Plus className="h-4 w-4" /> Makara ekle
                </Button>
              }
            />
          ) : (
            g.spools.map((s, i) => (
              <SpoolRow
                key={s.id}
                spool={s}
                index={i}
                groupColorHex={g.colorHex}
                groupLabel={g.label}
                onEdit={() => onEdit(s)}
                onConsume={() => onConsume(s)}
                onToggleOpen={(sealed) => toggleOpen.mutate({ id: s.id, sealed })}
                onDelete={() => onDelete(s)}
              />
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Silme onayı — uygulamanın kendi penceresi.
 *
 * Tarayıcının yerel `confirm()` kutusu kullanılmıyordu: tüm pencereyi kilitliyor, uygulamanın
 * diline/görünümüne uymuyor ve masaüstü kabuğunda arkada kalabiliyor. Onay artık ekranın içinde.
 */
function DeleteSpoolDialog({
  spool: s, onClose, onConfirm,
}: { spool: SpoolLike; onClose: () => void; onConfirm: () => void }) {
  const title = [s.brand, s.name].filter(Boolean).join(" · ") || "Bu makara";

  return (
    <Modal title="Makarayı Sil" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <ColorDot hex={s.colorHex ?? "#9ca3af"} size={16} />
          <div className="min-w-0 text-sm">
            <p className="font-medium truncate">{title}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatNumber(s.remainingGrams, 0)} / {formatNumber(s.totalGrams, 0)} g
            </p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Bu makara listeden kalkacak ve tüketim geçmişi silinecek. Geri alınamaz.
        </p>
        <p className="text-[11px] text-muted-foreground">
          Biten makarayı silmek yerine listede bırakabilirsin.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>İptal</Button>
          <Button variant="destructive" className="gap-1.5" onClick={onConfirm}>
            <Trash2 className="h-4 w-4" /> Sil
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SpoolRow({
  spool: s, index, groupColorHex, groupLabel, onEdit, onConsume, onToggleOpen, onDelete,
}: {
  spool: SpoolLike; index: number; groupColorHex: string; groupLabel: string;
  onEdit: () => void; onConsume: () => void; onToggleOpen: (sealed: boolean) => void; onDelete: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  // Bir kez açıldıktan sonra içerik takılı kalır: kapanış animasyonu boş kutuya değil,
  // gerçek listeye uygulanır (ve tekrar açınca veri anında hazır).
  const [historyMounted, setHistoryMounted] = useState(false);

  const sealed = isSealed(s);
  const empty = isEmptySpool(s);
  const gap = costGapOf(s);
  const colorHex = s.colorHex ?? groupColorHex;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card transition-colors hover:bg-muted/40",
        "animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
      )}
      style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <ColorDot hex={colorHex} size={12} />
        <div className="min-w-0 flex-1">
          <p className="truncate">
            {s.brand ?? "—"}
            {s.name && s.name !== groupLabel ? ` · ${s.name}` : ""}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(s.remainingGrams, 0)} / {formatNumber(s.totalGrams, 0)} g
          </p>
        </div>
        <span className={cn(
          "text-[11px] px-1.5 py-0.5 rounded border shrink-0",
          empty ? "bg-destructive/15 text-destructive border-destructive/30"
            : sealed ? "bg-green-500/15 text-green-400 border-green-500/30"
              : "bg-amber-500/15 text-amber-400 border-amber-500/30"
        )}>
          {empty ? "Bitti" : sealed ? "Kapalı" : "Açık"}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button size="icon" variant="ghost" className="h-7 w-7"
            title={sealed ? "Aç" : "Dolu (kapalı) işaretle"}
            onClick={() => onToggleOpen(sealed)}>
            <PackageOpen className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Filament düş"
            onClick={onConsume}>
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon" variant="ghost"
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
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Düzenle" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Sil"
            onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {gap && (
        <p className="flex items-start gap-1.5 px-3 pb-2 text-[11px] leading-snug text-muted-foreground">
          <Coins className="h-3.5 w-3.5 shrink-0 mt-px text-amber-400" />
          <span>
            Bu makaranın gerçek maliyeti{" "}
            <span className="font-semibold text-amber-400">
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

      {/* Çekmece: grid satırını 0fr→1fr akıtmak, sabit bir max-height uydurmadan
          içeriğe göre yumuşak açılma verir. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          historyOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-2 border-t">
            {historyMounted && (
              <UsageHistory spoolId={s.id} remainingGrams={s.remainingGrams} colorHex={colorHex} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditSpoolDialog({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(spool.name ?? "");
  const [brand, setBrand] = useState(spool.brand ?? "");
  const [colorName, setColorName] = useState(spool.colorName ?? "");
  const [colorHex, setColorHex] = useState(spool.colorHex ?? "#9ca3af");
  const [totalGrams, setTotalGrams] = useState(String(spool.totalGrams));
  const [remainingGrams, setRemainingGrams] = useState(String(spool.remainingGrams));
  const [spoolCost, setSpoolCost] = useState(spool.spoolCost != null ? String(spool.spoolCost) : "");

  const save = useMutation({
    mutationFn: () =>
      fetch(`/api/spools/${spool.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          brand: brand.trim() || null,
          colorName: colorName.trim() || null,
          colorHex,
          totalGrams: Number(totalGrams) || spool.totalGrams,
          remainingGrams: Number(remainingGrams),
          spoolCost: spoolCost ? Number(spoolCost) : null,
        }),
      }).then((r) => { if (!r.ok) throw new Error("Kaydedilemedi"); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      toast.success("Makara güncellendi");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal title="Makarayı Düzenle" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Marka</Label>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Polyture…" />
          </div>
          <div>
            <Label className="text-xs">Ürün adı / seri</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="XPLA" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Renk adı</Label>
            <Input value={colorName} onChange={(e) => setColorName(e.target.value)} placeholder="Yeşil" />
          </div>
          <div>
            <Label className="text-xs">Renk</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={colorHex} onChange={(e) => setColorHex(e.target.value)}
                className="h-9 w-12 rounded-md border bg-background cursor-pointer" />
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
            <Label className="text-xs">Fiyat (₺)</Label>
            <Input type="number" value={spoolCost} onChange={(e) => setSpoolCost(e.target.value)} />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Kalan gram toplamla eşitlenirse makara otomatik <b>kapalı</b> sayılır.
        </p>
        <Button className="w-full" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </div>
    </Modal>
  );
}

function ConsumeDialog({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: products, isLoading: productsLoading } = useQuery<ProductLite[]>({
    queryKey: ["products", "active"],
    queryFn: () => fetchJson("/api/products?filter=active"),
    staleTime: 60_000,
  });

  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [grams, setGrams] = useState("");
  const [note, setNote] = useState("");
  const productList = useMemo(() => (Array.isArray(products) ? products : []), [products]);

  function recalc(id: string, q: string) {
    const p = productList.find((x) => x.id === id);
    const w = p?.cost?.filamentWeight ?? 0;
    if (w > 0) setGrams(String(Math.round(w * (Number(q) || 1))));
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
      }).then((r) => { if (!r.ok) throw new Error("Düşülemedi"); return r.json(); });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      // Yeni düşüm kaydı geçmişte ve "ne zaman biter" tahmininde anında görünsün.
      qc.invalidateQueries({ queryKey: ["spool-usage", spool.id] });
      toast.success(`${formatNumber(Number(grams) || 0, 0)} g düşüldü — ${spool.name}`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal title={`Filament Düş — ${spool.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Kalan: <span className="font-medium text-foreground tabular-nums">{formatNumber(spool.remainingGrams, 0)} g</span>. Ürün
          seçersen gramaj maliyet bilgisinden otomatik gelir. Gram düşülünce makara <b>açık</b> sayılır.
        </p>
        <div>
          <Label className="text-xs">Ürün (opsiyonel)</Label>
          {productsLoading ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : (
            <select
              value={productId}
              onChange={(e) => { setProductId(e.target.value); recalc(e.target.value, qty); }}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted/40"
            >
              <option value="">Seçilmedi (manuel gram gir)</option>
              {productList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.cost?.filamentWeight ? ` (${formatNumber(p.cost.filamentWeight, 0)}g)` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Adet</Label>
            <Input type="number" min="1" value={qty}
              onChange={(e) => { setQty(e.target.value); recalc(productId, e.target.value); }} />
          </div>
          <div>
            <Label className="text-xs">Düşülecek gram</Label>
            <Input type="number" min="0" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder="45" />
          </div>
        </div>
        <div>
          <Label className="text-xs">Not (opsiyonel)</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="sipariş #1234" />
        </div>
        <Button className="w-full" disabled={consume.isPending || !(Number(grams) > 0)} onClick={() => consume.mutate()}>
          {consume.isPending ? "Düşülüyor…" : `${formatNumber(Number(grams) || 0, 0)} g Düş`}
        </Button>
      </div>
    </Modal>
  );
}
