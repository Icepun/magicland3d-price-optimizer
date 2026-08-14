/**
 * BAĞLANTI TESTİ — "sorun yazıcıda mı, bizde mi?"
 *
 * Panel bir yazıcıya ulaşamadığında bugün tek bir cümle yazıyor: "Yazıcıya ulaşılamadı —
 * Yazıcı açık ve aynı ağda mı?". Bu cümle üç ayrı durumu tek torbaya atıyor:
 *   • kutu ağda YOK (kapalı / farklı ağ / IP değişmiş)
 *   • kutu ağda VAR ama yazılımı yanıt vermiyor (Klipper durmuş, MQTT kapanmış)
 *   • kutu ve yazılım çalışıyor ama BİZİM isteğimiz düşüyor
 * Üçünün çaresi bambaşka; kullanıcı hangisi olduğunu bilmeden yazıcıyı boşuna kapatıp açıyor.
 *
 * Test KATMAN KATMAN ilerler ve nerede koptuğunu söyler. Hiçbir şeyi değiştirmez, yalnız
 * okur — baskı sürerken de güvenle çalıştırılabilir.
 */

export type AsamaDurum = "ok" | "hata" | "atlandi";

export interface TestAsamasi {
  /** Kullanıcıya gösterilen kısa ad. */
  ad: string;
  durum: AsamaDurum;
  /** Süre (ms) — ok/hata farketmez, ölçülen gerçek süre. */
  sureMs: number;
  /** Kullanıcıya gösterilecek tek satır (jargon yok). */
  aciklama: string;
}

export interface TestSonucu {
  asamalar: TestAsamasi[];
  /** Genel karar. */
  sonuc: "calisiyor" | "yazilim-durmus" | "agda-yok" | "kismi";
  /** Kullanıcıya gösterilen başlık ve tek satırlık öneri. */
  baslik: string;
  oneri: string;
}

/** Tek bir isteği süreölçerle çalıştır. */
export async function olcAdim(
  ad: string,
  calistir: () => Promise<{ ok: boolean; aciklama: string }>,
): Promise<TestAsamasi> {
  const t0 = Date.now();
  try {
    const r = await calistir();
    return { ad, durum: r.ok ? "ok" : "hata", sureMs: Date.now() - t0, aciklama: r.aciklama };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ad,
      durum: "hata",
      sureMs: Date.now() - t0,
      // Ham hata metnini kullanıcıya YAZMAYIZ; yalnız tanıdık kalıpları çeviririz.
      aciklama: /abort|timeout/i.test(msg)
        ? "Yanıt vermedi"
        : /ECONNREFUSED|refused/i.test(msg)
          ? "Bağlantı reddedildi"
          : /EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(msg)
            ? "Ağda bulunamadı"
            : "Ulaşılamadı",
    };
  }
}

/**
 * Aşamalardan genel kararı çıkar.
 *
 * Kural: ilk aşama (kutu ağda mı) düşerse gerisi anlamsız. Kutu ayaktayken yazılım
 * aşaması düşüyorsa sorun yazıcının YAZILIMINDA — kullanıcının yazıcıyı kapatıp açması
 * ya da arayüzünden yeniden başlatması gerekir, ağ ayarlarıyla uğraşması değil.
 */
export function kararVer(asamalar: TestAsamasi[]): Pick<TestSonucu, "sonuc" | "baslik" | "oneri"> {
  const gecerli = asamalar.filter((a) => a.durum !== "atlandi");
  if (gecerli.length === 0) {
    return { sonuc: "agda-yok", baslik: "Test yapılamadı", oneri: "Yazıcı bilgileri eksik." };
  }
  const hepsiOk = gecerli.every((a) => a.durum === "ok");
  if (hepsiOk) {
    return {
      sonuc: "calisiyor",
      baslik: "Bağlantı çalışıyor",
      oneri: "Yazıcı yanıt veriyor. Sorun sürüyorsa sayfayı yenile.",
    };
  }
  const ilk = gecerli[0];
  if (ilk.durum === "hata") {
    return {
      sonuc: "agda-yok",
      baslik: "Yazıcı ağda görünmüyor",
      oneri: "Yazıcı açık mı, aynı ağda mı? IP değişmiş olabilir.",
    };
  }
  // Kutu yanıt veriyor ama sonraki katmanlardan biri düştü. HANGİSİ olduğu çareyi değiştirir:
  // ağ/yazılım katmanı düştüyse yazıcıyı, yalnız VERİ katmanı düştüyse uygulamayı yeniden
  // başlatmak gerekir. İkisini aynı cümleyle geçmek kullanıcıyı boşuna yazıcıyla uğraştırıyordu.
  const dusen = gecerli.find((a) => a.durum === "hata");
  const sonAsama = gecerli[gecerli.length - 1];
  if (dusen && dusen === sonAsama && /veri/i.test(dusen.ad)) {
    return {
      sonuc: "kismi",
      baslik: "Yazıcı yanıt veriyor, veri gelmiyor",
      oneri: "Sorun yazıcıda değil. Uygulamayı yeniden başlatmayı dene.",
    };
  }
  return {
    sonuc: "yazilim-durmus",
    baslik: "Yazıcı ağda ama komut almıyor",
    oneri: "Yazıcıyı kapatıp açman gerekebilir.",
  };
}
