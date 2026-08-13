"use client";

import { fetchJson } from "@/lib/fetch-json";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Disc3, Plus, Trash2, Pencil, X, PackageOpen, Copy, Search, Bell, Check, Minus,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { SpoolDisk, ColorDot } from "@/components/spools/spool-visuals";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  FILAMENT_BRANDS, FILAMENT_COLORS, DEFAULT_LOW_SPOOL_COUNT, MIN_LOW_SPOOL_COUNT,
  groupSpools, isSealed, isEmptySpool, parseThreshold,
  type FilamentGroup, type SpoolLike,
} from "@/core/filament-groups";
import {
  alisverisListesi, bolumlere, filtrele, renkCipleri, stokOzeti, TEMEL_AILELER,
  type RenkCip, type StokFiltre,
} from "./spools-view";

/**
 * FİLAMENT — KAPALI MAKARA STOĞU.
 *
 * Sayfanın TEK işi: "açılmamış hangi renkten kaç makaram kaldı ve neyi sipariş etmeliyim".
 * Açık makaralar yazıcılara takılı; burada sayılmazlar.
 *
 * Bu yüzden şunlar sayfadan KALDIRILDI (kullanıcı kararı, 13 Ağu): tüketim geçmişi/kaydı,
 * "ne zaman biter" tahmini, "aç" işlemi ve makara maliyeti. Hiçbiri kullanılmıyordu (0 kayıt,
 * 34/34 makarada maliyet boş) ve ekranı stok görmeyi zorlaştıracak kadar şişiriyordu.
 *
 * Ekranın birimi tek tek makara DEĞİL RENK: her renk bir çip, çipin göbeğinde kapalı makara
 * sayısı. En çok kullanılan renkler (siyah/gri/beyaz) her zaman en üstte ve stokları
 * sıfırlanınca bile görünür.
 */

interface Spool extends SpoolLike {
  id: string;
  name: string;
  spoolCost: number | null;
  vendorUrl: string | null;
}

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "Reçine"];
const WEIGHTS = [1000, 750, 500, 2000, 5000];
const KEY_THRESHOLD = "filamentLowSpoolCount";

