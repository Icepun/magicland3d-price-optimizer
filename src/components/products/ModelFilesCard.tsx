"use client";

import { memo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileBox, Upload, Trash2, Loader2, Printer, Check, Layers, Box, AlertTriangle, RefreshCw } from "lucide-react";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";
import { setUploadsActive } from "@/lib/gcode-viz/viz-uploads";

// three.js yalnız izleyici açılınca yüklensin (bundle şişmesin).
const GcodeViewerDialog = dynamic(() => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog), { ssr: false });
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { uploadProductModel, type UploadProgress } from "@/lib/upload-model";

interface PrinterCfg { id: string; name: string; brand: string; model: string | null; type: string }
interface VariantGroupLite { id: string; name: string; shareModels?: boolean; products: { id: string }[] }
interface ModelFile { id: string; printerConfigId: string; label: string | null; originalName: string; sizeBytes: number; gramaj: number | null; fileType: string; sortOrder: number; contentMd5?: string | null; thumbnail?: string | null }

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
        className="h-7 gap-1.5 text-xs shrink-0"
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
  // fetchJson: HTTP hatasında fırlatır. Eski hâlinde hata gövdesi de "veri" sayılıyor, liste boş
  // kalıyor ve kart "Henüz parça yok" diyordu — yüklü dosyalar yokmuş gibi görünüyordu.
  const printersQuery = useQuery<PrinterCfg[]>({
    queryKey: ["printer-configs"],
    queryFn: () => fetchJson<PrinterCfg[]>("/api/printers/config"),
  });
  const filesQuery = useQuery<ModelFile[]>({
    queryKey: ["product-models", productId],
    queryFn: () => fetchJson<ModelFile[]>(`/api/products/${productId}/models`),
  });
  const printers = Array.isArray(printersQuery.data) ? printersQuery.data : [];
  const files = Array.isArray(filesQuery.data) ? filesQuery.data : [];
  const yaziciDurumu = veriDurumu(printersQuery.isLoading, printersQuery.isError, printers.length);
  const dosyaDurumu = veriDurumu(filesQuery.isLoading, filesQuery.isError, files.length);

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
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500" style={{ animationFillMode: "both" }}>
      <CardHeader className="pb-3 border-b border-border/50">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileBox className="h-4 w-4 text-primary" /> Baskı Dosyaları (Modeller)
          {files.length > 0 && <Badge variant="outline" className="ml-1 tabular-nums">{files.length} parça</Badge>}
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
              "w-full flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors disabled:opacity-70",
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
                  ? `Yüklediğin her dosya ${memberCount} varyantın hepsine eklenir — bu ayar kayıtlı kalır.`
                  : `Dosyalar yalnızca bu varyanta eklenir. Aç → ${memberCount} varyanta birden uygulanır (aynı model, farklı renk).`}
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
          <p className="text-xs text-muted-foreground py-1.5">
            Önce <span className="font-medium text-foreground">Yazıcılar → Yönet</span>&apos;ten yazıcı ekle; sonra her yazıcı için parça parça dosya yükle. Çok parçalı ürünlerde tüm parçaları ekleyebilirsin.
          </p>
        ) : (
          printers.map((p) => (
            <PrinterGroup
              key={p.id}
              printer={p}
              parts={files.filter((f) => f.printerConfigId === p.id)}
              productId={productId}
              applyToVariants={shareOn}
              onChanged={refresh}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function PrinterGroup({ printer, parts, productId, applyToVariants, onChanged }: { printer: PrinterCfg; parts: ModelFile[]; productId: string; applyToVariants: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [prog, setProg] = useState<UploadProgress | null>(null);
  const [uploadingName, setUploadingName] = useState("");
  const [viewer, setViewer] = useState<ModelFile | null>(null);

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
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      const r = await fetch(`/api/models/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Kaydedilemedi");
      return r.json().catch(() => null);
    },
    // Optimistic: etiket/gramaj cache'te anında güncellenir → REFETCH YOK. (Eski refetch, blur'da
    // yazdığın değeri uncontrolled input'ta eziyordu + ağır.) Hata olursa geri alınır.
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
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["models"], refetchType: "none" });
      // Etiket/gramaj değişimi "Baskı Başlat" seçicisinde de görünsün (çapraz-sayfa tazelik).
      // Bu invalidate olmadan seçici staleTime'ı düşürülürse düzenlenen değer bayat kalırdı.
      qc.invalidateQueries({ queryKey: ["printable-models"] });
    },
  });

  const handleFiles = async (fileList: FileList) => {
    const list = Array.from(fileList);
    let ok = 0;
    const created: ModelFile[] = [];
    setUploadsActive(1); // arka plan görselleştirme üretimi bu yükleme boyunca beklesin
    try {
      for (const f of list) {
        setUploadingName(f.name);
        setProg({ loaded: 0, total: f.size, bytesPerSec: 0 });
        try {
          const row = await uploadProductModel({ productId, printerConfigId: printer.id, file: f, applyToVariants, onProgress: setProg });
          if (row && typeof row === "object") created.push(row as ModelFile);
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
    // NOT: görselleştirme varlıkları burada ÜRETİLMEZ (eski hali yüklemeyi kilitliyordu) —
    // thumbnail ilk baskıda / 3D izleyici açılınca; inşa kareleri baskı başlayınca oluşur.
    if (created.length) {
      qc.setQueryData<ModelFile[]>(["product-models", productId], (old) =>
        Array.isArray(old) ? [...old, ...created] : created
      );
      // Yazıcılar → "Baskı Başlat" ürün listesi bu yeni modeli görsün (çapraz-sayfa tazelik).
      qc.invalidateQueries({ queryKey: ["printable-models"] });
    }
    onChanged();
    if (inputRef.current) inputRef.current.value = "";
    if (ok > 0) toast.success(`${printer.name}: ${ok} parça yüklendi${applyToVariants ? " · tüm varyantlara" : ""}`);
  };

  return (
    <div className="rounded-xl border bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-border/40 bg-muted/30">
        <div className="flex items-center justify-center h-7 w-7 rounded-md bg-background border shrink-0">
          <Printer className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium flex-1 truncate">{printer.name}</p>
        {parts.length > 0 && <Badge variant="secondary" className="tabular-nums text-[10px]">{parts.length} parça</Badge>}
        <input ref={inputRef} type="file" accept=".gcode,.gco,.g,.3mf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); }} />
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0" disabled={prog !== null} onClick={() => inputRef.current?.click()}>
          {prog !== null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Parça Ekle
        </Button>
      </div>

      {prog !== null && (
        <div className="px-3 py-2 space-y-1.5 animate-in fade-in">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
            <span className="truncate flex-1">{uploadingName}</span>
            <span className="tabular-nums font-semibold text-foreground shrink-0">{pct(prog)}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary relative overflow-hidden transition-[width] duration-200" style={{ width: `${Math.max(3, pct(prog))}%` }}>
              <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)", animation: "printer-shimmer 1.2s linear infinite" }} />
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
          <p className="text-[11px] text-muted-foreground/60 px-1 py-1">Henüz parça yok. Tek parçalıysa bir dosya, çok parçalıysa her parçayı ekle.</p>
        ) : (
          parts.map((part, pi) => (
            <div
              key={part.id}
              className="flex items-center gap-2 rounded-lg border bg-background p-1.5 animate-in fade-in slide-in-from-left-1 duration-300"
              style={{ animationDelay: `${pi * 40}ms`, animationFillMode: "both" }}
            >
              <span className="flex items-center justify-center h-6 w-6 rounded bg-primary/10 text-primary text-[11px] font-bold tabular-nums shrink-0">{pi + 1}</span>
              <div className="min-w-0 flex-1">
                <Input
                  defaultValue={part.label ?? ""}
                  placeholder={part.originalName}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (part.label ?? "")) patchField.mutate({ id: part.id, body: { label: v === "" ? null : v } }); }}
                  className="h-6 text-xs border-0 px-1 shadow-none focus-visible:ring-1"
                  title="Parça adı (örn. Gövde, Kapak)"
                />
                <p className="text-[10px] text-muted-foreground/70 truncate px-1">{part.originalName} · {fmtSize(part.sizeBytes)}</p>
              </div>
              <Button
                size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-primary"
                title="3D önizleme — katman katman izle"
                onClick={() => setViewer(part)}
              >
                <Box className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/60 hover:text-destructive shrink-0" disabled={del.isPending} onClick={() => del.mutate(part.id)} title="Parçayı sil">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>

      {viewer && (
        <GcodeViewerDialog
          fileId={viewer.id}
          cacheKey={vizKeyForModel(viewer)}
          name={viewer.label || viewer.originalName}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
