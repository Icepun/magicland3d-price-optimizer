/**
 * Küçük fetch yardımcısı: JSON döndürür, HTTP hatasında anlamlı Error fırlatır.
 * React Query queryFn/mutationFn'lerinde paylaşılır (ürünler listesi + eşleştirme modalı + detay).
 *
 * ⚠️ `fetch(...).then((r) => r.json())` KULLANMA: sunucunun hata gövdesi ({ error }) "veri"
 * sanılıyordu. Siparişler sayfası sunucu hata verdiğinde hata göstermek yerine "0 sipariş"
 * çiziyordu (23 Eyl 2026 incelemesi). Bu yardımcı hata gövdesini fırlatır; ekran hata
 * durumunu kendi bileşeniyle gösterir.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const detail =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : null;
    // Sunucu açıklama vermediyse kullanıcıya adres/durum kodu değil, sade bir cümle düşer.
    throw new Error(
      detail || (response.status >= 500 ? "Sunucuda bir sorun oluştu, tekrar dene." : "İstek tamamlanamadı."),
    );
  }
  return response.json() as Promise<T>;
}
