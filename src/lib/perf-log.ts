"use client";

/**
 * Hafif performans olay tamponu (ring buffer). Performans İzleme açıkken (Ctrl+Shift+L)
 * dolar; kapalıyken HİÇBİR gözlemci kurulmaz → normal kullanımda sıfır ek yük.
 *
 * Yakaladıkları: ağ istekleri (süre + boyut + cache mi ağ mı), React Query sorgu/mutation
 * süreleri, uzun görevler (donma/drop), sayfa geçiş süreleri, FPS düşüşleri.
 */
export type PerfKind = "fetch" | "query" | "mutation" | "longtask" | "nav" | "fps";

export interface PerfEvent {
  id: number;
  t: number; // performance.now()
  wall: string; // HH:MM:SS.mmm
  kind: PerfKind;
  label: string;
  ms?: number; // süre
  bytes?: number; // transfer boyutu (0 = cache'ten geldi)
  detail?: string;
}

const MAX = 800;
const buf: PerfEvent[] = [];
let seq = 0;
const subs = new Set<() => void>();

function wallClock(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function pushPerf(e: Omit<PerfEvent, "id" | "t" | "wall">): void {
  buf.push({ id: ++seq, t: performance.now(), wall: wallClock(), ...e });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  for (const s of subs) s();
}

export function perfBuffer(): readonly PerfEvent[] {
  return buf;
}

export function clearPerf(): void {
  buf.length = 0;
  for (const s of subs) s();
}

export function subscribePerf(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Panoya kopyalanacak düz-metin döküm (kullanıcı bana yapıştırır). */
export function formatPerfLog(): string {
  const head = `# Magicland Hub — Performans Logu (${buf.length} olay)\n# kind | süre | boyut | etiket\n`;
  const lines = buf.map((e) => {
    const ms = e.ms != null ? `${e.ms.toFixed(0)}ms` : "";
    const kb =
      e.bytes != null ? `${(e.bytes / 1024).toFixed(1)}KB${e.bytes === 0 ? "✓cache" : ""}` : "";
    return `${e.wall}  ${e.kind.padEnd(8)} ${ms.padStart(7)} ${kb.padStart(10)}  ${e.label}${
      e.detail ? ` · ${e.detail}` : ""
    }`;
  });
  return head + lines.join("\n");
}
