/**
 * Platform API fetch'i — timeout'lu. RN fetch iOS'ta ~60sn varsayılanla askıda kalabiliyor;
 * tek takılan çağrı tüm sipariş boru hattını (Promise.allSettled) dakikaya yakın bekletiyordu.
 */
export async function fetchT(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw ctrl.signal.aborted
      ? new Error(`İstek zaman aşımı (${Math.round(timeoutMs / 1000)}sn) — bağlantıyı kontrol et`)
      : e;
  } finally {
    clearTimeout(timer);
  }
}
