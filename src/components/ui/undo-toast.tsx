"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Undo2, CircleCheck } from "lucide-react";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { cn } from "@/lib/utils";

/**
 * "Geri al" bildirimi — projedeki sonner bildirim altyapısının ÜSTÜNE kurulur (yeni bir
 * bildirim sistemi yazılmaz; Toaster zaten kökte mount edilmiş durumda).
 *
 * NEDEN: yıkıcı işlemlerin tek koruması onay penceresiydi; yanlış tıklanan stok "−" sessizce
 * kaydediliyordu. Artık başarı bildirimi 5 saniye boyunca geri alma sunar ve kalan süre
 * daralan bir çubukla görünür (belirsiz bekleme yok).
 */

/** Geri alma penceresi. */
export const UNDO_WINDOW_MS = 5_000;

export interface UndoCountdown {
  /** Ekranda gösterilen kalan saniye (5 → 1). */
  remainingSeconds: number;
  /** Kalan sürenin yüzdesi (100 → 0) — çubuğun genişliği. */
  percent: number;
  expired: boolean;
}

/**
 * Geri sayımın SAF hâli — bileşenden bağımsız test edilebilsin diye ayrı.
 * Süre dolmadan asla 0 saniye yazmaz: "0 sn kaldı" yazan bir düğme hâlâ tıklanabilirse
 * kullanıcıya yalan söylemiş oluruz.
 */
export function undoCountdown(elapsedMs: number, totalMs: number = UNDO_WINDOW_MS): UndoCountdown {
  const total = totalMs > 0 ? totalMs : UNDO_WINDOW_MS;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const remaining = Math.max(0, total - elapsed);
  return {
    remainingSeconds: remaining > 0 ? Math.max(1, Math.ceil(remaining / 1000)) : 0,
    percent: Math.max(0, Math.min(100, (remaining / total) * 100)),
    expired: remaining <= 0,
  };
}

export interface UndoToastOptions {
  /** Tek satır, sade Türkçe: "Stok 4 → 3 yapıldı". */
  message: string;
  /** Geri alma işini yapan çağrı. Hata fırlatırsa kullanıcıya bildirilir. */
  onUndo: () => void | Promise<void>;
  /** Geri alma sonrası gösterilecek onay metni. */
  undoneMessage?: string;
  durationMs?: number;
}

function UndoToastBody({
  message,
  durationMs,
  onUndo,
  onDismiss,
}: {
  message: string;
  durationMs: number;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      if (startedAt.current == null) startedAt.current = now;
      const passed = now - startedAt.current;
      setElapsed(passed);
      if (passed >= durationMs) {
        onDismiss();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, onDismiss]);

  const { remainingSeconds, percent } = undoCountdown(elapsed, durationMs);

  return (
    <div className="cn-toast flex w-full items-center gap-3 rounded-[var(--border-radius)] border bg-[var(--popover)] px-4 py-3 text-[var(--popover-foreground)] shadow-lg">
      <CircleCheck className="h-4 w-4 shrink-0 text-green-500" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{message}</p>
        {/* Kalan süre: determinate — kullanıcı ne kadar vakti kaldığını görür. */}
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full bg-primary/70",
              // Hareket tercihi kapalıysa akıcı daralt; açıksa adım adım güncellensin.
              !reduceMotion && "transition-[width] duration-100 ease-linear"
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={onUndo}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-muted active:scale-[0.97] tabular-nums"
      >
        <Undo2 className="h-3.5 w-3.5" />
        Geri al · {remainingSeconds}
      </button>
    </div>
  );
}

/**
 * Başarı bildirimini 5 saniyelik "Geri al" düğmesiyle gösterir.
 * Geri alma bir kez çalışır; süre dolunca bildirim kendiliğinden kapanır.
 */
export function undoToast({
  message,
  onUndo,
  undoneMessage = "Geri alındı",
  durationMs = UNDO_WINDOW_MS,
}: UndoToastOptions): void {
  let used = false;
  toast.custom(
    (toastId) => (
      <UndoToastBody
        message={message}
        durationMs={durationMs}
        onDismiss={() => toast.dismiss(toastId)}
        onUndo={() => {
          if (used) return;
          used = true;
          toast.dismiss(toastId);
          void (async () => {
            try {
              await onUndo();
              toast.success(undoneMessage);
            } catch {
              toast.error("Geri alınamadı");
            }
          })();
        }}
      />
    ),
    // Kapanmayı bileşenin kendi geri sayımı yönetir; buradaki süre yalnız emniyet payıdır.
    { duration: durationMs + 500 }
  );
}
