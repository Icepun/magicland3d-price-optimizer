import { useSyncExternalStore } from "react";

/**
 * Global "meşgul" sayacı — mutation OLMAYAN async yazma/işlemleri (ör. plain fetch) global
 * loading katmanına bağlamak için. Mutation'lar zaten GlobalBusyOverlay tarafından otomatik
 * yakalanır (optimistic olmayanlar). Bunu sadece elle sarman gereken yerlerde kullan.
 */
let _count = 0;
let _label: string | null = null;
let _snap: { busy: boolean; label: string | null } = { busy: false, label: null };
const subs = new Set<() => void>();

function commit() {
  const busy = _count > 0;
  if (busy !== _snap.busy || (busy && _label !== _snap.label)) {
    _snap = { busy, label: busy ? _label : null };
  }
  subs.forEach((f) => f());
}

export function beginBusy(label?: string) {
  _count++;
  if (label) _label = label;
  commit();
}
export function endBusy() {
  _count = Math.max(0, _count - 1);
  if (_count === 0) _label = null;
  commit();
}

/** Bir async işi global loading katmanı altında çalıştır (bittiğinde otomatik kapanır). */
export async function runBlocking<T>(task: () => Promise<T>, label?: string): Promise<T> {
  beginBusy(label);
  try {
    return await task();
  } finally {
    endBusy();
  }
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
};
const getSnap = () => _snap;

export function useBusyState() {
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}
