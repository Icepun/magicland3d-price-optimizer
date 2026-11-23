"use client";

import { fetchJson } from "@/lib/fetch-json";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Disc3, Plus, Trash2, Pencil, X, PackageOpen, Copy, Search, Bell, Check, Minus,
  CircleOff, TrendingDown, Hourglass, AlertTriangle, RefreshCw,
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
import type { FilamentTuketimi } from "@/lib/filament-tuketim";
import { cn } from "@/lib/utils";
import {
  FILAMENT_BRANDS, FILAMENT_COLORS, MIN_LOW_SPOOL_COUNT,
  esikBul, isSealed, isEmptySpool, ozelEsikVarMi,
  type FilamentGroup, type SpoolLike,
} from "@/core/filament-groups";
import {
  alisverisListesi, bolumlere, filamentStokDurumu, filtrele,
  type RenkCip, type StokFiltre,
} from "./spools-view";
import { pencereGizliMi } from "@/lib/pencere-gorunur";

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

const KART = "rounded-2xl bg-card ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none";
const BIRINCIL = "h-9 gap-2 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] px-3.5 text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:-translate-y-px hover:brightness-110 active:scale-[0.97] motion-reduce:hover:translate-y-0";

/** "Ne kadar yeter" kutusunun üzerine gelince görünen kısa açıklama. */
function tuketimAciklamasi(t: FilamentTuketimi): string {
  return [
    `Son ${t.olculenGun} günde ~${formatNumber(t.toplamGram / 1000, 1)} kg filament kullanıldı`,
    `günde ~${formatNumber(t.gunlukGram, 0)} g`,
    `elde ~${formatNumber(t.stokGram / 1000, 1)} kg`,
    t.gramsizAdet > 0 ? `${formatNumber(t.gramsizAdet, 0)} satışta gramaj girilmemiş` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function OzetKutusu({ sira, ikon, baslik, ton, children }: { sira: number; ikon: React.ReactNode; baslik: string; ton?: "kotu"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-2xl bg-card p-4 ring-1 ring-white/[0.07] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] hover:shadow-[0_20px_40px_-30px_rgba(122,126,255,0.55)] animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none motion-reduce:hover:translate-y-0",
        ton === "kotu" && "ring-rose-400/25"
      )}
      style={{ animationDelay: `${sira * 60}ms` }}
    >
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className={cn(
          "grid size-7 place-items-center rounded-lg bg-white/[0.05] text-[#C9D2F2] ring-1 ring-white/[0.08] transition-colors group-hover:bg-[#7A7EFF]/15",
          ton === "kotu" && "bg-rose-500/10 text-rose-300 ring-rose-400/25"
        )}>
          {ikon}
        </span>
        {baslik}
      </span>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}

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

  const { data, isLoading, isError, isFetching, refetch } = useQuery<Spool[]>({
    queryKey: ["spools"],
    queryFn: () => fetchJson("/api/spools"),
    // Telefondan eklenen/silinen makara da görünsün: girişte tazele, açıkken dakikada bir yokla
    // (pencere gizliyken yoklama durur). Eskiden sayfa açık kaldıkça eski sayıları gösteriyordu.
    staleTime: 60_000,
    refetchOnMount: true,
    refetchInterval: () => (pencereGizliMi() ? false : 60_000),
  });
  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
    staleTime: 5 * 60_000,
  });
  // Satış hızından "elimdeki filament kaç gün yeter" (renk bazında veri yok; bkz. filament-tuketim).
  // AYRI anahtar: ["spools"] düşünce (her makara yazmasında) bu satış taraması yeniden koşmasın.
  const { data: tuketim, isError: tuketimHatasi } = useQuery<FilamentTuketimi>({
    queryKey: ["spools-tuketim"],
    queryFn: () => fetchJson("/api/spools/tuketim"),
    staleTime: 10 * 60_000,
  });
  /** Veri hiç gelmediyse ekran "her şey bitti" DEMEZ — hata + Tekrar dene gösterir. */
  const veriYok = isError && !data;

  const spools = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const [search, setSearch] = useState("");
  const [filtre, setFiltre] = useState<StokFiltre>("hepsi");

  /**
   * Stok durumu çekirdekten — telefon Filament ekranı ve Panel AYNI fonksiyonu kullanır, eşik
   * kuralları (renge özel, izlenen, susturulan) tek yerde okunur.
   */
  const durum = useMemo(() => filamentStokDurumu(spools, settings ?? {}), [spools, settings]);
  const { ayar, groups } = durum;
  const threshold = ayar.threshold;
  const mutedGroups = ayar.mutedGroups;
  const ciplerHam = useMemo(() => (veriYok ? [] : durum.cipler), [veriYok, durum]);
  const ozet = durum.ozet;
  const bolumler = useMemo(
    () => bolumlere(filtrele(ciplerHam, filtre, search)),
    [ciplerHam, filtre, search]
  );
  const bos = isLoading || veriYok;

  const [adding, setAdding] = useState<Partial<AddPrefill> | null>(null);
  const [detail, setDetail] = useState<FilamentGroup | null>(null);
  const [editing, setEditing] = useState<Spool | null>(null);
  const [deleting, setDeleting] = useState<SpoolLike | null>(null);

  /**
   * Eşik kaydı İYİMSER: ekrandaki değer hemen değişir, hızlı art arda +/- tıklamaları kaybolmaz
   * (eskiden üç tık da aynı eski değeri gönderiyordu). Hata olursa geri alınır ve söylenir.
   * null → anahtar silinir (renge özel eşiği "Sıfırla").
   */
  const saveSetting = useMutation<unknown, Error, Record<string, string | null>, { prev: Record<string, string> | undefined }>({
    mutationFn: (body) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ["app-settings"] });
      const prev = qc.getQueryData<Record<string, string>>(["app-settings"]);
      qc.setQueryData<Record<string, string>>(["app-settings"], (o) => {
        const yeni = { ...(o ?? {}) };
        for (const [k, v] of Object.entries(body)) {
          if (v === null) delete yeni[k];
          else yeni[k] = v;
        }
        return yeni;
      });
      return { prev };
    },
    onError: (_e, _b, ctx) => {
      if (ctx?.prev) qc.setQueryData(["app-settings"], ctx.prev);
      toast.error("Eşik kaydedilemedi");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["app-settings"] });
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
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["spools"] });
      void qc.invalidateQueries({ queryKey: ["spools-tuketim"] }); // elde kalan gram değişti
    },
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
    <div className="p-6 space-y-5 mx-auto w-full max-w-[1600px]">
      {/* ── Başlık ─────────────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <Disc3 className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Filament</h1>
            <p className="text-xs text-muted-foreground">Stoktaki kapalı makaralar — azalanı görüp sipariş ver.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThresholdControl
            value={threshold}
            onChange={(v) => saveSetting.mutate({ [KEY_THRESHOLD]: String(v) })}
          />
          <Button size="sm" className={BIRINCIL} onClick={() => setAdding({})}>
            <Plus className="h-4 w-4" /> Makara Ekle
          </Button>
        </div>
      </header>

      {/* ── Özet: kaç makara, kaç renk bitti/azaldı, ne kadar yeter ─────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <OzetKutusu sira={0} ikon={<Disc3 className="size-3.5" />} baslik="Kapalı makara">
          <p className="text-2xl font-semibold tracking-tight tabular-nums">
            {bos ? "—" : <AnimatedNumber value={ozet.toplam} format={(n) => formatNumber(n, 0)} />}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{bos ? "\u00a0" : `${formatNumber(ozet.renk, 0)} renk`}</p>
        </OzetKutusu>
        <OzetKutusu sira={1} ikon={<CircleOff className="size-3.5" />} baslik="Biten renk" ton={!bos && ozet.biten > 0 ? "kotu" : undefined}>
          <p className={cn("text-2xl font-semibold tracking-tight tabular-nums", !bos && ozet.biten > 0 && "text-rose-300")}>
            {bos ? "—" : <AnimatedNumber value={ozet.biten} format={(n) => formatNumber(n, 0)} />}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{bos ? "\u00a0" : ozet.biten > 0 ? "kapalı makara kalmadı" : "hepsi stokta"}</p>
        </OzetKutusu>
        <OzetKutusu sira={2} ikon={<TrendingDown className="size-3.5" />} baslik="Azalan renk">
          <p className={cn("text-2xl font-semibold tracking-tight tabular-nums", !bos && ozet.azalan > 0 && "text-[#C9D2F2]")}>
            {bos ? "—" : <AnimatedNumber value={ozet.azalan} format={(n) => formatNumber(n, 0)} />}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">eşik: {formatNumber(threshold, 0)} makara ve altı</p>
        </OzetKutusu>
        <OzetKutusu sira={3} ikon={<Hourglass className="size-3.5" />} baslik="Ne kadar yeter">
          <p
            className={cn("text-2xl font-semibold tracking-tight tabular-nums", tuketim?.kacGun != null && tuketim.kacGun < 21 && "text-[#C9D2F2]")}
            title={tuketim?.kacGun != null ? tuketimAciklamasi(tuketim) : undefined}
          >
            {tuketim?.kacGun != null ? (
              <>
                ~<AnimatedNumber value={Math.round(tuketim.kacGun)} format={(n) => formatNumber(n, 0)} />
                <span className="text-base font-medium text-muted-foreground"> gün</span>
              </>
            ) : (
              "—"
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tuketim?.kacGun != null
              ? "bu satış hızıyla"
              : tuketimHatasi
                ? "şu an hesaplanamadı"
                : !tuketim
                  ? "hesaplanıyor…"
                  : !tuketim.hazir
                    ? "satış geçmişi henüz kısa"
                    : "son satışlarda tüketim yok"}
          </p>
        </OzetKutusu>
      </div>

      {/* ── Ara + filtre ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-card px-3 py-2.5 ring-1 ring-white/[0.07] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Renk ara…"
            className="h-8 w-44 rounded-xl border-white/[0.08] bg-white/[0.03] pl-8 text-sm dark:bg-white/[0.03] focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {/* Eşiği 0 yapma numarasının yerine GERÇEK filtre: "sadece bitenler" eşiği bozmadan görülür. */}
          {([
            ["hepsi", "Hepsi", ozet.renk],
            ["azalan", "Azalan", ozet.azalan],
            ["biten", "Biten", ozet.biten],
          ] as Array<[StokFiltre, string, number]>).map(([k, l, n]) => (
            <FilterChip key={k} active={filtre === k} onClick={() => setFiltre(k)}>
              {l}
              <span className="ml-1 tabular-nums opacity-70">{formatNumber(n, 0)}</span>
            </FilterChip>
          ))}
        </div>
        {ozet.sorunlu > 0 && (
          <Button size="sm" variant="outline" className="ml-auto h-8 gap-1.5 rounded-xl border-white/[0.1] bg-white/[0.03] transition active:scale-[0.97]" onClick={copyShoppingList}>
            <Copy className="h-3.5 w-3.5" /> Eksik listesini kopyala
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="rounded-2xl bg-card p-4 ring-1 ring-white/[0.07]">
          <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-xl" />
            ))}
          </div>
        </div>
      ) : veriYok ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-rose-500/[0.05] px-4 py-12 text-center ring-1 ring-rose-400/25 animate-in fade-in duration-300">
          <AlertTriangle className="h-8 w-8 text-rose-300/80" />
          <p className="font-medium">Makaralar yüklenemedi</p>
          <p className="text-sm text-muted-foreground">Bağlantını kontrol edip tekrar dene.</p>
          <Button variant="outline" size="sm" className="gap-1.5 rounded-xl" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {bolumler.map((bolum, bi) => (
            <section
              key={bolum.baslik}
              className={cn(KART, "p-4")}
              style={{ animationDelay: `${120 + bi * 80}ms` }}
            >
              <div className="mb-3 flex items-baseline gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  <span className="size-1.5 rounded-full bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF]" />
                  {bolum.baslik}
                </h2>
                {bolum.aciklama && (
                  <span className="text-xs text-muted-foreground">{bolum.aciklama}</span>
                )}
              </div>
              {bolum.cipler.length === 0 ? (
                <p className="text-sm text-muted-foreground/70 py-2">Bu filtrede renk yok.</p>
              ) : (
                <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
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
            </section>
          ))}
        </div>
      )}


      {detail && detailGroup && (
        <GroupDetailDialog
          group={detailGroup}
          threshold={esikBul(detail.key, ayar)}
          generalThreshold={threshold}
          custom={ozelEsikVarMi(detail.key, ayar)}
          onSetThreshold={(v) =>
            saveSetting.mutate({ [`filamentThreshold:${detail.key}`]: v === null ? null : String(v) })
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
  // Kapalı makara kalmadı ama yazıcıda açık makara var — zil de "Son makara açık" diyor.
  const sonAcik = biten && (cip.group?.openCount ?? 0) > 0;
  const ad = cip.turuGoster && cip.material ? `${cip.colorName} · ${cip.material}` : cip.colorName;
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        cip.group
          ? sonAcik
            ? `${ad} — kapalı makara kalmadı, yazıcıda açık makara var`
            : `${ad} — ${cip.sealed} kapalı makara`
          : `${ad} — stokta yok, eklemek için tıkla`
      }
      style={{ animationDelay: `${Math.min(index, 18) * 22}ms` }}
      className={cn(
        "group relative flex flex-col items-center gap-1.5 rounded-xl bg-white/[0.02] p-2.5 text-center text-foreground ring-1 ring-white/[0.06]",
        "transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/[0.04] active:scale-[0.97] motion-reduce:hover:translate-y-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60",
        "animate-in fade-in zoom-in-95 fill-mode-both duration-300",
        // Renkli zemin YALNIZ bitenlere ayrıldı. Eşik 1'ken tek makarası kalan on renk birden
        // "azalan" olur; hepsine kehribar zemin verilince ekranın yarısı uyarıya döner ve asıl
        // acil olan üç renk kaybolur. Azalan artık yalnız etiketiyle konuşuyor.
        biten && "bg-rose-500/[0.05] ring-rose-400/40 hover:ring-rose-400/70",
        azalan && "hover:ring-[#7A7EFF]/55",
        !biten && !azalan && "hover:ring-white/[0.14] hover:shadow-[0_10px_24px_-16px_rgba(122,126,255,0.6)]"
      )}
    >
      {/* Makara halkası: renk gerçek filament rengi, göbeğindeki sayı kapalı makara adedi. */}
      <span className="relative">
        {/* Biten renkte halkanın ardında yumuşak bir hale. Bilerek yavaş ve sönük: bu sayfa
            her gün açılıyor, sürekli çarpan bir uyarı kısa sürede rahatsız ederdi. */}
        {biten && (
          <span className="absolute -inset-1 rounded-full bg-rose-500/20 blur-md animate-pulse motion-reduce:animate-none" />
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
      <span className="w-full truncate text-[11px] font-medium leading-tight">{ad}</span>
      {/* Durum etiketi TEK KELİME: iki kelimeye taşınca satır kayıyor ve çip komşularından
          uzun kalıyordu, ızgara tırtıklı görünüyordu. */}
      <span
        className={cn(
          "text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap",
          biten && "text-rose-300",
          azalan && "text-[#A9AEFF]",
          !biten && !azalan && "font-normal text-muted-foreground"
        )}
      >
        {biten ? (sonAcik ? "son açık" : cip.group ? "bitti" : "yok") : azalan ? "azalıyor" : "makara"}
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
        "rounded-full px-2.5 py-1 text-xs ring-1 transition-all duration-200 active:scale-95",
        active
          ? "bg-[#7A7EFF]/20 font-medium text-[#E4E7FF] ring-[#7A7EFF]/55 shadow-[0_6px_18px_-10px_rgba(122,126,255,0.9)]"
          : "bg-white/[0.02] text-muted-foreground ring-white/[0.08] hover:bg-white/[0.05] hover:text-foreground"
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
      <Button size="sm" variant="outline" className="h-9 gap-1.5 rounded-xl border-white/[0.1] bg-white/[0.03] transition active:scale-[0.97]" onClick={() => setOpen((v) => !v)}>
        <Bell className="h-3.5 w-3.5 text-[#A9AEFF]" /> Uyarı eşiği: <span className="tabular-nums">{value}</span>
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <Card className="absolute right-0 top-11 z-50 w-64 rounded-2xl border-0 ring-1 ring-white/[0.1] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)] animate-in fade-in zoom-in-95 duration-200">
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in" onClick={onClose} />
      <Card className={cn("relative w-full rounded-2xl border-0 ring-1 ring-white/[0.09] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.95)] animate-in fade-in zoom-in-95 duration-200", wide ? "max-w-2xl" : "max-w-md")}>
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
      fetchJson<{ count: number }>("/api/spools/batch", {
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
      }),
    onSuccess: (res: { count: number }) => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      qc.invalidateQueries({ queryKey: ["spools-tuketim"] });
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
          <p className="text-xs text-emerald-300 flex items-center gap-1 animate-in fade-in slide-in-from-top-1 duration-300">
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
                  colorKey === c.key ? "border-[#7A7EFF]/60 bg-[#7A7EFF]/10 scale-[1.03]" : "border-transparent hover:bg-white/[0.05]"
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

        <div className="rounded-xl bg-white/[0.03] px-3 py-2 text-xs ring-1 ring-white/[0.06] transition-colors">
          <span className="text-muted-foreground">Eklenecek: </span>
          <span className="font-medium">{preview}</span>
        </div>

        <div className="flex gap-2">
          <Button className={cn(BIRINCIL, "h-9 flex-1")} disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
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
  group: g, threshold, generalThreshold, custom, onSetThreshold, onClose, onEdit, onDelete, onAdd,
}: {
  group: FilamentGroup; threshold: number; generalThreshold: number; custom: boolean;
  onSetThreshold: (v: number | null) => void;
  onClose: () => void; onEdit: (s: SpoolLike) => void;
  onDelete: (s: SpoolLike) => void; onAdd: () => void;
}) {
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

        <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.02] p-3 ring-1 ring-white/[0.07]">
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
        <p className="text-sm text-muted-foreground">Bu makara listeden kalkacak. Geri alınamaz.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>İptal</Button>
          <Button className="gap-1.5 bg-rose-500 text-white hover:bg-rose-500/90 active:scale-[0.97]" onClick={onConfirm}>
            <Trash2 className="h-4 w-4" /> Sil
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SpoolRow({
  spool: s, index, groupColorHex, groupLabel, onEdit, onDelete,
}: {
  spool: SpoolLike; index: number; groupColorHex: string; groupLabel: string;
  onEdit: () => void; onDelete: () => void;
}) {
  const sealed = isSealed(s);
  const empty = isEmptySpool(s);
  const colorHex = s.colorHex ?? groupColorHex;

  return (
    <div
      className={cn(
        "rounded-xl bg-white/[0.02] ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.04]",
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
          empty ? "bg-rose-500/15 text-rose-300 border-rose-400/30"
            : sealed ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
              : "bg-[#7A7EFF]/15 text-[#C9D2F2] border-[#7A7EFF]/30"
        )}>
          {empty ? "Bitti" : sealed ? "Kapalı" : "Açık"}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* "Aç" işareti kaldırıldı: filament ya vardır ya yoktur, kullanılan makara doğrudan
              siliniyor. Ara bir "açık" durumu tutmak sayımı karıştırmaktan başka işe yaramıyordu. */}
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Düzenle" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200" title="Sil"
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

  // BOŞ ≠ SIFIR: "Kalan" silinip kaydedilince makara 0 g / bitti oluyordu (denetim, 23 Kas 2026).
  const sayi = (t: string) => {
    const v = t.trim().replace(",", ".");
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const toplamG = sayi(totalGrams);
  const kalanG = sayi(remainingGrams);
  const fiyat = spoolCost.trim() ? sayi(spoolCost) : null;
  const hata =
    toplamG == null || toplamG <= 0
      ? "Toplam gram girilmeli"
      : kalanG == null || kalanG < 0
        ? "Kalan gram girilmeli"
        : kalanG > toplamG
          ? "Kalan toplamdan büyük olamaz"
          : spoolCost.trim() && (fiyat == null || fiyat < 0)
            ? "Fiyat geçersiz"
            : null;

  const save = useMutation({
    mutationFn: () =>
      fetchJson(`/api/spools/${spool.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          brand: brand.trim() || null,
          colorName: colorName.trim() || null,
          colorHex,
          totalGrams: toplamG,
          remainingGrams: kalanG,
          spoolCost: fiyat,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spools"] });
      qc.invalidateQueries({ queryKey: ["spools-tuketim"] });
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
            <Input inputMode="decimal" value={totalGrams} onChange={(e) => setTotalGrams(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Kalan (g)</Label>
            <Input inputMode="decimal" value={remainingGrams} onChange={(e) => setRemainingGrams(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Fiyat (₺)</Label>
            <Input inputMode="decimal" value={spoolCost} onChange={(e) => setSpoolCost(e.target.value)} />
          </div>
        </div>
        {hata ? (
          <p className="text-[11px] font-medium text-rose-300 animate-in fade-in duration-200">{hata}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Kalan toplama eşitse makara <b>kapalı</b> sayılır.
          </p>
        )}
        <Button className={cn(BIRINCIL, "h-9 w-full")} disabled={save.isPending || hata != null} onClick={() => save.mutate()}>
          {save.isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </div>
    </Modal>
  );
}
