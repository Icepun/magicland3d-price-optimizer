"use client";

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileBox, Upload, Trash2, Loader2, Printer, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface PrinterCfg { id: string; name: string; brand: string; model: string | null; type: string }
interface ModelFile { id: string; printerConfigId: string; originalName: string; sizeBytes: number; gramaj: number | null; fileType: string }

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

export function ModelFilesCard({ productId }: { productId: string }) {
  const qc = useQueryClient();
  const { data: printers = [] } = useQuery<PrinterCfg[]>({
    queryKey: ["printer-configs"],
    queryFn: () => fetch("/api/printers/config").then((r) => r.json()),
  });
  const { data: files = [] } = useQuery<ModelFile[]>({
    queryKey: ["product-models", productId],
    queryFn: () => fetch(`/api/products/${productId}/models`).then((r) => r.json()),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["product-models", productId] });
    qc.invalidateQueries({ queryKey: ["models"] });
  };

  const del = useMutation({
    mutationFn: (fileId: string) => fetch(`/api/models/${fileId}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => { refresh(); toast.success("Dosya silindi"); },
    onError: () => toast.error("Silinemedi"),
  });

  const byPrinter = new Map((files ?? []).map((f) => [f.printerConfigId, f]));

  return (
    <Card>
      <CardHeader className="pb-3 border-b border-border/50">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileBox className="h-4 w-4 text-primary" /> Baskı Dosyaları (Modeller)
          {files.length > 0 && <Badge variant="outline" className="ml-1 tabular-nums">{files.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3 space-y-2">
        {printers.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1.5">
            Önce <span className="font-medium text-foreground">Yazıcılar → Yönet</span>'ten yazıcı ekle; sonra her yazıcı için dilimlenmiş dosyayı buraya yükle. Yazıcı sayfasından tek tıkla baskı alırsın.
          </p>
        ) : (
          printers.map((p) => (
            <PrinterRow
              key={p.id}
              printer={p}
              file={byPrinter.get(p.id) ?? null}
              productId={productId}
              onChanged={refresh}
              onDelete={(fid) => del.mutate(fid)}
              deleting={del.isPending}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function PrinterRow({
  printer, file, productId, onChanged, onDelete, deleting,
}: {
  printer: PrinterCfg; file: ModelFile | null; productId: string;
  onChanged: () => void; onDelete: (fileId: string) => void; deleting: boolean;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("printerConfigId", printer.id);
      const res = await fetch(`/api/products/${productId}/models`, { method: "POST", body: fd });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Yüklenemedi");
      }
      toast.success(`${printer.name}: dosya yüklendi`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Yüklenemedi");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const saveGramaj = useMutation({
    mutationFn: (g: string) =>
      fetch(`/api/models/${file!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gramaj: g === "" ? null : Number(g) }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-models", productId] }),
  });

  return (
    <div className="flex items-center gap-2.5 rounded-lg border p-2">
      <div className="flex items-center justify-center h-8 w-8 rounded-md bg-muted shrink-0">
        <Printer className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{printer.name}</p>
        {file ? (
          <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" /> {file.originalName} · {fmtSize(file.sizeBytes)}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground/60">Dosya yok</p>
        )}
      </div>
      {file && (
        <Input
          defaultValue={file.gramaj ?? ""}
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(file.gramaj ?? "")) saveGramaj.mutate(v); }}
          placeholder="gr"
          className="h-7 w-14 text-xs shrink-0"
          inputMode="numeric"
          title="Filament gramajı (maliyet / makara düşümü için)"
        />
      )}
      <input ref={inputRef} type="file" accept=".gcode,.gco,.g,.3mf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      <Button size="sm" variant={file ? "ghost" : "outline"} className="h-7 gap-1 text-xs shrink-0" disabled={uploading} onClick={() => inputRef.current?.click()}>
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {file ? "Değiştir" : "Yükle"}
      </Button>
      {file && (
        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/70 hover:text-destructive shrink-0" disabled={deleting} onClick={() => onDelete(file.id)} title="Sil">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
