/**
 * HEPSIJET — kargo firmasının entegrasyon servisi (Shopify siparişlerinin kargosu için).
 *
 * Kaynak: HepsiJet'in herkese açık Postman dokümanı (documenter.getpostman.com/view/33109546/2sA2rGwKq9).
 *   Kimlik: POST /auth/token {username, password} → data.token (60 dk geçerli); sonraki isteklerde
 *   `X-Auth-Token`. POST'larda ayrıca `X-Origin: integration` + `X-Client-Id: hj-integration`
 *   (dokümanın tablosu `X-ClientId` diyor, cURL örnekleri `X-Client-Id` — cURL esas alındı).
 *   Test adresi tireli: integration-apitest (dokümanın bir tablosunda tiresiz yazılmış, cURL tireli).
 *
 * Bu dosya şimdilik BAĞLANTI + ADRES LİSTELERİ kadar: gönderi oluşturma, etiket ve takip uçları
 * test ortamında gerçek yanıt görülünce eklenecek (tahminle yazılmadı).
 *
 * ⚠️ Kişisel veri: müşteri adı / adresi / telefonu bu katmanda ASLA günlüğe yazılmaz.
 */
import crypto from "node:crypto";
import { processSingleton } from "@/core/printers/process-singleton";

export type HepsijetOrtami = "test" | "prod";

export interface HepsijetKimligi {
  ortam: HepsijetOrtami;
  kullaniciAdi: string;
  sifre: string;
}

const TABAN: Record<HepsijetOrtami, string> = {
  test: "https://integration-apitest.hepsijet.com",
  prod: "https://integration.hepsijet.com",
};

/** Kullanıcıya olduğu gibi gösterilebilen hata (kısa, Türkçe). */
export class HepsijetHatasi extends Error {
  constructor(mesaj: string, readonly durum = 502) {
    super(mesaj);
    this.name = "HepsijetHatasi";
  }
}

/** Token 60 dk geçerli; 50. dakikada yenilenir. Relay ile rotalar ayrı paket → süreç geneli tek kopya. */
const TOKEN_OMRU_MS = 50 * 60_000;
const tokenlar = processSingleton("hj_tokenlar", () => new Map<string, { token: string; alindi: number }>());

/**
 * REDDEDİLEN GİRİŞ KİLİDİ. HepsiJet birkaç hatalı girişten sonra hesabı ASKIYA ALIYOR (HTTP 423,
 * "yönetici ile iletişime geçin") — 19 Kas 2026'da test hesabı böyle kilitlendi. Aynı bilgilerle
 * yeniden denemek yalnız zarar verir; reddedilen bilgi bir süre sunucuya HİÇ gönderilmez. Bilgi
 * değişirse (yeni şifre) kilit onu etkilemez. Arka plan işleri de bu yoldan geçtiği için
 * yanlış şifreyle dönen bir yoklama hesabı kilitleyemez.
 */
const RET_BEKLEME_MS = 5 * 60_000;
const ASKI_BEKLEME_MS = 30 * 60_000;
const reddedilenler = processSingleton("hj_reddedilenler", () => new Map<string, { zaman: number; aski: boolean }>());

const ASKI_MESAJI = "HepsiJet bu hesabı askıya almış. HepsiJet'ten yeniden açmasını iste.";
const RET_MESAJI = "HepsiJet kullanıcı adını ya da şifreyi kabul etmedi.";

export interface HepsijetHesabi {
  /** HepsiJet'in tanımladığı mağaza adı ve kısa kodu — gönderi isteklerinin `company` bloğu. */
  sirketAdi: string | null;
  sirketKodu: string | null;
  /** Bağlı aktarma merkezi (şube). */
  aktarmaAdi: string | null;
  aktarmaKodu: string | null;
}

export interface HepsijetYer {
  id: number;
  ad: string;
}

