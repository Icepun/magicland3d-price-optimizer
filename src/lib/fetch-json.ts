/**
 * Küçük fetch yardımcısı: JSON döndürür, HTTP hatasında anlamlı Error fırlatır.
 * React Query queryFn/mutationFn'lerinde paylaşılır (ürünler listesi + eşleştirme modalı + detay).
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }
  return response.json() as Promise<T>;
}
