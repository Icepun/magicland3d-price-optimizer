"use client";
/**
 * Timelapse galerisi — yazıcıdaki videoları listele, izle, indir.
 *
 * Kaynaklar (canlı olarak doğrulandı):
 *  - Snapmaker U1 (Moonraker): `camera` kökü. .mp4 → gömülü OYNATILIR (Range destekli, seek çalışır).
 *  - Bambu: FTP kökündeki `timelapse` klasörü. .avi → tarayıcı oynatamaz, yalnız İNDİRİLİR
 *    (uygulama üzerinden FTPS ile çekilir; ilerleme yüzdesiyle).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Film, Download, Play, X, Loader2, Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";

interface TimelapseItem {
  name: string;
  size: number;
  modified: number | null;
  playable: boolean;
  url: string;
  thumbUrl: string | null;
}
interface TimelapseResponse {
  items: TimelapseItem[];
  offline: boolean;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
function fmtDate(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("tr-TR", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** Kart altındaki şerit — video sayısını gösterir, tıklayınca galeriyi açar. */
export function TimelapseStrip({ printerId, accent }: { printerId: string; accent?: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery<TimelapseResponse>({
    queryKey: ["timelapse", printerId],
    queryFn: () => fetchJson(`/api/printers/${printerId}/timelapse`),
    // Videolar yalnız baskı bitince oluşur → sık yoklamaya gerek yok.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const count = q.data?.items.length ?? 0;

  // Hiç video yoksa ve yazıcı çevrimiçiyse şeridi gösterme (kartı gereksiz kalabalıklaştırmasın).
  if (!q.isLoading && !q.isError && count === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={count === 0}
        className="w-full flex items-center gap-2 pt-2 mt-1 border-t border-border/50 text-[11px] text-muted-foreground hover:text-foreground transition-colors group disabled:opacity-60"
        title="Timelapse videolarını görüntüle"
      >
        <Film className="h-3.5 w-3.5 shrink-0" style={accent ? { color: accent } : undefined} />
        {q.isLoading ? (
          <Skeleton className="h-1.5 flex-1 rounded-full" />
        ) : (
          <span className="flex-1 text-left tabular-nums">
            {count} timelapse videosu
          </span>
        )}
        <Play className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
      </button>
      {open && <TimelapseDialog printerId={printerId} onClose={() => setOpen(false)} />}
    </>
  );
}

function TimelapseDialog({ printerId, onClose }: { printerId: string; onClose: () => void }) {
  const q = useQuery<TimelapseResponse>({
    queryKey: ["timelapse", printerId],
    queryFn: () => fetchJson(`/api/printers/${printerId}/timelapse`),
    staleTime: 5 * 60_000,
  });
  const [playing, setPlaying] = useState<TimelapseItem | null>(null);
  const items = q.data?.items ?? [];

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="h-4 w-4 text-primary" /> Timelapse Videoları
            {items.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {items.length} video
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {q.isLoading ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState icon={Film} title="Videolar okunamadı" description="Yazıcıya ulaşılamadı. Açık ve ağa bağlı olduğundan emin ol." />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Film}
            title="Henüz timelapse yok"
            description="Yazıcıda timelapse açıkken bir baskı tamamlandığında videolar burada görünür."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
            {items.map((it, i) => (
              <TimelapseCard
                key={it.name}
                item={it}
                delay={i * 40}
                onPlay={() => setPlaying(it)}
              />
            ))}
          </div>
        )}

        {playing && <VideoPlayer item={playing} onClose={() => setPlaying(null)} />}
      </DialogContent>
    </Dialog>
  );
}

function TimelapseCard({ item, delay, onPlay }: { item: TimelapseItem; delay: number; onPlay: () => void }) {
  const [zoom, setZoom] = useState(false);
  return (
    <div
      className="rounded-lg border bg-card overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}
    >
      <button
        onClick={item.playable ? onPlay : item.thumbUrl ? () => setZoom(true) : undefined}
        disabled={!item.playable && !item.thumbUrl}
        className={cn(
          "relative block w-full h-28 bg-muted overflow-hidden group",
          (item.playable || item.thumbUrl) && "cursor-pointer"
        )}
        title={item.playable ? "Oynat" : item.thumbUrl ? "Kapağı büyüt" : undefined}
      >
        {item.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbUrl} alt="" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground/30" />
          </div>
        )}
        {item.playable ? (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity">
            <Play className="h-8 w-8 text-white drop-shadow" />
          </span>
        ) : item.thumbUrl ? (
          // Bambu .avi oynatılamaz → kapak büyütülebilir (ne olduğunu indirmeden görmek için).
          <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity">
            <Maximize2 className="h-6 w-6 text-white drop-shadow" />
          </span>
        ) : null}
      </button>
      {zoom && item.thumbUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 animate-in fade-in duration-200"
          onClick={() => setZoom(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.thumbUrl} alt={item.name} className="max-w-[90vw] max-h-[85vh] rounded-lg shadow-2xl" />
        </div>
      )}
      <div className="p-2.5 space-y-1.5">
        <div className="text-xs font-medium line-clamp-1" title={item.name}>{item.name}</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {fmtSize(item.size)}
            {item.modified ? ` · ${fmtDate(item.modified)}` : ""}
          </span>
          <DownloadButton item={item} />
        </div>
      </div>
    </div>
  );
}

/** İndirme — Bambu'da video uygulama üzerinden FTPS ile çekildiği için ilerleme yüzdesi gösterilir
 *  (yoksa butona basıp saniyelerce hiçbir şey olmuyormuş gibi görünüyordu). */
function DownloadButton({ item }: { item: TimelapseItem }) {
  const [pct, setPct] = useState<number | null>(null);

  const download = async () => {
    if (pct != null) return;
    setPct(0);
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(String(res.status));
      const total = Number(res.headers.get("content-length")) || item.size || 0;
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            if (total > 0) setPct(Math.min(99, Math.round((received / total) * 100)));
          }
        }
      }
      const blob = new Blob(chunks as BlobPart[], { type: "video/x-msvideo" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = item.name;
      a.click();
      URL.revokeObjectURL(href);
      setPct(100);
      setTimeout(() => setPct(null), 800);
    } catch {
      setPct(null);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2 text-[11px] shrink-0"
      onClick={download}
      disabled={pct != null}
    >
      {pct == null ? (
        <><Download className="h-3 w-3 mr-1" /> İndir</>
      ) : pct >= 100 ? (
        "Bitti ✓"
      ) : (
        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /><span className="tabular-nums">%{pct}</span></>
      )}
    </Button>
  );
}

function VideoPlayer({ item, onClose }: { item: TimelapseItem; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div className="relative max-w-4xl w-full px-4" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-9 right-4 text-white/80 hover:text-white transition-colors"
          aria-label="Kapat"
        >
          <X className="h-6 w-6" />
        </button>
        <video src={item.url} controls autoPlay className="w-full rounded-lg shadow-2xl max-h-[80vh] bg-black" />
        <div className="mt-2 text-center text-xs text-white/70">{item.name}</div>
      </div>
    </div>
  );
}
