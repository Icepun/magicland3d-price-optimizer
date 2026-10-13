"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ViewerLoadingShell } from "@/components/printers/ViewerLoadingShell";
import dynamic from "next/dynamic";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileBox, Upload, Trash2, Loader2, Printer, Check, Layers, Box, AlertTriangle, RefreshCw,
  Pencil, CloudUpload, Sparkles,
} from "lucide-react";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";
import { setUploadsActive } from "@/lib/gcode-viz/viz-uploads";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { useDisariBirakmayiYut } from "@/lib/dosya-birakma";

// three.js yalnız izleyici açılınca yüklensin (bundle şişmesin).
const GcodeViewerDialog = dynamic(
  () => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog),
  { ssr: false, loading: () => <ViewerLoadingShell /> },
);
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { uploadProductModel, type UploadProgress } from "@/lib/upload-model";
import { MeshAttachButton } from "./MeshAttachButton";
import { dedupeFiles, familyDisplayName, printerFamilyKey } from "@/core/printers/printer-family";
import { baskiDosyasiMi, gorunenAd, grupOzeti, ozetMetni, uzantisizAd } from "@/lib/model-dosya-gorunum";
import { ParcaBilgiSatiri, ParcaGorseli } from "@/components/printers/parca-gorunum";
import { bilgiyiIsle, useEksikBilgiyiTamamla } from "@/lib/dosya-bilgisi";

interface PrinterCfg { id: string; name: string; brand: string; model: string | null; type: string }
interface VariantGroupLite { id: string; name: string; shareModels?: boolean; products: { id: string }[] }
interface ModelFile {
  id: string; printerConfigId: string; label: string | null; originalName: string; sizeBytes: number;
  gramaj: number | null; estPrintMin?: number | null; fileType: string; sortOrder: number;
  contentMd5?: string | null; hasThumbnail?: boolean; sliced?: boolean | null; renkler?: string[];
  meshR2Key?: string | null; meshName?: string | null; meshSizeBytes?: number | null;
}

/**
 * Satırı ekranda GEREKEN alanlara indirger.
 *
 * Liste ucu kaydın tüm sütunlarını döndürüyor: dilimleyici renk tablosu, plaka yerleşimi, disk
 * yolu, bulut anahtarı… Kart bunların hiçbirini çizmiyor ama hepsi belleğe alınıp React Query
 * önbelleğinde dakikalarca duruyordu. Ayıklama parse'tan hemen sonra yapılır → önbelleğe yalnız
 * çizilen alanlar girer.
 */
function hafifSatir(row: ModelFile): ModelFile {
  return {
    id: row.id,
    printerConfigId: row.printerConfigId,
    label: row.label ?? null,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    gramaj: row.gramaj ?? null,
    estPrintMin: row.estPrintMin ?? null,
    sliced: row.sliced ?? null,
    renkler: Array.isArray(row.renkler) ? row.renkler : [],
    fileType: row.fileType,
    sortOrder: row.sortOrder,
    contentMd5: row.contentMd5 ?? null,
    hasThumbnail: row.hasThumbnail ?? false,
    // Kaynak model: yalnız "bağlı mı" ve adı çiziliyor — anahtar da lazım çünkü satır
    // yükleme sonrası yerinde yamalanıyor (yeniden sorgu atılmıyor).
    meshR2Key: row.meshR2Key ?? null,
    meshName: row.meshName ?? null,
    meshSizeBytes: row.meshSizeBytes ?? null,
  };
}

/**
 * Kart ekrana girene kadar (yaklaşınca) veri çekmeyi bekletir.
 *
 * Baskı dosyaları listesi ürün detayının EN ALTINDA; sayfayı fiyat/kâr için açan kullanıcı çoğu
 * zaman oraya hiç inmiyor. Buna rağmen önizleme görselleriyle birlikte megabaytlarca satır
 * indiriliyordu. Kart görüş alanına 400px yaklaşınca istek başlar — inmeyen kullanıcı için sıfır.
 */
