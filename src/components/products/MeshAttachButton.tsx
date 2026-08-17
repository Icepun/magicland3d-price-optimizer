"use client";
/**
 * PARÇAYA KAYNAK MODEL BAĞLA — 3B önizlemenin dilimleyicideki gibi görünmesini sağlayan dosya.
 *
 * Baskı dosyaları dilimlenmiş geldiği için içlerinde geometri yok; gerçek modeli göstermek
 * için parçaya ayrı bir STL / OBJ / proje .3mf bağlanıyor. Bağlıyken düğme vurgulu durur,
 * yanında da kaldırma düğmesi çıkar.
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Shapes, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadPartMesh, type UploadProgress } from "@/lib/upload-model";

export interface MeshAttachProps {
  fileId: string;
  /** Bağlı modelin adı — yoksa null. */
  meshName: string | null;
  /** Yükleme/kaldırma bitince satırı yerinde yamalamak için (yeniden sorgu ATILMIYOR). */
  onDegisti: (yeni: { meshR2Key: string | null; meshName: string | null; meshSizeBytes: number | null }) => void;
}

export function MeshAttachButton({ fileId, meshName, onDegisti }: MeshAttachProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [yuzde, setYuzde] = useState<number | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const bagli = !!meshName;
  const calisiyor = yuzde !== null;

  const yukle = async (f: File) => {
    setHata(null);
    setYuzde(0);
    try {
      const r = await uploadPartMesh({
        fileId,
        file: f,
        onProgress: (p: UploadProgress) =>
          setYuzde(p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0),
      });
      onDegisti({ meshR2Key: "bagli", meshName: f.name, meshSizeBytes: r.boyut });
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Model eklenemedi");
    } finally {
      setYuzde(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const kaldir = async () => {
    setHata(null);
    try {
      const r = await fetch(`/api/models/${fileId}/mesh`, { method: "DELETE" });
      if (!r.ok) throw new Error("Kaldırılamadı");
      onDegisti({ meshR2Key: null, meshName: null, meshSizeBytes: null });
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Kaldırılamadı");
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.obj,.3mf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void yukle(f); }}
      />

      <Button
        size="icon"
        variant="ghost"
        disabled={calisiyor}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "h-7 w-7 shrink-0 transition-transform active:scale-90",
          bagli ? "text-primary hover:text-primary" : "text-muted-foreground/60 hover:text-primary",
        )}
        title={
          hata ??
          (bagli
            ? `3B model bağlı: ${meshName} — değiştirmek için tıkla`
            : "3B model bağla (STL / OBJ / 3MF) — önizleme gerçek model olur")
        }
      >
        {calisiyor ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shapes className="h-3.5 w-3.5" />}
      </Button>

      {bagli && !calisiyor && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void kaldir()}
          className="h-7 w-7 shrink-0 text-muted-foreground/50 transition-transform hover:text-destructive active:scale-90"
          title="3B modeli kaldır"
        >
          <X className="h-3 w-3" />
        </Button>
      )}

      {calisiyor && (
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">%{yuzde}</span>
      )}
    </>
  );
}