/** Grup satırları `SpoolLike` taşır; fiyat farkı yalnız listeden gelen kayıtlarda dolu olur. */
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
  const [search, setSearch] = useState("");
  const [filtre, setFiltre] = useState<StokFiltre>("hepsi");

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

  /** Renk çipleri — temel renkler ve izlenen renkler stok yokken bile listede kalır. */
  const ciplerHam = useMemo(
    () =>
      renkCipleri(
        groups,
        (g) => groupThresholds[g.key] ?? threshold,
        threshold,
        // Her aileden yalnız ana ton: "Gri" evet, "Koyu Gri"/"Gümüş" hayır.
        FILAMENT_COLORS.filter(
          (c) => c.key === c.family && (TEMEL_AILELER as readonly string[]).includes(c.family)
        ),
        watchedGroups
      ),
    [groups, groupThresholds, threshold, watchedGroups]
  );
  const ozet = useMemo(() => stokOzeti(ciplerHam), [ciplerHam]);
  const bolumler = useMemo(
    () => bolumlere(filtrele(ciplerHam, filtre, search)),
    [ciplerHam, filtre, search]
  );

  const [adding, setAdding] = useState<Partial<AddPrefill> | null>(null);
  const [detail, setDetail] = useState<FilamentGroup | null>(null);
  const [editing, setEditing] = useState<Spool | null>(null);
  const [deleting, setDeleting] = useState<SpoolLike | null>(null);

  const saveSetting = useMutation({
    mutationFn: (body: Record<string, string>) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
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
    const text = alisverisListesi(ciplerHam, mutedGroups);
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
    <div className="p-6 space-y-4 max-w-6xl">
      {/* ── Üst şerit: ne kadar var, neyi sipariş etmeli ────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Disc3 className="h-6 w-6 text-primary" /> Filament
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Stoktaki kapalı makaralar. Azalanı görüp sipariş ver.
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

      {/* Tek satırlık durum: toplam + sipariş gerekenler + filtre. Eskiden dört büyük
          kart vardı ve ekranın üçte birini yiyordu; asıl iş renkleri görmek. */}
      <div className="flex items-center gap-2 flex-wrap rounded-xl border bg-card px-3 py-2">
        <span className="font-mono text-sm tabular-nums">
          <b className="text-base">
            <AnimatedNumber value={ozet.toplam} format={(n) => formatNumber(n, 0)} />
          </b>
          <span className="text-muted-foreground"> makara · {ozet.renk} renk</span>
        </span>
        {ozet.biten > 0 && (
          <span className="font-mono text-sm tabular-nums text-destructive">
            · <AnimatedNumber value={ozet.biten} format={(n) => formatNumber(n, 0)} /> renk bitti
          </span>
        )}
        {ozet.azalan > 0 && (
          <span className="font-mono text-sm tabular-nums text-amber-400">
            · <AnimatedNumber value={ozet.azalan} format={(n) => formatNumber(n, 0)} /> renk azaldı
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Renk ara…"
              className="h-8 w-36 pl-8 text-sm"
            />
          </div>
          {/* Eşiği 0 yapma numarasının yerine GERÇEK filtre: "sadece bitenler" artık
              eşiği bozmadan görülebiliyor (Berke eşiği bunun için 0'da tutuyordu). */}
          {([
            ["hepsi", "Hepsi"],
            ["azalan", "Azalan"],
            ["biten", "Biten"],
          ] as Array<[StokFiltre, string]>).map(([k, l]) => (
            <FilterChip key={k} active={filtre === k} onClick={() => setFiltre(k)}>
              {l}
            </FilterChip>
          ))}
          {ozet.sorunlu > 0 && (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={copyShoppingList}>
              <Copy className="h-3.5 w-3.5" /> Liste
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {bolumler.map((bolum) => (
            <div key={bolum.baslik}>
              <div className="flex items-baseline gap-2 mb-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {bolum.baslik}
                </h2>
                {bolum.aciklama && (
                  <span className="text-[11px] text-muted-foreground/70">{bolum.aciklama}</span>
                )}
              </div>
              {bolum.cipler.length === 0 ? (
                <p className="text-sm text-muted-foreground/70 py-2">Bu filtrede renk yok.</p>
              ) : (
                <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                  {bolum.cipler.map((cip, i) => (
                    <RenkCipi
                      key={cip.key}
                      cip={cip}
                      index={i}
                      onClick={() =>
                        cip.group
                          ? setDetail(cip.group)
                          : setAdding({ colorName: cip.colorName, colorHex: cip.colorHex, colorKey: cip.colorKey })
                      }
                    />
                  ))}
                </div>
              )}
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

/**
 * RENK ÇİPİ — bu sayfanın imza öğesi.
 *
 * Eski kartlar kocamandı: bir ekrana ancak dört renk sığıyor, 19 renk için sürekli kaydırmak
 * gerekiyordu. Oysa sayfanın tek sorusu "neyim bitiyor". Çip, o soruyu tek bakışta cevaplayacak
 * kadar küçük: gerçek filament rengi + adı + KAPALI makara sayısı. Sayı kahraman, gerisi sessiz.
 *
 * Durum halkadan okunur: biten kırmızı, azalan kehribar, yeterli sessiz. Renk TEK sinyal
 * değildir — biten çipte ayrıca "bitti" yazar.
 */
function RenkCipi({ cip, index, onClick }: { cip: RenkCip; index: number; onClick: () => void }) {
  const biten = cip.durum === "biten";
  const azalan = cip.durum === "azalan";
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        cip.group
          ? `${cip.colorName} — ${cip.sealed} kapalı makara`
          : `${cip.colorName} — stokta yok, eklemek için tıkla`
      }
      style={{ animationDelay: `${Math.min(index, 18) * 22}ms` }}
      className={cn(
        "group relative flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center text-foreground",
        "transition-all hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "animate-in fade-in zoom-in-95 fill-mode-both duration-300",
        // Renkli zemin YALNIZ bitenlere ayrıldı. Eşik 1'ken tek makarası kalan on renk birden
        // "azalan" olur; hepsine kehribar zemin verilince ekranın yarısı uyarıya döner ve asıl
        // acil olan üç renk kaybolur. Azalan artık yalnız etiketiyle konuşuyor.
        biten && "border-destructive/50 hover:border-destructive/80",
        azalan && "hover:border-amber-500/60",
        !biten && !azalan && "hover:border-primary/35 hover:shadow-[0_4px_16px_oklch(0.66_0.2_278_/_10%)]"
      )}
    >
      {/* Makara halkası: renk gerçek filament rengi, göbeğindeki sayı kapalı makara adedi. */}
      <span className="relative">
        {/* Biten renkte halkanın ardında yumuşak bir hale. Bilerek yavaş ve sönük: bu sayfa
            her gün açılıyor, sürekli çarpan bir uyarı kısa sürede rahatsız ederdi. */}
        {biten && (
          <span className="absolute -inset-1 rounded-full bg-destructive/20 blur-md animate-pulse motion-reduce:animate-none" />
        )}
        <SpoolDisk
          colorHex={cip.colorHex}
          count={cip.sealed}
          size={48}
          hollow={cip.sealed === 0}
          countClassName="text-[15px]"
          className="relative group-hover:scale-105 motion-reduce:group-hover:scale-100"
        />
      </span>
      <span className="w-full truncate text-[11px] font-medium leading-tight">{cip.colorName}</span>
      {/* Durum etiketi TEK KELİME: iki kelimeye taşınca satır kayıyor ve çip komşularından
          uzun kalıyordu, ızgara tırtıklı görünüyordu. */}
      <span
        className={cn(
          "text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap",
          biten && "text-destructive",
          azalan && "text-amber-400",
          !biten && !azalan && "font-normal text-muted-foreground"
        )}
      >
        {biten ? (cip.group ? "bitti" : "yok") : azalan ? "azalıyor" : "makara"}
      </span>
    </button>
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
                  disabled={value <= MIN_LOW_SPOOL_COUNT}
                  onClick={() => onChange(Math.max(MIN_LOW_SPOOL_COUNT, value - 1))}>
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
  group: g, threshold, generalThreshold, onSetThreshold, onClose, onEdit, onDelete, onAdd,
}: {
  group: FilamentGroup; threshold: number; generalThreshold: number;
  onSetThreshold: (v: number | null) => void;
  onClose: () => void; onEdit: (s: SpoolLike) => void;
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
              disabled={threshold <= MIN_LOW_SPOOL_COUNT}
              onClick={() => onSetThreshold(Math.max(MIN_LOW_SPOOL_COUNT, threshold - 1))}>
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
  spool: s, index, groupColorHex, groupLabel, onEdit, onToggleOpen, onDelete,
}: {
  spool: SpoolLike; index: number; groupColorHex: string; groupLabel: string;
  onEdit: () => void; onToggleOpen: (sealed: boolean) => void; onDelete: () => void;
}) {
  const sealed = isSealed(s);
  const empty = isEmptySpool(s);
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
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Düzenle" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Sil"
            onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
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
