/**
 * Küçük fetch yardımcısı: JSON döndürür, HTTP hatasında anlamlı Error fırlatır.
 * React Query queryFn/mutationFn'lerinde paylaşılır (ürünler listesi + eşleştirme modalı + detay).
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const detail =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : null;
    throw new Error(detail || `${url} ${response.status}`);
  }
  return response.json() as Promise<T>;
}