function useGorununceYukle<T extends HTMLElement>(ref: React.RefObject<T | null>): boolean {
  const [gorundu, setGorundu] = useState(false);
  useEffect(() => {
    if (gorundu) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // Gözlemci yoksa eski davranışa dön: hemen çek (bir sonraki tick'te → basamaklı render yok).
      const t = setTimeout(() => setGorundu(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (girisler) => {
        if (girisler.some((g) => g.isIntersecting)) {
          setGorundu(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" } // yaklaşırken başlat → kullanıcı indiğinde veri hazır
    );
    io.observe(el);
    return () => io.disconnect();
  }, [gorundu, ref]);
  return gorundu;
}

/**
 * Bir listenin ekranda hangi durumu göstereceği.
 *
 * "Boş liste" bir BİLGİDİR ("henüz parça yok"), "alınamadı" ise bilinmezliktir. İkisi aynı ekranı
 * gösterirse kullanıcı var olan dosyaları yok sanır ve yeniden yükler. Hata her zaman önce gelir.
 */
export function veriDurumu(
  yukleniyor: boolean,
  hata: boolean,
  adet: number
): "yukleniyor" | "hata" | "bos" | "dolu" {
  if (hata) return "hata";
  if (yukleniyor) return "yukleniyor";
  return adet > 0 ? "dolu" : "bos";
}

/** Kartın içinde kalan hata satırı: tek cümle + tekrar denemek için tek buton. */
function KartHatasi({
  mesaj,
  onRetry,
  deneniyor,
}: {
  mesaj: string;
  onRetry: () => void;
  deneniyor?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 animate-in fade-in slide-in-from-top-1 duration-300"
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
      <span className="flex-1 text-xs text-amber-400">{mesaj}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 text-xs shrink-0 transition-transform active:scale-95"
        disabled={deneniyor}
        onClick={onRetry}
      >
        <RefreshCw className={cn("h-3 w-3", deneniyor && "animate-spin")} />
        Tekrar dene
      </Button>
    </div>
  );
}

/** Yükleme sırasında boş alan bırakma — yazıcı kutuları kadar yer tutan iskelet. */
function ModelIskeleti() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-xl border bg-muted/20 overflow-hidden animate-in fade-in duration-500"
          style={{ animationDelay: `${i * 90}ms`, animationFillMode: "both" }}
        >
          <div className="flex items-center gap-2.5 px-3 py-2 border-b border-border/40 bg-muted/30">
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-3.5 flex-1 max-w-[9rem]" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
          <div className="p-2 space-y-1.5">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

function pct(p: UploadProgress) {
  return p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
}
function fmtEta(p: UploadProgress) {
  if (p.bytesPerSec <= 0) return "—";
  const rem = (p.total - p.loaded) / p.bytesPerSec;
  if (rem < 1.5) return "bitiyor…";
  if (rem < 60) return `~${Math.ceil(rem)} sn`;
  return `~${Math.floor(rem / 60)} dk ${Math.ceil(rem % 60)} sn`;
}

// memo: detay cache'i (madeToOrder/maliyet) değişince gereksiz render olmasın — yalnız productId'ye bağlı.
export const ModelFilesCard = memo(ModelFilesCardImpl);
function ModelFilesCardImpl({ productId, variantGroup }: { productId: string; variantGroup?: VariantGroupLite | null }) {
  const qc = useQueryClient();
  const kartRef = useRef<HTMLDivElement>(null);
  const gorundu = useGorununceYukle(kartRef);
  // fetchJson: HTTP hatasında fırlatır. Eski hâlinde hata gövdesi de "veri" sayılıyor, liste boş
  // kalıyor ve kart "Henüz parça yok" diyordu — yüklü dosyalar yokmuş gibi görünüyordu.
  const printersQuery = useQuery<PrinterCfg[]>({
    queryKey: ["printer-configs"],
    enabled: gorundu,
    queryFn: () => fetchJson<PrinterCfg[]>("/api/printers/config"),
  });
  const filesQuery = useQuery<ModelFile[]>({
    queryKey: ["product-models", productId],
    enabled: gorundu,
    queryFn: async () => {
      const rows = await fetchJson<ModelFile[]>(`/api/products/${productId}/models`);
      return Array.isArray(rows) ? rows.map(hafifSatir) : [];
    },
  });
  const printers = useMemo(
    () => (Array.isArray(printersQuery.data) ? printersQuery.data : []),
    [printersQuery.data],
  );
  const files = useMemo(
    () => (Array.isArray(filesQuery.data) ? filesQuery.data : []),
    [filesQuery.data],
  );
  /**
   * Yazıcılar AİLEYE göre gruplanır: aynı marka + modeldeki yazıcılar (ör. iki Snapmaker U1)
   * aynı dosyayı basar, dosyaları ortaktır. Eskiden her yazıcıya ayrı kutu çiziliyordu ve ikinci
   * U1'in kutusu boş kaldığı için dosyalar ona "yokmuş" gibi görünüyordu.
   */
  const aileler = useMemo(() => {
    const m = new Map<string, PrinterCfg[]>();
    for (const p of printers) {
      const k = printerFamilyKey(p);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.values()];
  }, [printers]);
  // isPending (isLoading DEĞİL): sorgu görünürlüğü bekleyip duraklarken isLoading false döner ve
  // kart "yazıcı yok / parça yok" diye yalan söylerdi. Beklerken de durum "yükleniyor"dur.
  const yaziciDurumu = veriDurumu(printersQuery.isPending, printersQuery.isError, printers.length);
  const dosyaDurumu = veriDurumu(filesQuery.isPending, filesQuery.isError, files.length);
  // Her ailenin EKRANDA görünen parçaları — aynı dosya iki kardeş yazıcıya ayrı ayrı
  // yüklenmişse bir kez görünür.
  const aileParcalari = useMemo(
    () =>
      aileler.map((aile) => {
        const ids = new Set(aile.map((a) => a.id));
        return { aile, parts: dedupeFiles(files.filter((f) => ids.has(f.printerConfigId))) };
      }),
    [aileler, files],
  );
  const gorunenParcalar = useMemo(() => aileParcalari.flatMap((a) => a.parts), [aileParcalari]);
  // Dosya bir yazıcı kutusunun DIŞINA bırakılırsa pencere onu açmaya çalışmasın.
  useDisariBirakmayiYut();
  // Eski dosyaların süresi/gramajı/önizlemesi arka planda tamamlanır (yalnız görünenler için).
  const okunanlar = useEksikBilgiyiTamamla(gorunenParcalar, gorundu && dosyaDurumu === "dolu", (id, b) => {
    // Sonuç satıra YERİNDE işlenir — yeniden sorgu atılmaz.
    qc.setQueryData<ModelFile[]>(["product-models", productId], (eski) =>
      Array.isArray(eski) ? eski.map((f) => (f.id === id ? bilgiyiIsle(f, b) : f)) : eski,
    );
  });

  const memberCount = variantGroup?.products?.length ?? 0;
  const inGroup = memberCount >= 2;
  // Paylaşım modu GRUP özelliğidir (VariantGroup.shareModels) → kalıcı: sayfa değişse de cihaz değişse de korunur.
  // Yerel state prop'tan seed'lenir; başka sayfaya gidip dönünce komponent remount olur ve cache'teki kalıcı değerle yeniden seed olur.
  const [applyToVariants, setApplyToVariants] = useState(variantGroup?.shareModels ?? false);
  const shareOn = inGroup && applyToVariants;

  // Paylaşımı aç/kapa: optimistic (anında çevir) + DB'ye yaz + grubun TÜM üyelerinin detay
  // cache'ini yamala (grup özelliği → her varyantta tutarlı). Minimum DB: refetch yok.
  type ShareSlice = { variantGroup?: { shareModels?: boolean } | null };
  const patchMembers = (val: boolean) => {
    for (const m of variantGroup?.products ?? []) {
      qc.setQueryData<ShareSlice>(["product", m.id], (old) =>
        old?.variantGroup ? { ...old, variantGroup: { ...old.variantGroup, shareModels: val } } : old
      );
    }
  };
  const toggleShare = useMutation({
    mutationFn: async (next: boolean) => {
      if (!variantGroup) throw new Error("no group");
      const r = await fetch(`/api/variant-groups/${variantGroup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareModels: next }),
      });
      if (!r.ok) throw new Error("Kaydedilemedi");
      return next;
    },
    onMutate: (next: boolean) => {
      const prev = applyToVariants;
      setApplyToVariants(next);
      patchMembers(next);
      return { prev };
    },
    onError: (_e, _next, ctx) => {
      const prev = ctx?.prev ?? false;
      setApplyToVariants(prev);
      patchMembers(prev);
      toast.error("Paylaşım ayarı kaydedilemedi");
    },
  });

  const refresh = () => {
    // ANA ürünü çağıran OPTIMISTIC günceller (yükleme/silmede cache'i elle yamalar) → bu ürün için
    // refetch YOK. Eski invalidate, DB'ye yazdıktan HEMEN SONRA okuma (read-after-write) tetikliyor;
    // libSQL bunun için yerel kopyayı buluta senkronlamayı bekleyip ana süreci ~1-2sn DONDURUYORDU.
    // Burada sadece DİĞER varyantların cache'i silinir (sonraki ziyarette taze) + Modeller listesi.
    for (const m of variantGroup?.products ?? []) {
      if (m.id !== productId) qc.removeQueries({ queryKey: ["product-models", m.id] });
    }
    qc.invalidateQueries({ queryKey: ["models"] });
  };

  return (
    <Card ref={kartRef} className="animate-in fade-in slide-in-from-bottom-2 duration-500" style={{ animationFillMode: "both" }}>
      <CardHeader className="pb-3 border-b border-border/50">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileBox className="h-4 w-4 text-primary" /> Baskı Dosyaları
          {files.length > 0 && (
            <Badge variant="outline" className="ml-1 tabular-nums animate-in fade-in zoom-in-95 duration-300">
              {files.length} parça
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3 space-y-3">
        {inGroup && (
          <button
            type="button"
            onClick={() => toggleShare.mutate(!applyToVariants)}
            disabled={toggleShare.isPending}
            aria-pressed={shareOn}
            className={cn(
              "w-full flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-all active:scale-[0.995] disabled:opacity-70",
              shareOn ? "border-primary/40 bg-primary/[0.06]" : "border-dashed hover:bg-muted/40"
            )}
          >
            <span className={cn("flex items-center justify-center h-5 w-5 rounded border shrink-0 transition-colors", shareOn ? "bg-primary border-primary" : "border-border")}>
              {shareOn && <Check className="h-3.5 w-3.5 text-primary-foreground" />}
            </span>
            <Layers className="h-4 w-4 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium flex items-center gap-1.5">
                Tüm varyantlara uygula
                {shareOn && <span className="text-[10px] font-semibold text-primary">· Açık</span>}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {shareOn
                  ? `Yüklediğin her dosya ${memberCount} varyanta birden eklenir.`
                  : `Dosyalar yalnız bu varyanta eklenir. Aç → ${memberCount} varyanta birden gider.`}
              </p>
            </div>
          </button>
        )}
        {yaziciDurumu === "hata" ? (
          <KartHatasi
            mesaj="Yazıcı listesi alınamadı."
            onRetry={() => void printersQuery.refetch()}
            deneniyor={printersQuery.isFetching}
          />
        ) : dosyaDurumu === "hata" ? (
          // Dosyalar bilinmiyorken yazıcı kutularını çizmek "hiç parça yok" izlenimi verirdi.
          <KartHatasi
            mesaj="Baskı dosyaları alınamadı."
            onRetry={() => void filesQuery.refetch()}
            deneniyor={filesQuery.isFetching}
          />
        ) : yaziciDurumu === "yukleniyor" || dosyaDurumu === "yukleniyor" ? (
          <ModelIskeleti />
        ) : yaziciDurumu === "bos" ? (
          <p className="text-xs text-muted-foreground py-1.5 animate-in fade-in duration-300">
            Önce <span className="font-medium text-foreground">Yazıcılar → Yönet</span>&apos;ten bir yazıcı ekle. Sonra her parçanın dosyasını buraya yükleyebilirsin.
          </p>
        ) : (
          aileParcalari.map(({ aile, parts }, gi) => {
            const temsil = aile[0];
            return (
              <div
                key={temsil.id}
                className="animate-in fade-in slide-in-from-bottom-1 duration-500"
                style={{ animationDelay: `${gi * 70}ms`, animationFillMode: "both" }}
              >
                <PrinterGroup
                  printer={temsil}
                  parts={parts}
                  productId={productId}
                  applyToVariants={shareOn}
                  okunanlar={okunanlar}
                  onChanged={refresh}
                  baslik={aile.length > 1 ? `${familyDisplayName(temsil)} · ${aile.length} yazıcı` : undefined}
                  altBaslik={aile.length > 1 ? aile.map((a) => a.name).join(", ") : undefined}
                />
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function PrinterGroup({ printer, parts, productId, applyToVariants, okunanlar, onChanged, baslik, altBaslik }: {
  printer: PrinterCfg;
  parts: ModelFile[];
  productId: string;
  applyToVariants: boolean;
  /** Bilgisi (süre/gramaj/önizleme) şu an dosyadan okunan parçalar. */
  okunanlar: ReadonlySet<string>;
  onChanged: () => void;
  /** Aile bölümünün adı (ör. "Snapmaker U1 · 2 yazıcı"); yoksa yazıcının adı. */
  baslik?: string;
  /** Ailedeki yazıcıların adları. */
  altBaslik?: string;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [prog, setProg] = useState<UploadProgress | null>(null);
  const [uploadingName, setUploadingName] = useState("");
  const [viewer, setViewer] = useState<ModelFile | null>(null);
  // Az önce yüklenen parçalar kısa süre vurgulu kalır — "hangisi yeni geldi" aranmasın.
  const [yeniler, setYeniler] = useState<ReadonlySet<string>>(() => new Set());
  // Sürükle-bırak: iç içe öğelerde enter/leave çift ateşlendiği için sayaçla tutulur.
  const [surukleniyor, setSurukleniyor] = useState(false);
  const surukSayaci = useRef(0);
  const azHareket = usePrefersReducedMotion();
  const ozet = parts.length > 1 ? ozetMetni(grupOzeti(parts)) : null;

  const del = useMutation({
    // "Tüm varyantlara uygula" açıksa ?allVariants=1 → sunucu dosyayı TÜM varyantlardan siler.
    // Sunucu reddettiyse BAŞARI sayma: yoksa satır ekrandan siliniyor ama dosya duruyordu.
    mutationFn: async (fileId: string) => {
      const r = await fetch(`/api/models/${fileId}${applyToVariants ? "?allVariants=1" : ""}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Silinemedi");
      return r.json().catch(() => null);
    },
    // OPTIMISTIC: satırı cache'ten çıkar → refetch YOK (yazma-sonrası-okuma donması yok). Diğer
    // varyantların listesi onChanged (removeQueries) ile sonraki ziyarette tazelenir.
    onSuccess: (_data, fileId) => {
      qc.setQueryData<ModelFile[]>(["product-models", productId], (old) =>
        Array.isArray(old) ? old.filter((f) => f.id !== fileId) : old
      );
      qc.invalidateQueries({ queryKey: ["printable-models"] }); // "Baskı Başlat" listesi de güncellensin
      onChanged();
      toast.success(applyToVariants ? "Parça tüm varyantlardan silindi" : "Parça silindi");
    },
    onError: () => toast.error("Silinemedi"),
  });

  const patchField = useMutation({
    // "Tüm varyantlara uygula" açıksa ad diğer varyantlardaki aynı dosyaya da yazılır.
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      const r = await fetch(`/api/models/${id}${applyToVariants ? "?allVariants=1" : ""}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Kaydedilemedi");
      return r.json().catch(() => null);
    },
    // Optimistic: ad cache'te anında güncellenir → REFETCH YOK. Hata olursa geri alınır.
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: ["product-models", productId] });
      const prev = qc.getQueryData<ModelFile[]>(["product-models", productId]);
      qc.setQueryData<ModelFile[]>(["product-models", productId], (old) =>
        Array.isArray(old) ? old.map((f) => (f.id === id ? ({ ...f, ...body } as ModelFile) : f)) : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["product-models", productId], ctx.prev);
      toast.error("Kaydedilemedi (geri alındı)");
    },
    onSuccess: () => {
      // Diğer varyantların listesi sonraki ziyarette taze gelsin.
      if (applyToVariants) onChanged();
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["models"], refetchType: "none" });
      // Ad değişimi "Baskı Başlat" seçicisinde de görünsün (çapraz-sayfa tazelik).
      qc.invalidateQueries({ queryKey: ["printable-models"] });
    },
  });

  const handleFiles = async (list: File[]) => {
    let ok = 0;
    const created: ModelFile[] = [];
    setUploadsActive(1); // arka plan görselleştirme üretimi bu yükleme boyunca beklesin
    try {
      for (const f of list) {
        setUploadingName(f.name);
        setProg({ loaded: 0, total: f.size, bytesPerSec: 0 });
        try {
          const row = await uploadProductModel({ productId, printerConfigId: printer.id, file: f, applyToVariants, onProgress: setProg });
          // Satır süre, gramaj ve önizlemeyle BİRLİKTE gelir → kart yükler yüklemez gösterir.
          if (row && typeof row === "object") created.push(hafifSatir(row as ModelFile));
          ok++;
        } catch (e) {
          toast.error(`${f.name}: ${e instanceof Error ? e.message : "yüklenemedi"}`);
        }
      }
    } finally {
      setUploadsActive(-1);
    }
    setProg(null);
    setUploadingName("");
    // OPTIMISTIC: oluşturulan satırları cache'e ekle → bu ürün için refetch YOK (donma yok).
    if (created.length) {
      qc.setQueryData<ModelFile[]>(["product-models", productId], (old) =>
        Array.isArray(old) ? [...old, ...created] : created
      );
      // Yazıcılar → "Baskı Başlat" ürün listesi bu yeni modeli görsün (çapraz-sayfa tazelik).
      qc.invalidateQueries({ queryKey: ["printable-models"] });
      const idler = created.map((c) => c.id);
      setYeniler((eski) => new Set([...eski, ...idler]));
      setTimeout(() => {
        setYeniler((eski) => new Set([...eski].filter((id) => !idler.includes(id))));
      }, 6000);
    }
    onChanged();
    if (inputRef.current) inputRef.current.value = "";
    if (ok > 0) toast.success(`${baslik ?? printer.name}: ${ok} parça yüklendi${applyToVariants ? " · tüm varyantlara" : ""}`);
  };

  const dosyaTasiyor = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const birakildi = (e: React.DragEvent) => {
    if (!dosyaTasiyor(e)) return;
    e.preventDefault();
    surukSayaci.current = 0;
    setSurukleniyor(false);
    if (prog !== null) return; // süren yükleme bitmeden yenisi başlamaz
    const hepsi = Array.from(e.dataTransfer.files ?? []);
    const uygun = hepsi.filter((f) => baskiDosyasiMi(f.name));
    if (uygun.length < hepsi.length) toast.error("Yalnız .gcode ve .3mf dosyaları eklenebilir");
    if (uygun.length) void handleFiles(uygun);
  };

  return (
    <div
      className={cn(
        "relative rounded-xl border bg-muted/20 overflow-hidden transition-[border-color,box-shadow] duration-200",
        surukleniyor && "border-primary/60 shadow-[0_0_0_3px] shadow-primary/15",
      )}
      onDragEnter={(e) => {
        if (!dosyaTasiyor(e)) return;
        e.preventDefault();
        surukSayaci.current += 1;
        setSurukleniyor(true);
      }}
      onDragOver={(e) => {
        if (!dosyaTasiyor(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = prog !== null ? "none" : "copy";
      }}
      onDragLeave={(e) => {
        if (!dosyaTasiyor(e)) return;
        surukSayaci.current = Math.max(0, surukSayaci.current - 1);
        if (surukSayaci.current === 0) setSurukleniyor(false);
      }}
      onDrop={birakildi}
    >
      {surukleniyor && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-background/80 backdrop-blur-[2px] animate-in fade-in duration-150">
          <CloudUpload className={cn("h-6 w-6 text-primary", !azHareket && "animate-bounce")} />
          <p className="text-xs font-medium text-primary">
            {prog !== null ? "Önce süren yükleme bitsin" : `Bırak, ${baslik ?? printer.name} için yüklensin`}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-border/40 bg-muted/30">
        <div className="flex items-center justify-center h-7 w-7 rounded-md bg-background border shrink-0">
          <Printer className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{baslik ?? printer.name}</p>
          {altBaslik && <p className="text-[10px] text-muted-foreground truncate">{altBaslik}</p>}
        </div>
        {ozet && (
          <span
            className="hidden sm:inline text-[11px] text-muted-foreground tabular-nums animate-in fade-in duration-300"
            title="Bu yazıcıdaki tüm parçaların toplamı"
          >
            Toplam <span className="font-medium text-foreground/80">{ozet}</span>
          </span>
        )}
        {parts.length > 0 && <Badge variant="secondary" className="tabular-nums text-[10px]">{parts.length} parça</Badge>}
        <input
          ref={inputRef}
          type="file"
          accept=".gcode,.gco,.g,.3mf"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) void handleFiles(Array.from(e.target.files)); }}
        />
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0 transition-transform active:scale-95" disabled={prog !== null} onClick={() => inputRef.current?.click()}>
          {prog !== null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Parça Ekle
        </Button>
      </div>

      {/* Yükleme göstergesi BELİRLEYİCİ (yüzde + bar + kalan süre) ve hareket azaltma açıkken de
          görünür kalır — yalnız üstündeki parıltı kapanır. */}
      {prog !== null && (
        <div className="px-3 py-2 space-y-1.5 animate-in fade-in">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
            <span className="truncate flex-1">{uploadingName}</span>
            <span className="tabular-nums font-semibold text-foreground shrink-0">{pct(prog)}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary relative overflow-hidden transition-[width] duration-200" style={{ width: `${Math.max(3, pct(prog))}%` }}>
              {!azHareket && (
                <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)", animation: "printer-shimmer 1.2s linear infinite" }} />
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/80 tabular-nums">
            <span>{fmtSize(prog.loaded)} / {fmtSize(prog.total)}</span>
            <span>
              {prog.total > 0 && prog.loaded >= prog.total
                ? "dosya işleniyor…" // PUT bitti, kayıt oluşturuluyor — bayat hız yerine dürüst durum
                : prog.bytesPerSec > 0 ? `${fmtSize(prog.bytesPerSec)}/sn · ${fmtEta(prog)}` : "başlıyor…"}
            </span>
          </div>
        </div>
      )}

      <div className="p-2 space-y-1.5">
        {parts.length === 0 ? (
          prog === null && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="group/bos w-full rounded-lg border border-dashed border-border/70 px-3 py-3.5 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CloudUpload className="mx-auto h-5 w-5 text-muted-foreground/45 transition-all duration-200 group-hover/bos:-translate-y-0.5 group-hover/bos:text-primary" />
              <p className="mt-1.5 text-[11px] text-muted-foreground/75">Henüz parça yok. Dosyayı buraya sürükle ya da tıkla.</p>
              <p className="text-[10px] text-muted-foreground/45">.gcode · .3mf</p>
            </button>
          )
        ) : (
          parts.map((part, pi) => (
            <ParcaSatiri
              key={part.id}
              part={part}
              sira={pi}
              yeni={yeniler.has(part.id)}
              okunuyor={okunanlar.has(part.id)}
              siliniyor={del.isPending && del.variables === part.id}
              onAd={(label) => patchField.mutate({ id: part.id, body: { label } })}
              onSil={() => del.mutate(part.id)}
              onIzle={() => setViewer(part)}
              onModel={(yeni) => {
                // Yerinde yama — `invalidateQueries` burada uygulamayı saniyelerce dondurur
                // (yazma sonrası okuma; uzak-HTTP libSQL'de her sorgu ~96 ms ve SIRALI).
                qc.setQueryData<ModelFile[]>(["product-models", productId], (eski) =>
                  (eski ?? []).map((r) => (r.id === part.id ? { ...r, ...yeni } : r)),
                );
              }}
            />
          ))
        )}
      </div>

      {viewer && (
        <GcodeViewerDialog
          fileId={viewer.id}
          cacheKey={vizKeyForModel(viewer)}
          name={gorunenAd(viewer)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

/** Tek parça satırı: önizleme, ad (yerinde değiştirilebilir), süre/gramaj/renk ve işlemler. */
function ParcaSatiri({ part, sira, yeni, okunuyor, siliniyor, onAd, onSil, onIzle, onModel }: {
  part: ModelFile;
  sira: number;
  yeni: boolean;
  okunuyor: boolean;
  siliniyor: boolean;
  onAd: (label: string | null) => void;
  onSil: () => void;
  onIzle: () => void;
  onModel: (yeni: { meshR2Key: string | null; meshName: string | null; meshSizeBytes: number | null }) => void;
}) {
  const [duzenle, setDuzenle] = useState(false);
  const [taslak, setTaslak] = useState("");
  const ad = gorunenAd(part);
  const dosyaAdi = uzantisizAd(part.originalName);

  const adiDuzenle = () => { setTaslak(ad); setDuzenle(true); };
  const adiKaydet = () => {
    setDuzenle(false);
    const v = taslak.trim();
    // Boş bırakmak ya da dosya adına geri dönmek = verilen adı kaldır.
    const yeniAd = v === "" || v === dosyaAdi ? null : v;
    if (yeniAd !== (part.label ?? null)) onAd(yeniAd);
  };

  return (
    <div
      className={cn(
        "group/satir flex items-center gap-3 rounded-lg border bg-background p-2 transition-[border-color,background-color,box-shadow,opacity] duration-500 hover:border-primary/30 animate-in fade-in slide-in-from-left-1",
        yeni && "border-primary/50 bg-primary/[0.05] shadow-[0_0_0_3px] shadow-primary/10",
        siliniyor && "opacity-50",
      )}
      style={{ animationDelay: `${sira * 40}ms`, animationFillMode: "both", animationDuration: "300ms" }}
    >
      {/* ÖNİZLEME: dilimleyicinin dosyaya gömdüğü görsel — yükler yüklemez görünür. */}
      <ParcaGorseli p={part} sira={sira} okunuyor={okunuyor} onClick={onIzle} />

      <div className="min-w-0 flex-1 space-y-1">
        {duzenle ? (
          <Input
            autoFocus
            value={taslak}
            maxLength={80}
            placeholder={dosyaAdi}
            onChange={(e) => setTaslak(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={adiKaydet}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); adiKaydet(); }
              if (e.key === "Escape") { e.preventDefault(); setDuzenle(false); }
            }}
            aria-label="Parça adı"
            className="h-7 text-sm px-2"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={adiDuzenle}
              title="Adı değiştir"
              className="group/ad -mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 text-left transition-colors hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate text-sm font-medium">{ad}</span>
              <Pencil className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-colors group-hover/ad:text-primary" />
            </button>
            {yeni && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary animate-in fade-in zoom-in-90 duration-300">
                <Sparkles className="h-2.5 w-2.5" /> Yeni
              </span>
            )}
          </div>
        )}

        {/* Dosyanın kendi bilgileri: tür · süre · gramaj · renkler · boyut */}
        <ParcaBilgiSatiri p={part} okunuyor={okunuyor} />

        {part.label && !duzenle && (
          <p className="truncate text-[10px] text-muted-foreground/55" title={part.originalName}>{part.originalName}</p>
        )}
      </div>

      <MeshAttachButton fileId={part.id} meshName={part.meshName ?? null} onDegisti={onModel} />
      <Button
        size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-muted-foreground transition-transform hover:text-primary active:scale-90"
        title={part.meshName ? "3B modeli izle" : "Katman katman izle"}
        onClick={onIzle}
      >
        <Box className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/60 hover:text-destructive shrink-0 transition-transform active:scale-90" disabled={siliniyor} onClick={onSil} title="Parçayı sil">
        {siliniyor ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
