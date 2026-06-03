"use client";

import { memo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileBox, Upload, Trash2, Loader2, Printer, Check, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface PrinterCfg { id: string; name: string; brand: string; model: string | null; type: string }
interface VariantGroupLite { id: string; name: string; products: { id: string }[] }
interface ModelFile { id: string; printerConfigId: string; label: string | null; originalName: string; sizeBytes: number; gramaj: number | null; fileType: string; sortOrder: number }

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/** XHR ile yükle — gerçek upload progress için (fetch progress vermiyor). */
function uploadPart(productId: string, printerConfigId: string, file: File, onProgress: (p: number) => void, applyToVariants = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", file);
    fd.append("printerConfigId", printerConfigId);
    if (applyToVariants) fd.append("applyToVariants", "true");
    xhr.open("POST", `/api/products/${productId}/models`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `HTTP ${xhr.status}`;
        try { const b = JSON.parse(xhr.responseText); if (b.error) msg = b.error; } catch { /* ignore */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Ağ hatası"));
    xhr.send(fd);
  });
}

// memo: detay cache'i (madeToOrder/maliyet) değişince gereksiz render olmasın — yalnız productId'ye bağlı.
export const ModelFilesCard = memo(ModelFilesCardImpl);
function ModelFilesCardImpl({ productId, variantGroup }: { productId: string; variantGroup?: VariantGroupLite | null }) {
  const qc = useQueryClient();
  const { data: printers = [] } = useQuery<PrinterCfg[]>({
    queryKey: ["printer-configs"],
    queryFn: () => fetch("/api/printers/config").then((r) => r.json()),
  });
  const { data: files = [] } = useQuery<ModelFile[]>({
    queryKey: ["product-models", productId],
    queryFn: () => fetch(`/api/products/${productId}/models`).then((r) => r.json()),
  });

  const memberCount = variantGroup?.products?.length ?? 0;
  const inGroup = memberCount >= 2;
  const [applyToVariants, setApplyToVariants] = useState(false);
  const shareOn = inGroup && applyToVariants;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["product-models", productId] });
    // Paylaşımlı yükleme diğer varyantların listesini de değiştirir → hepsini bayat işaretle.
    qc.invalidateQueries({ queryKey: ["product-models"], refetchType: "none" });
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
            onClick={() => setApplyToVariants((v) => !v)}
            className={cn(
              "w-full flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
              shareOn ? "border-primary/40 bg-primary/[0.06]" : "border-dashed hover:bg-muted/40"
            )}
          >
            <span className={cn("flex items-center justify-center h-5 w-5 rounded border shrink-0 transition-colors", shareOn ? "bg-primary border-primary" : "border-border")}>
              {shareOn && <Check className="h-3.5 w-3.5 text-primary-foreground" />}
            </span>
            <Layers className="h-4 w-4 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">Tüm varyantlara uygula</p>
              <p className="text-[11px] text-muted-foreground">Yüklediğin dosya bu ürünün {memberCount} varyantının hepsinde görünür. Aynı model, farklı renk için idealdir.</p>
            </div>
          </button>
        )}
        {printers.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1.5">
            Önce <span className="font-medium text-foreground">Yazıcılar → Yönet</span>'ten yazıcı ekle; sonra her yazıcı için parça parça dosya yükle. Çok parçalı ürünlerde tüm parçaları ekleyebilirsin.
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
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadingName, setUploadingName] = useState("");

  const del = useMutation({
    mutationFn: (fileId: string) => fetch(`/api/models/${fileId}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => { onChanged(); toast.success("Parça silindi"); },
    onError: () => toast.error("Silinemedi"),
  });

  const patchField = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      fetch(`/api/models/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
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
    onSettled: () => qc.invalidateQueries({ queryKey: ["models"], refetchType: "none" }),
  });

  const handleFiles = async (fileList: FileList) => {
    const list = Array.from(fileList);
    let ok = 0;
    for (const f of list) {
      setUploadingName(f.name);
      setProgress(0);
      try {
        await uploadPart(productId, printer.id, f, (p) => setProgress(p), applyToVariants);
        ok++;
      } catch (e) {
        toast.error(`${f.name}: ${e instanceof Error ? e.message : "yüklenemedi"}`);
      }
    }
    setProgress(null);
    setUploadingName("");
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
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0" disabled={progress !== null} onClick={() => inputRef.current?.click()}>
          {progress !== null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Parça Ekle
        </Button>
      </div>

      {progress !== null && (
        <div className="px-3 py-2 space-y-1 animate-in fade-in">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="truncate">{uploadingName}</span>
            <span className="tabular-nums font-medium">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary relative overflow-hidden transition-[width] duration-200" style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}>
              <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)", animation: "printer-shimmer 1.2s linear infinite" }} />
            </div>
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
              <Input
                defaultValue={part.gramaj ?? ""}
                placeholder="gr"
                inputMode="numeric"
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(part.gramaj ?? "")) patchField.mutate({ id: part.id, body: { gramaj: v === "" ? null : Number(v) } }); }}
                className="h-7 w-12 text-xs shrink-0"
                title="Filament gramajı (maliyet / makara için)"
              />
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/60 hover:text-destructive shrink-0" disabled={del.isPending} onClick={() => del.mutate(part.id)} title="Parçayı sil">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
