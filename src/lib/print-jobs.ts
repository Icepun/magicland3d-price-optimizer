"use client";
/**
 * Arka planda baskı başlatma — kullanıcıyı modalda KİLİTLEMEZ.
 *
 * Eskiden baskı başlatma (yükleme + start akışı) modal içinde çalışıp kullanıcıyı "Yazıcıya
 * yükleniyor %99"da bekletiyordu. Artık: onayla → modal kapanır → yükleme/başlatma ARKA PLANDA
 * sürer → ilerleme yazıcı KARTINDA görünür → hata olursa POP-UP (toast). Kullanıcı bu sırada
 * başka işlerini yapar.
 *
 * Depo: React Query cache slot'u ["active-print", printerId] — startBackgroundPrint yazar,
 * kart (useActivePrint) okur. Akış modal component'ine bağlı DEĞİL (modal kapansa da promise sürer;
 * güncellemeler qc.setQueryData ile yapılır, unmount'lu component state'i değil).
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { runPrintStream, type PrintProg, type PrintPrefs } from "@/components/printers/print-flow";

export interface ActivePrint {
  stage: PrintProg["stage"] | "error";
  pct: number | null;
  label: string;
  message?: string;
  startedAt: number;
}

export const activePrintKey = (printerId: string) => ["active-print", printerId] as const;

/** Baskıyı ARKA PLANDA başlat. Çağıran hemen modalı kapatabilir. */
export function startBackgroundPrint(
  qc: QueryClient,
  opts: {
    printerId: string;
    fileId: string;
    label: string;
    printOpts?: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs };
  },
): void {
  const key = activePrintKey(opts.printerId);
  const startedAt = Date.now();
  const set = (v: ActivePrint | null) => qc.setQueryData(key, v);
  set({ stage: "upload", pct: 0, label: opts.label, startedAt });

  void runPrintStream(opts.fileId, opts.printOpts ?? {}, (p) => {
    if (p.stage === "done") return; // done → kart normal "yazdırıyor" job'a döner (aşağıda temizlenir)
    set({ stage: p.stage, pct: p.pct, label: opts.label, startedAt });
  })
    .then(() => {
      toast.success(`${opts.label} — baskı başladı 🎉`);
      set(null);
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : "Baskı başlatılamadı";
      toast.error(`${opts.label}: ${msg}`, { duration: 9000 }); // POP-UP: kullanıcı başka yerdeyken de görür
      set({ stage: "error", pct: null, label: opts.label, message: msg, startedAt });
      setTimeout(() => set(null), 12000); // hata kartta ~12sn kalır, sonra temizlenir
    });
}
