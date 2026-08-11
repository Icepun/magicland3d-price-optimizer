// Arka plan işi: AYRI client (ayrı adapter = ayrı mutex) → push gönderimi UI sorgularının
// kuyruğunu meşgul etmez. Relay de aynı deseni kullanıyor (src/core/printers/relay.ts).
import { remotePrisma as prisma } from "./prisma";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo tek istekte en fazla 100 mesaj kabul eder; fazlası TOPTAN reddedilir. */
const MESAJ_GRUP = 100;
/** Makbuz sorgusunda tek istekte gönderilecek bilet sayısı (Expo sınırı 1000). */
const MAKBUZ_GRUP = 300;
/** Expo "biletler işlendikten sonra" makbuz ister; ~15 sn pratikte yeterli. */
const MAKBUZ_GECIKME_MS = 15_000;

export interface PushGonderimOzeti {
  /** Kayıtlı telefon sayısı */
  toplamCihaz: number;
  /** Expo'nun kabul ettiği (kuyruğa aldığı) bildirim sayısı */
  gonderildi: number;
  /** Reddedilen bildirim sayısı */
  hata: number;
  /** Silinen ölü kayıt sayısı */
  temizlenenKayit: number;
  /** Sade Türkçe, tekrarsız hata sebepleri (doğrudan arayüzde gösterilebilir) */
  sebepler: string[];
  /** Gönderim zamanı (ISO) */
  zaman: string;
  /** Teslim doğrulaması beklendiyse sonucu (test ekranı için) */
  teslim?: { basarili: number; hatali: number };
}

/** Son gönderimin özeti — test/tanı ekranı bunu okuyup kullanıcıya gösterir. */
let sonOzet: PushGonderimOzeti | null = null;
export function sonPushOzeti(): PushGonderimOzeti | null {
  return sonOzet;
}

interface ExpoBilet {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string } | null;
}
interface ExpoGonderimYaniti {
  data?: ExpoBilet[];
  errors?: Array<{ code?: string; message?: string }>;
}
interface ExpoMakbuz {
  status?: string;
  message?: string;
  details?: { error?: string } | null;
}
interface ExpoMakbuzYaniti {
  data?: Record<string, ExpoMakbuz>;
  errors?: Array<{ code?: string; message?: string }>;
}

function grupla<T>(liste: T[], boyut: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += boyut) out.push(liste.slice(i, i + boyut));
  return out;
}