const metin = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export class HepsijetClient {
  constructor(private readonly kimlik: HepsijetKimligi) {}

  private get taban(): string {
    return TABAN[this.kimlik.ortam];
  }

  private get tokenAnahtari(): string {
    return `${this.kimlik.ortam}:${this.kimlik.kullaniciAdi}`;
  }

  /** Ortam + kullanıcı + şifrenin özeti — şifrenin kendisi bellekte ayrıca tutulmaz. */
  private get kimlikOzeti(): string {
    return crypto
      .createHash("sha256")
      .update(`${this.kimlik.ortam}\n${this.kimlik.kullaniciAdi}\n${this.kimlik.sifre}`)
      .digest("hex");
  }

  private async cagir(yol: string, init: RequestInit, zamanAsimiMs = 15_000): Promise<{ durum: number; govde: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${this.taban}${yol}`, { ...init, signal: AbortSignal.timeout(zamanAsimiMs) });
    } catch {
      throw new HepsijetHatasi("HepsiJet'e ulaşılamadı. İnternet bağlantını kontrol et.");
    }
    const ham = await res.text().catch(() => "");
    let govde: unknown = null;
    try { govde = ham ? JSON.parse(ham) : null; } catch { govde = null; }
    return { durum: res.status, govde };
  }

  /** Giriş yap: token + hesabın şirket / şube bilgisi. Token önbelleğe alınır. */
  async girisYap(): Promise<HepsijetHesabi> {
    const ozet = this.kimlikOzeti;
    const ret = reddedilenler.get(ozet);
    if (ret) {
      const kalanMs = ret.zaman + (ret.aski ? ASKI_BEKLEME_MS : RET_BEKLEME_MS) - Date.now();
      if (kalanMs > 0) {
        const dk = Math.max(1, Math.ceil(kalanMs / 60_000));
        throw new HepsijetHatasi(
          ret.aski
            ? ASKI_MESAJI
            : `Bu bilgiler az önce reddedildi. Tekrar denemek hesabı kilitleyebilir — bilgileri kontrol et ya da ${dk} dk bekle.`,
          ret.aski ? 423 : 401,
        );
      }
      reddedilenler.delete(ozet);
    }
    const { durum, govde } = await this.cagir("/auth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Origin": "integration",
        "X-Client-Id": "hj-integration",
      },
      body: JSON.stringify({ username: this.kimlik.kullaniciAdi, password: this.kimlik.sifre }),
    });
    const veri = (govde as { data?: Record<string, unknown> } | null)?.data;
    const token = metin(veri?.token);
    if (durum === 423) {
      tokenlar.delete(this.tokenAnahtari);
      reddedilenler.set(ozet, { zaman: Date.now(), aski: true });
      throw new HepsijetHatasi(ASKI_MESAJI, 423);
    }
    if (durum === 401 || durum === 403 || (durum < 500 && !token)) {
      tokenlar.delete(this.tokenAnahtari);
      reddedilenler.set(ozet, { zaman: Date.now(), aski: false });
      throw new HepsijetHatasi(RET_MESAJI, 401);
    }
    if (!token) throw new HepsijetHatasi("HepsiJet şu an yanıt vermiyor. Biraz sonra tekrar dene.");
    reddedilenler.delete(ozet);
    tokenlar.set(this.tokenAnahtari, { token, alindi: Date.now() });
    const sirket = (veri?.company ?? {}) as Record<string, unknown>;
    const aktarma = (veri?.xdock ?? {}) as Record<string, unknown>;
    return {
      sirketAdi: metin(sirket.name),
      sirketKodu: metin(sirket.abbreviationCode),
      aktarmaAdi: metin(aktarma.name),
      aktarmaKodu: metin(aktarma.abbreviationCode),
    };
  }

  private async token(): Promise<string> {
    const kayit = tokenlar.get(this.tokenAnahtari);
    if (kayit && Date.now() - kayit.alindi < TOKEN_OMRU_MS) return kayit.token;
    await this.girisYap();
    return tokenlar.get(this.tokenAnahtari)!.token;
  }

  /** Token'lı GET; token süresinden önce geçersiz kılındıysa (401) bir kez yeniden giriş yapar. */
  private async getir(yol: string): Promise<unknown> {
    for (let deneme = 0; deneme < 2; deneme++) {
      const { durum, govde } = await this.cagir(yol, {
        method: "GET",
        headers: { Accept: "application/json", "X-Auth-Token": await this.token() },
      });
      if (durum === 401 && deneme === 0) {
        tokenlar.delete(this.tokenAnahtari);
        continue;
      }
      if (durum >= 400) throw new HepsijetHatasi("HepsiJet şu an yanıt vermiyor. Biraz sonra tekrar dene.");
      return govde;
    }
    throw new HepsijetHatasi("HepsiJet oturumu açılamadı.", 401);
  }

  /**
   * İl listesi. ⚠️ Kimlikler plaka kodu DEĞİL (HepsiJet'te 33 = İzmir, 35 = Mersin) — eşleştirme
   * her zaman İSİMLE yapılır.
   */
  async iller(): Promise<HepsijetYer[]> {
    return yerListesi(await this.getir("/settlement/cities"));
  }

  /** Standart (1–41 desi) dağıtım yapılan ilçeler. */
  async ilceler(ilId: number): Promise<HepsijetYer[]> {
    return yerListesi(
      await this.getir(`/settlement/city/${ilId}/towns?productCode=HX_STD&serviceType=&deliveryType=MARKET_PLACE`),
    );
  }

  async mahalleler(ilceId: number): Promise<HepsijetYer[]> {
    return yerListesi(
      await this.getir(`/settlement/town/${ilceId}/districts?productCode=HX_STD&serviceType=&deliveryType=MARKET_PLACE`),
    );
  }

  /**
   * Token'lı POST — yanıtı OLDUĞU GİBİ döner (HepsiJet hatayı 200 içinde `{status:"FAIL", message}`
   * olarak da verebiliyor; yorum çağırana ait). Token süresinden önce düştüyse bir kez yeniden girer.
   */
  private async postla(yol: string, govde: unknown, zamanAsimiMs = 30_000): Promise<{ durum: number; govde: unknown }> {
    for (let deneme = 0; deneme < 2; deneme++) {
      const yanit = await this.cagir(
        yol,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Origin": "integration",
            "X-Client-Id": "hj-integration",
            "X-Auth-Token": await this.token(),
          },
          body: JSON.stringify(govde),
        },
        zamanAsimiMs,
      );
      if (yanit.durum === 401 && deneme === 0) {
        tokenlar.delete(this.tokenAnahtari);
        continue;
      }
      return yanit;
    }
    throw new HepsijetHatasi("HepsiJet oturumu açılamadı.", 401);
  }

  /** Gönderi oluştur + etiketi anında al (ZPL) — `sendDeliveryOrderEnhanced`. Gövde: `lib/kargo/hepsijet-govde`. */
  async gonderiOlustur(govde: unknown): Promise<{ durum: number; govde: unknown }> {
    return this.postla("/delivery/sendDeliveryOrderEnhanced", govde);
  }

  /**
   * İade randevu tarihleri (`findAvailableDeliveryDatesV2`) — iade gönderisinin tarihi rastgele
   * olamaz, buradan dönen bir tarih olmalı. İl/ilçe müşterinin (iadeyi gönderenin) adresi.
   */
  async iadeTarihleri(il: string, ilce: string, bas: string, bit: string): Promise<unknown> {
    const q = new URLSearchParams({ startDate: bas, endDate: bit, deliveryType: "RETURNED", city: il, town: ilce });
    return this.getir(`/delivery/findAvailableDeliveryDatesV2?${q.toString()}`);
  }

  /**
   * Takip (`/deliveryTransaction/getDeliveryTracking` — dokümanda adres yazmıyor, test ortamında
   * 24 Kas 2026 bulundu). Kurye almamış gönderi yanıtta hiç yer almaz. Çözümü:
   * `core/kargo-gonderisi#hepsijetTakipCoz`.
   */
  async takip(barkodlar: string[]): Promise<unknown> {
    if (barkodlar.length === 0) return { status: "OK", data: [] };
    const { durum, govde } = await this.postla("/deliveryTransaction/getDeliveryTracking", {
      deliveries: barkodlar.map((customerDeliveryNo) => ({ customerDeliveryNo })),
    });
    if (durum >= 400) throw new HepsijetHatasi("HepsiJet takip bilgisi vermedi. Biraz sonra tekrar dene.");
    return govde;
  }

  /** Gönderinin termal etiketi (ZPL) — kayıp kopya için yeniden alınır. */
  async etiketZpl(barkod: string): Promise<string | null> {
    const govde = await this.getir(`/delivery/generateZplBarcode/${encodeURIComponent(barkod)}/1`);
    return zplBul(govde);
  }

  /** Kurye almadan önce gönderiyi siler. HepsiJet'in yanıtı olduğu gibi döner. */
  async gonderiSil(barkod: string): Promise<{ durum: number; govde: unknown }> {
    return this.postla(`/delivery/deleteDeliveryOrder/${encodeURIComponent(barkod)}`, { deleteReason: "IPTAL" });
  }
}

/** Yanıttaki ilk ZPL etiketi (`data.zplBarcodeDTOList[]` ya da `data[]` içindeki `zplBarcode`). */
export function zplBul(govde: unknown): string | null {
  const ara = (v: unknown, derinlik: number): string | null => {
    if (derinlik > 5 || v == null) return null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const z = ara(x, derinlik + 1);
        if (z) return z;
      }
      return null;
    }
    if (typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.zplBarcode === "string" && /\^XA[\s\S]*\^XZ/.test(o.zplBarcode)) return o.zplBarcode;
    for (const k of Object.keys(o)) {
      const z = ara(o[k], derinlik + 1);
      if (z) return z;
    }
    return null;
  };
  return ara(govde, 0);
}

