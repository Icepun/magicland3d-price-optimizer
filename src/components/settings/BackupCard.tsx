"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldCheck, ShieldAlert, HardDriveDownload, Check } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface BackupFile {
  name: string;
  at: string;
  size: number;
}
interface BackupsResponse {
  enabled: boolean;
  lastBackupAt: string | null;
  keep: number;
  totalBytes: number;
  backups: BackupFile[];
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Yedeklerin GERÇEKTEN alındığını gösteren kart.
 *
 * Eskiden Ayarlar'da "otomatik günlük yedek alınır" yazıyordu ama böyle bir yedek yoktu —
 * kullanıcı korunduğunu sanıyordu. Artık son yedeğin ne zaman alındığı yazılı; alınmadıysa
 * bunu açıkça söylüyor.
 */
export function BackupCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, dataUpdatedAt } = useQuery<BackupsResponse>({
    queryKey: ["backups"],
    queryFn: () => fetchJson<BackupsResponse>("/api/backups"),
    staleTime: 60_000,
    refetchOnMount: true,
  });

  const backupNow = useMutation({
    mutationFn: () => fetchJson<{ ok: boolean }>("/api/backups", { method: "POST" }),
    onSuccess: () => {
      toast.success("Yedek alındı");
      queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Yedek alınamadı, birazdan tekrar dene."),
  });

  // "Şimdi" olarak verinin geldiği anı kullanıyoruz (render sırasında Date.now() çağırmak
  // saf olmayan bir işlem; her render'da farklı sonuç üretip kararsızlığa yol açar).
  const stale =
    !!data?.lastBackupAt &&
    dataUpdatedAt - new Date(data.lastBackupAt).getTime() > 48 * 60 * 60 * 1000;
  const healthy = !!data?.enabled && !!data?.lastBackupAt && !stale;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {healthy ? (
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-500" />
          )}
          Otomatik Yedek
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : !data?.enabled ? (
          <p className="text-sm text-amber-400">
            Bu bilgisayarda otomatik yedek kapalı. Aşağıdan elle yedek alabilirsin.
          </p>
        ) : (
          <div
            className={cn(
              "rounded-lg border p-3 animate-in fade-in slide-in-from-bottom-1 duration-400",
              healthy
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-amber-500/40 bg-amber-500/5"
            )}
          >
            <p className="text-sm font-medium">
              {data.lastBackupAt ? (
                <>Son yedek {formatRelativeTime(data.lastBackupAt)}</>
              ) : (
                <>Henüz yedek alınmadı</>
              )}
            </p>
            {data.lastBackupAt && (
              <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                {formatDateTime(data.lastBackupAt)} · günde bir alınır, son {data.keep} yedek saklanır
              </p>
            )}
            {stale && (
              <p className="text-xs text-amber-400 mt-1.5">
                İki günden uzun süredir yedek alınmadı.
              </p>
            )}
          </div>
        )}

        <Button
          variant="outline"
          className="w-full"
          disabled={backupNow.isPending}
          onClick={() => backupNow.mutate()}
        >
          {backupNow.isPending ? (
            <>
              <HardDriveDownload className="h-4 w-4 mr-2 animate-pulse" />
              Yedek alınıyor...
            </>
          ) : backupNow.isSuccess ? (
            <>
              <Check className="h-4 w-4 mr-2 text-emerald-500" />
              Yedek alındı
            </>
          ) : (
            <>
              <HardDriveDownload className="h-4 w-4 mr-2" />
              Şimdi yedekle
            </>
          )}
        </Button>

        {!!data?.backups?.length && (
          <div className="space-y-1 border-t border-border/50 pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                Son yedekler
              </p>
              <p className="text-[11px] text-muted-foreground/70 tabular-nums">
                {data.backups.length} dosya · {formatSize(data.totalBytes ?? 0)}
              </p>
            </div>
            {data.backups.slice(0, 4).map((b, i) => (
              <div
                key={b.name}
                className="flex items-center justify-between gap-2 text-xs animate-in fade-in slide-in-from-left-1 duration-300"
                style={{ animationDelay: `${i * 50}ms`, animationFillMode: "both" }}
              >
                <span className="text-muted-foreground tabular-nums">
                  {formatDateTime(b.at)}
                </span>
                <span className="text-muted-foreground/70 tabular-nums">{formatSize(b.size)}</span>
              </div>
            ))}
            {data.backups.length > 4 && (
              <p className="text-[11px] text-muted-foreground/60 pt-0.5">
                ve {data.backups.length - 4} yedek daha
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