function hataMetni(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Expo hata kodunu SON KULLANICIYA hitap eden tek satıra çevirir.
 * (Kod adları arayüze asla sızmamalı — sadece günlüğe yazılır.)
 */
function sadeSebep(kod: string | undefined, yedekMesaj?: string): string {
  switch (kod) {
    case "DeviceNotRegistered":
      return "Bir telefon bildirimleri kapatmış; kaydı silindi.";
    case "MessageTooBig":
      return "Bildirim metni çok uzun.";
    case "MessageRateExceeded":
      return "Çok sık bildirim gönderildi, biraz sonra tekrar deneyin.";
    case "InvalidCredentials":
    case "MismatchedSenderId":
      return "Bildirim ayarları geçersiz; uygulamayı telefona yeniden kurmak gerekiyor.";
    case "ExpoError":
    case "ProviderError":
      return "Bildirim servisi şu an bildirim kabul etmiyor.";
    default:
      return yedekMesaj && yedekMesaj.length < 80 ? yedekMesaj : "Bildirim gönderilemedi.";
  }
}

function sebepEkle(ozet: PushGonderimOzeti, sebep: string): void {
  if (!ozet.sebepler.includes(sebep)) ozet.sebepler.push(sebep);
}

/** Ölü token'ları sil. Silme başarısız olursa gönderim yine de bozulmaz. */
async function oluKayitlariSil(tokenlar: string[]): Promise<number> {
  if (tokenlar.length === 0) return 0;
  try {
    const r = await prisma.pushToken.deleteMany({ where: { token: { in: tokenlar } } });
    return r?.count ?? tokenlar.length;
  } catch (err) {
    console.warn("[push] ölü kayıt silinemedi:", hataMetni(err));
    return 0;
  }
}

/**
 * Teslim makbuzlarını sorgular. DeviceNotRegistered ÇOĞUNLUKLA bilette değil MAKBUZDA döner —
 * bu adım olmadan ölü token temizliği pratikte hiç çalışmaz (asıl arıza buydu).
 */
export async function makbuzlariDogrula(
  biletToken: Map<string, string>
): Promise<{ teslim: number; hata: number; temizlenenKayit: number; sebepler: string[] }> {
  const sonuc = { teslim: 0, hata: 0, temizlenenKayit: 0, sebepler: [] as string[] };
  const idler = [...biletToken.keys()];
  if (idler.length === 0) return sonuc;

  const olu: string[] = [];
  for (const grup of grupla(idler, MAKBUZ_GRUP)) {
    try {
      const res = await fetch(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ids: grup }),
      });
      const veri = (await res.json().catch(() => null)) as ExpoMakbuzYaniti | null;
      if (!res.ok) {
        console.warn(`[push] makbuz sorgusu reddedildi (durum ${res.status})`);
        if (!sonuc.sebepler.includes("Teslim durumu öğrenilemedi."))
          sonuc.sebepler.push("Teslim durumu öğrenilemedi.");
        continue;
      }
      const kayitlar = veri?.data ?? {};
      for (const [id, makbuz] of Object.entries(kayitlar)) {
        if (makbuz?.status === "ok") {
          sonuc.teslim += 1;
          continue;
        }
        sonuc.hata += 1;
        const kod = makbuz?.details?.error;
        const sebep = sadeSebep(kod, makbuz?.message);
        if (!sonuc.sebepler.includes(sebep)) sonuc.sebepler.push(sebep);
        console.warn(`[push] makbuz hatası: ${kod ?? "?"} — ${makbuz?.message ?? ""}`);
        // YALNIZ DeviceNotRegistered kaydı siler: o hata CİHAZA özeldir (uygulama silinmiş,
        // token dönmüş). InvalidCredentials ise PROJE düzeyinde bir yapılandırma hatasıdır ve
        // o an gönderilen HER mesaj için döner — silinirse tek bir yanlış ayar yüzünden bütün
        // telefon kayıtları geri alınamaz biçimde gider ve kullanıcı uygulamaları yeniden
        // kurana kadar hiç bildirim alamaz. Sebep listesine yazılır, kayıt korunur.
        if (kod === "DeviceNotRegistered") {
          const token = biletToken.get(id);
          if (token) olu.push(token);
        }
      }
    } catch (err) {
      console.warn("[push] makbuz sorgusu yapılamadı:", hataMetni(err));
      if (!sonuc.sebepler.includes("Teslim durumu öğrenilemedi."))
        sonuc.sebepler.push("Teslim durumu öğrenilemedi.");
    }
  }

  sonuc.temizlenenKayit = await oluKayitlariSil(olu);
  console.info(
    `[push/teslim] ${sonuc.teslim} teslim · ${sonuc.hata} hata · ${sonuc.temizlenenKayit} kayıt temizlendi`
  );
  return sonuc;
}

/** Makbuz sorgusunu arka plana planla — gönderimi (dolayısıyla relay'i) BEKLETMEZ. */
function makbuzlariPlanla(biletToken: Map<string, string>, gecikmeMs: number): void {
  if (biletToken.size === 0) return;
  const zaman = setTimeout(() => {
    void makbuzlariDogrula(biletToken).catch((err) => {
      console.warn("[push] makbuz doğrulama düştü:", hataMetni(err));
    });
  }, gecikmeMs);
  // Node'da bekleyen timer süreç kapanışını geciktirmesin.
  (zaman as unknown as { unref?: () => void }).unref?.();
}

/**
 * Kayıtlı tüm Expo push token'larına bildirim gönderir (baskı bitti vb.). Telefon KAPALIYKEN de düşer.
 * Mobil uygulama token'ı PushToken tablosuna yazar; bu masaüstü relay'inden çağrılır.
 *
 * Sözleşme: DIŞARIYA ASLA HATA FIRLATMAZ (relay'i bozmamalı) ama artık SESSİZ de değil —
 * her turda tek satır özet günlüğe yazılır ve özet döner.
 */
