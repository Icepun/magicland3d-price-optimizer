/**
 * ANLIK UYARILARI GİZLEME KURALI — saf (içe aktarma yok), kökten test edilir.
 *
 * NEDEN: stok ≤ 1, filament ve duraklayan yazıcı uyarıları her yoklamada YENİDEN hesaplanıyor;
 * kapatacak bir yer yoktu ve zil hep doluydu ("bildirimleri silme yok, hep görünüyor").
 * Kalıcı (baskı bitti vb.) bildirimler veritabanında "okundu" işaretlenir; anlık olanlar burada.
 *
 * İÇERİĞİYLE GİZLENİR: uyarı kimliği + başlık + metin. Durum değişince (stok 1 → 0, yazıcı başka
 * bir işte yeniden duraklarsa) metin değişir ve uyarı YENİDEN görünür — kapatılan bir sorun
 * sessizce büyümesin. Masaüstü zili kimliği kalıcı gizliyor; telefonda bilinçli olarak daha dar.
 *
 * İki telefon ORTAK (AppSetting `mobilBildirimGizli`): biri ilgilendiği uyarıyı kapatınca
 * diğerinde de kalkar.
 */

export const GIZLI_AYAR_ANAHTARI = "mobilBildirimGizli";
/** Satır şişmesin: masaüstü AppSetting'i toplu okuyor. */
export const GIZLI_AZAMI = 300;

export type GizliHarita = Record<string, string>;

export function uyariImzasi(u: { title: string; body: string }): string {
  return `${u.title}|${u.body}`;
}

/** Ayar metnini oku — bozuk/eski değer boş haritadır (hiçbir şey gizlenmez, çökmez). */
export function gizliHaritaOku(deger: string | null | undefined): GizliHarita {
  if (!deger) return {};
  try {
    const ham = JSON.parse(deger) as unknown;
    if (!ham || typeof ham !== "object" || Array.isArray(ham)) return {};
    const out: GizliHarita = {};
    for (const [k, v] of Object.entries(ham as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function gizliMi(harita: GizliHarita, u: { id: string; title: string; body: string }): boolean {
  return harita[u.id] === uyariImzasi(u);
}

/**
 * Yeni gizlenenleri ekle; artık hiç görünmeyen (sorunu çözülmüş) uyarıların kaydını at —
 * sorun sonradan aynı metinle geri gelirse yeniden görünsün. En fazla `GIZLI_AZAMI` kayıt.
 */
export function gizliHaritaGuncelle(
  onceki: GizliHarita,
  eklenecek: readonly { id: string; title: string; body: string }[],
  mevcutKimlikler: ReadonlySet<string>,
): GizliHarita {
  const out: GizliHarita = {};
  for (const [k, v] of Object.entries(onceki)) if (mevcutKimlikler.has(k)) out[k] = v;
  for (const u of eklenecek) out[u.id] = uyariImzasi(u);
  const girdiler = Object.entries(out);
  return Object.fromEntries(girdiler.slice(Math.max(0, girdiler.length - GIZLI_AZAMI)));
}
