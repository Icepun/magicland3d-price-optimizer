"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Smartphone, SmartphoneNfc, Send, Check, AlertTriangle } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { formatRelativeTime } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { cn } from "@/lib/utils";

interface PushStatus {
  cihazSayisi: number;
  sonKayitTarihi: string | null;
  sonKayitPlatform: string | null;
  tahminiSureMs: number;
}
interface PushTestResult {
  durum: "basarili" | "kismi" | "basarisiz" | "cihaz-yok";
  mesaj: string;
  toplamCihaz: number;
  teslimEdilen: number;
  hata: number;
  sebepler?: string[];
}

/**
 * Telefon bildirimlerinin çalışıp çalışmadığını GÖRÜNÜR kılar.
 *
 * Bugüne kadarki sorun buydu: push gitmiyorsa hiçbir yerde iz kalmıyordu; kullanıcı
 * "gelmiyor" diyor, sistem "her şey yolunda" diyordu. Kayıtlı telefon sayısı tek başına
 * sorunun nerede olduğunu söyler — 0 ise telefon hiç kaydolmamıştır, >0 ise gönderimdedir.
 */
export function PhoneNotificationsCard() {
  const queryClient = useQueryClient();
  const reduceMotion = usePrefersReducedMotion();
  const { data, isLoading } = useQuery<PushStatus>({
    queryKey: ["push-status"],
    queryFn: () => fetchJson<PushStatus>("/api/push/test"),
    staleTime: 30_000,
    refetchOnMount: true,
  });

  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<PushTestResult | null>(null);
  const timer = useRef<number | null>(null);

  const test = useMutation({
    mutationFn: () => fetchJson<PushTestResult>("/api/push/test", { method: "POST" }),
    onMutate: () => {
      setResult(null);
      setProgress(0);
    },
    onSuccess: (r) => {
      setResult(r);
      queryClient.invalidateQueries({ queryKey: ["push-status"] });
    },
    onError: () =>
      setResult({
        durum: "basarisiz",
        mesaj: "Test gönderilemedi. İnternet bağlantını kontrol et.",
        toplamCihaz: 0,
        teslimEdilen: 0,
        hata: 1,
      }),
    onSettled: () => setProgress(100),
  });

  // Gönderim ~10 saniye sürüyor ve sunucu tahmini süreyi bildiriyor → çubuk ONA göre dolar.
  // %95'te bekler; gerçek yanıt gelince tamamlanır (asla "bitti" yalanı söylemez).
  useEffect(() => {
    if (!test.isPending) return;
    const estimated = data?.tahminiSureMs ?? 10_000;
    const started = performance.now();
    const tick = () => {
      const ratio = Math.min(0.95, (performance.now() - started) / estimated);
      setProgress(ratio * 100);
      timer.current = window.setTimeout(tick, reduceMotion ? 400 : 80);
    };
    tick();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [test.isPending, data?.tahminiSureMs, reduceMotion]);

  const noDevices = data?.cihazSayisi === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {noDevices ? (
            <Smartphone className="h-4 w-4 text-amber-500" />
          ) : (
            <SmartphoneNfc className="h-4 w-4 text-emerald-500" />
          )}
          Telefon Bildirimleri
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : (
          <div
            className={cn(
              "rounded-lg border p-3 animate-in fade-in slide-in-from-bottom-1 duration-400",
              noDevices
                ? "border-amber-500/40 bg-amber-500/5"
                : "border-emerald-500/30 bg-emerald-500/5"
            )}
          >
            {noDevices ? (
              <>
                <p className="text-sm font-medium">Kayıtlı telefon yok</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Telefondaki uygulamayı aç ve bildirim izni iste. Bilgisayar kapalıyken
                  bildirim gönderilemez.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">
                  {data?.cihazSayisi} telefon kayıtlı
                </p>
                {data?.sonKayitTarihi && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Son kayıt {formatRelativeTime(data.sonKayitTarihi)}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <Button
          variant="outline"
          className="w-full"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          <Send className={cn("h-4 w-4 mr-2", test.isPending && "animate-pulse")} />
          {test.isPending ? "Gönderiliyor..." : "Test bildirimi gönder"}
        </Button>

        {test.isPending && (
          <div className="space-y-1">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-100 ease-linear"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground text-center tabular-nums">
              Telefona ulaşması bekleniyor · %{Math.round(progress)}
            </p>
          </div>
        )}

        {result && !test.isPending && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border p-3 text-sm animate-in fade-in zoom-in-95 duration-300",
              result.durum === "basarili"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-amber-500/40 bg-amber-500/5"
            )}
          >
            {result.durum === "basarili" ? (
              <Check className="h-4 w-4 shrink-0 mt-0.5 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
            )}
            <div>
              <p className="font-medium">{result.mesaj}</p>
              {!!result.sebepler?.length && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {result.sebepler.slice(0, 2).join(" · ")}
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
