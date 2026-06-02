"use client";
/* eslint-disable @next/next/no-img-element */

import { useRef, useState } from "react";
import { Upload, Link2, Loader2, RotateCcw, Check, ImageIcon, Package } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

/**
 * Ürün/varyant görselini elle ayarla: bilgisayardan yükle YA DA URL yapıştır.
 * Kaydedince imageManual=true olur → sync (Yenile) bu görseli EZMEZ. "Sıfırla" ise
 * imageManual=false yapıp görseli temizler → sonraki Yenile Shopify görselini geri koyar.
 * Kontrollü (open/onClose) — host kendi tetikleyicisini ve cache güncellemesini yönetir.
 */
export function ProductImageEditorDialog({
  productId,
  imageUrl,
  productName,
  onChanged,
  onClose,
}: {
  productId: string;
  imageUrl: string | null;
  productName: string;
  onChanged: (url: string | null) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(imageUrl ?? "");
  const [busy, setBusy] = useState<null | "upload" | "url" | "reset">(null);

  async function uploadFile(file: File) {
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/products/${productId}/image`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Yüklenemedi");
      onChanged(data.imageUrl as string);
      toast.success("Görsel güncellendi 🎉");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Yüklenemedi");
    } finally {
      setBusy(null);
    }
  }

  async function patchImage(next: string | null, manual: boolean, label: "url" | "reset") {
    setBusy(label);
    try {
      const res = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: next, imageManual: manual }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Kaydedilemedi");
      }
      onChanged(next);
      toast.success(label === "reset" ? "Görsel sıfırlandı (Yenile'de Shopify'dan gelir)" : "Görsel güncellendi 🎉");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kaydedilemedi");
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <Dialog open onOpenChange={(o) => !o && !anyBusy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" /> Görsel düzenle
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{productName}</p>
        </DialogHeader>

        {/* Önizleme */}
        <div className="flex justify-center">
          <div className="h-28 w-28 rounded-xl border bg-muted flex items-center justify-center overflow-hidden">
            {url ? (
              <img src={url} alt="" className="max-w-full max-h-full object-contain" />
            ) : (
              <Package className="h-8 w-8 text-muted-foreground/40" />
            )}
          </div>
        </div>

        <div className="space-y-3">
          {/* Yükle */}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
              e.target.value = "";
            }}
          />
          <Button className="w-full gap-2" disabled={anyBusy} onClick={() => fileRef.current?.click()}>
            {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Bilgisayardan yükle
          </Button>

          {/* URL */}
          <div>
            <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Link2 className="h-3 w-3" /> veya görsel URL'si
            </Label>
            <div className="flex gap-1.5 mt-1">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className="h-9"
                disabled={anyBusy}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url.trim()) patchImage(url.trim(), true, "url");
                }}
              />
              <Button
                size="icon"
                variant="outline"
                className="h-9 w-9 shrink-0"
                disabled={anyBusy || !url.trim() || url.trim() === (imageUrl ?? "")}
                onClick={() => patchImage(url.trim(), true, "url")}
                title="URL'yi kaydet"
              >
                {busy === "url" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Sıfırla */}
          {imageUrl && (
            <Button
              variant="ghost"
              className="w-full gap-2 text-muted-foreground hover:text-foreground"
              disabled={anyBusy}
              onClick={() => patchImage(null, false, "reset")}
            >
              {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Sıfırla (Shopify'a bırak)
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
