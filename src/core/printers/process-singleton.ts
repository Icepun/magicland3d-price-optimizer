/**
 * SÜREÇ GENELİ TEK ÖRNEK — modül iki kez paketlense bile durum TEK kalır.
 *
 * SORUN (ölçüldü, 14 Ağu 2026): Next, `instrumentation.ts`'i (telefon relay'ini başlatan dosya)
 * API rotalarından AYRI bir paket olarak derliyor. `bambu.ts` iki pakete birden kopyalandı —
 * derlenmiş çıktıda `mg3d_` istemci kimliği hem chunk 9525'te (relay) hem chunk 1046'da
 * (`/api/printers` rotası) çıkıyor. İki kopya = iki ayrı `conns` haritası = yazıcıya İKİ MQTT
 * istemcisi. `netstat` bunu doğruladı: tek uygulama süreci, yazıcıya sürekli 2 açık soket.
 *
 * NEDEN ZARARLI: Bambu firmware'i raporları yalnız EN SON bağlanan istemciye gönderiyor
 * (BambuStudio#2404). İki kopyamız birbirini susturuyordu: veri alamayan kopya bekçisini
 * çalıştırıp yeniden bağlanıyor, böylece "son istemci" oluyor ve DİĞER kopyayı susturuyor;
 * o da bir süre sonra aynısını yapıyor. Sonsuz gel-git → kart durmadan "bağlantı yok"a
 * düşüyor, uygulamayı yeniden başlatmak yalnız kısa süre düzeltiyor.
 *
 * ÇÖZÜM: durumu modül kapsamında değil `globalThis` üzerinde tut. Paket kaç kopya olursa olsun
 * `globalThis` süreçte tektir. (`src/lib/prisma.ts` aynı deseni zaten kullanıyor — bu dosya onu
 * yazıcı tarafına taşır.)
 *
 * DİKKAT: yalnız SÜREÇ İÇİ tekliktir. İki ayrı makine (Windows + Mac) yine iki istemcidir;
 * makineler arası korumalar veritabanı üzerinden yapılır (bkz. relay'deki atomik komut sahiplenme).
 */

type Kap = Record<string, unknown>;

/**
 * `ad` için süreçte tek bir örnek döndürür; ilk çağıran `olustur()` ile yaratır, sonrakiler
 * aynı nesneyi alır.
 */
export function processSingleton<T>(ad: string, olustur: () => T): T {
  const g = globalThis as unknown as Kap;
  const anahtar = `__mlhub_${ad}`;
  // `in` kullanılıyor: falsy değerler (0, "") de saklanabilsin diye.
  if (!(anahtar in g)) g[anahtar] = olustur();
  return g[anahtar] as T;
}

/** Testler için: kaydı sil (sonraki çağrı yeniden yaratır). */
export function resetProcessSingleton(ad: string): void {
  delete (globalThis as unknown as Kap)[`__mlhub_${ad}`];
}
