/**
 * KAYDEDİLMEMİŞ DEĞİŞİKLİK KORUMASI — uygulama içi gezinme için tek kapı.
 *
 * Maliyet & Paketleme sayfasında kaydedilmemiş değişiklik varken kenar menüden ya da hızlı aramadan
 * (Ctrl+K) çıkılınca değişiklikler sessizce gidiyordu (denetim, 23 Kas 2026). Sayfa bir koruyucu
 * kurar; gezinen taraf (`gezinebilirMi`) önce ona sorar. Koruyucu `false` dönerse gezinme durur ve
 * sayfa kendi "Kaydet / Kaydetmeden git / Kal" sorusunu gösterir.
 *
 * Bağlantı (<a>) tıklamaları sayfanın kendisi tarafından yakalanır; bu modül yalnız kodla yapılan
 * gezinmeler (router.push) içindir.
 */
type Koruyucu = (hedef: string) => boolean;

let koruyucu: Koruyucu | null = null;

/** Sayfa korumayı kurar; dönen fonksiyon kaldırır. */
export function gezinmeKorumasiKur(fn: Koruyucu): () => void {
  koruyucu = fn;
  return () => {
    if (koruyucu === fn) koruyucu = null;
  };
}

/** Gezinmeden önce sor: `false` → gezinme, sayfa kullanıcıya soruyor. */
export function gezinebilirMi(hedef: string): boolean {
  return koruyucu ? koruyucu(hedef) : true;
}