export async function pushToAllDevices(
  title: string,
  body: string,
  secenek?: { makbuzGecikmeMs?: number; makbuzlariBekle?: boolean }
): Promise<PushGonderimOzeti> {
  const ozet: PushGonderimOzeti = {
    toplamCihaz: 0,
    gonderildi: 0,
    hata: 0,
    temizlenenKayit: 0,
    sebepler: [],
    zaman: new Date().toISOString(),
  };

  try {
    let tokenlar: string[] = [];
    try {
      const rows = await prisma.pushToken.findMany({ select: { token: true } });
      tokenlar = rows
        .map((r) => r.token)
        .filter((t) => typeof t === "string" && t.startsWith("ExponentPushToken"));
    } catch (err) {
      console.warn("[push] kayıtlı telefon listesi okunamadı:", hataMetni(err));
      sebepEkle(ozet, "Kayıtlı telefon listesi okunamadı.");
      sonOzet = ozet;
      return ozet;
    }

    ozet.toplamCihaz = tokenlar.length;
    if (tokenlar.length === 0) {
      console.info(`[push] "${title}" · kayıtlı telefon yok`);
      sonOzet = ozet;
      return ozet;
    }

    const olu: string[] = [];
    const biletToken = new Map<string, string>();

    for (const grup of grupla(tokenlar, MESAJ_GRUP)) {
      const mesajlar = grup.map((to) => ({
        to,
        title,
        body,
        sound: "default" as const,
        priority: "high" as const,
        channelId: "default",
      }));

      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(mesajlar),
        });
        const veri = (await res.json().catch(() => null)) as ExpoGonderimYaniti | null;

        // 1) İstek toptan reddedildi (400/401/429/5xx) → biletler hiç oluşmadı.
        if (!res.ok) {
          ozet.hata += grup.length;
          const ustHata = veri?.errors?.[0];
          const sebep = ustHata
            ? sadeSebep(ustHata.code, ustHata.message)
            : "Bildirim servisine şu an ulaşılamıyor.";
          sebepEkle(ozet, sebep);
          console.warn(
            `[push] gönderim reddedildi (durum ${res.status}): ${ustHata?.code ?? "?"} — ${ustHata?.message ?? ""}`
          );
          continue;
        }

        // 2) 200 ama gövdede üst düzey hata dalı var (Expo bunu da yapar).
        if (veri?.errors?.length) {
          ozet.hata += grup.length;
          const ustHata = veri.errors[0];
          sebepEkle(ozet, sadeSebep(ustHata.code, ustHata.message));
          console.warn(`[push] gönderim hatası: ${ustHata.code ?? "?"} — ${ustHata.message ?? ""}`);
          continue;
        }

        // 3) Bilet bilet değerlendir.
        const biletler = veri?.data ?? [];
        if (biletler.length === 0) {
          ozet.hata += grup.length;
          sebepEkle(ozet, "Bildirim servisi beklenmedik bir yanıt verdi.");
          console.warn("[push] gönderim yanıtında bilet yok");
          continue;
        }
        biletler.forEach((bilet, i) => {
          const token = grup[i];
          if (bilet?.status === "ok") {
            ozet.gonderildi += 1;
            if (bilet.id && token) biletToken.set(bilet.id, token);
            return;
          }
          ozet.hata += 1;
          const kod = bilet?.details?.error;
          sebepEkle(ozet, sadeSebep(kod, bilet?.message));
          console.warn(`[push] bilet hatası: ${kod ?? "?"} — ${bilet?.message ?? ""}`);
          // Yalnız cihaza özel hata kaydı siler (yukarıdaki nota bak).
          if (kod === "DeviceNotRegistered" && token) olu.push(token);
        });
      } catch (err) {
        ozet.hata += grup.length;
        sebepEkle(ozet, "İnternet bağlantısı yok gibi görünüyor.");
        console.warn("[push] gönderim isteği yapılamadı:", hataMetni(err));
      }
    }

    ozet.temizlenenKayit += await oluKayitlariSil(olu);

    // Tek satır özet — push gitmiyorsa artık iz kalıyor.
    console.info(
      `[push] "${title}" · ${ozet.gonderildi}/${ozet.toplamCihaz} kabul · ${ozet.hata} hata` +
        (ozet.temizlenenKayit ? ` · ${ozet.temizlenenKayit} kayıt temizlendi` : "") +
        (ozet.sebepler.length ? ` · ${ozet.sebepler.join(" | ")}` : "")
    );

    const gecikme = secenek?.makbuzGecikmeMs ?? MAKBUZ_GECIKME_MS;
    if (secenek?.makbuzlariBekle) {
      // Test ekranı için: makbuz oluşana kadar bekle, sonra teslimi gerçekten doğrula.
      if (gecikme > 0) await new Promise((r) => setTimeout(r, gecikme));
      const m = await makbuzlariDogrula(biletToken);
      ozet.temizlenenKayit += m.temizlenenKayit;
      ozet.teslim = { basarili: m.teslim, hatali: m.hata };
      for (const s of m.sebepler) sebepEkle(ozet, s);
    } else {
      makbuzlariPlanla(biletToken, gecikme);
    }

    sonOzet = ozet;
    return ozet;
  } catch (err) {
    // Son emniyet: bu fonksiyon relay'i ASLA bozmamalı.
    console.warn("[push] beklenmeyen hata:", hataMetni(err));
    sebepEkle(ozet, "Bildirim gönderilemedi.");
    sonOzet = ozet;
    return ozet;
  }
}
