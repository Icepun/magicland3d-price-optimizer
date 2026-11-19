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
    if (durum === 401 || durum === 403 || (durum < 500 && !token)) {
      tokenlar.delete(this.tokenAnahtari);
      throw new HepsijetHatasi("HepsiJet kullanıcı adını ya da şifreyi kabul etmedi.", 401);
    }
    if (!token) throw new HepsijetHatasi("HepsiJet şu an yanıt vermiyor. Biraz sonra tekrar dene.");
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
}