/** HepsiJet yanıtı "başarılı" mı (`status: "OK"`)? Değilse kullanıcıya gösterilebilir mesaj. */
export function hepsijetSonucu(yanit: { durum: number; govde: unknown }): { ok: true } | { ok: false; mesaj: string } {
  const g = (yanit.govde ?? {}) as { status?: unknown; message?: unknown };
  if (yanit.durum < 400 && String(g.status ?? "").toUpperCase() === "OK") return { ok: true };
  const mesaj = metin(g.message);
  return { ok: false, mesaj: mesaj ? `HepsiJet: ${mesaj}` : "HepsiJet isteği kabul etmedi. Tekrar dene." };
}

/**
 * Yer listesi yanıtını {id, ad} dizisine çevirir. Yanıtın zarfı dokümanda örneklenmemiş; `data`
 * içinde ya da çıplak dizi gelebilir, ad alanı `name` (yoksa `cityName`/`townName`/`districtName`).
 */
export function yerListesi(govde: unknown): HepsijetYer[] {
  const dizi = Array.isArray(govde) ? govde : (govde as { data?: unknown } | null)?.data;
  if (!Array.isArray(dizi)) return [];
  const out: HepsijetYer[] = [];
  for (const ham of dizi) {
    const o = (ham ?? {}) as Record<string, unknown>;
    const id = Number(o.id);
    const ad = metin(o.name) ?? metin(o.cityName) ?? metin(o.townName) ?? metin(o.districtName);
    if (Number.isFinite(id) && ad) out.push({ id, ad });
  }
  return out;
}

/** Testler için: token önbelleğini boşalt. */
export function hepsijetTokenlariniTemizle(): void {
  tokenlar.clear();
  reddedilenler.clear();
}
