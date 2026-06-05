"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Smartphone, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { imageSrcToDataUrl } from "@/lib/image-resize";

interface Prod {
  id: string;
  imageUrl: string | null;
}

/**
 * Elle yüklenmiş ESKİ görselleri (yerel dosya + "/api/images/.." URL'i — yalnız bu bilgisayarda açılır)
 * data URL'sine çevirir → DB'de durur, mobil/diğer cihazlar da görür. Bu bilgisayarın yerel dosyasını
 * okuduğu için yalnız görselin DURDUĞU makinede çalışır (başka makinede dosya yoksa atlanır).
 * Dönüştürülecek görsel kalmazsa kart kendini gizler.
 */
export function ImageMobileFixCard() {
  const qc = useQueryClient();
  const { data: products = [] } = useQuery<Prod[]>({
    queryKey: ["products", "all"],
    queryFn: () => fetch("/api/products?filter=all").then((r) => r.json()),
    staleTime: 60_000,
  });
  const localImages = (Array.isArray(products) ? products : []).filter(
    (p) => typeof p.imageUrl === "string" && p.imageUrl.startsWith("/api/images/")
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function run() {
    if (busy || localImages.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: localImages.length });
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < localImages.length; i++) {
      const p = localImages[i];
      try {
        const dataUrl = await imageSrcToDataUrl(p.imageUrl as string);
        const res = await fetch(`/api/products/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: dataUrl, imageManual: true }),
        });
        if (!res.ok) throw new Error("patch");
        ok++;
      } catch {
        fail++;
      }
      setProgress({ done: i + 1, total: localImages.length });
    }
    setBusy(false);
    setProgress(null);
    qc.invalidateQueries({ queryKey: ["products"] });
    if (ok > 0) toast.success(`${ok} görsel tüm cihazlara taşındı`);
    if (fail > 0) toast.error(`${fail} görsel dönüştürülemedi (dosyası bu bilgisayarda yoksa atlandı)`);
  }

  if (localImages.length === 0) return null; // hepsi uyumlu → kartı gösterme

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-amber-500" /> Mobil görsel uyumu
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Elle yüklediğin <strong className="text-foreground tabular-nums">{localImages.length}</strong> görsel
          yalnızca bu bilgisayarda saklanıyor; telefonda görünmüyor. Tek tıkla tüm cihazlara taşı.
        </p>
        <Button onClick={run} disabled={busy} className="gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {busy && progress
            ? `Dönüştürülüyor ${progress.done}/${progress.total}…`
            : `${localImages.length} görseli mobil uyumlu yap`}
        </Button>
      </CardContent>
    </Card>
  );
}
