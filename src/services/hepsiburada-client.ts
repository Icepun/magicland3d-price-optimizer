/**
 * Hepsiburada Marketplace API istemcisi.
 *
 * Auth (doğrulandı): HTTP Basic Auth — base64(kullanıcıAdı:şifre) Authorization header'ında,
 * merchantId (GUID) isteklerde path parametresi. HB ayrıca bir User-Agent ister.
 *
 * NOT: HB geliştirici dokümanları girişe kapalı olduğundan kesin endpoint yolları + yanıt
 * şekilleri kullanıcının kendi hesabıyla "Test Bağlantısı" ile doğrulanacak; o yüzden host'lar
 * sabit, yollar tek yerde — gerekirse 1 satırda düzeltilir. Yanıtlar defansif okunur.
 */

export interface HepsiburadaCredentials {
  merchantId: string;
  username: string;
  password: string;
}

export interface HepsiburadaListing {
  merchantSku?: string;
  hepsiburadaSku?: string;
  sku?: string;
  barcode?: string;
  productBarcode?: string;
  productName?: string;
  price?: number;
  availableStock?: number;
  stock?: number;
  images?: Array<string | { url?: string }>;
  image?: string;
  [k: string]: unknown;
}

export interface HepsiburadaOrderItem {
  merchantSku?: string;
  sku?: string;
  barcode?: string;
  productName?: string;
  quantity?: number;
  totalPrice?: number | { amount?: number };
  price?: number | { amount?: number };
  [k: string]: unknown;
}

export interface HepsiburadaOrder {
  orderNumber?: string;
  id?: string;
  status?: string;
  orderDate?: string | number;
  items?: HepsiburadaOrderItem[];
  details?: HepsiburadaOrderItem[];
  [k: string]: unknown;
}

const HOSTS = {
  oms: "https://oms-external.hepsiburada.com",
  listing: "https://listing-external.hepsiburada.com",
  mpop: "https://mpop.hepsiburada.com",
};

export class HepsiburadaApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "HepsiburadaApiError";
  }
}

export class HepsiburadaClient {
  constructor(private readonly credentials: HepsiburadaCredentials) {}

  private headers(): HeadersInit {
    const token = Buffer.from(`${this.credentials.username}:${this.credentials.password}`, "utf8").toString("base64");
    return {
      Authorization: `Basic ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      // HB User-Agent zorunlu tutuyor; kullanıcı adı (entegratör adı) konvansiyonu.
      "User-Agent": this.credentials.username || this.credentials.merchantId || "MagiclandHub",
    };
  }

  private parseBody(text: string): unknown {
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch { return text; }
  }

  private extractError(status: number, body: unknown, fallback: string): string {
    if (typeof body === "string") return body.slice(0, 400) || fallback;
    if (body && typeof body === "object") {
      const r = body as Record<string, unknown>;
      const cand = [r.message, r.error, r.detail, r.title, r.errorDescription].find(Boolean);
      if (Array.isArray(cand)) return cand.map(String).join(", ");
      if (cand) return String(cand);
    }
    if (status === 401) return "Yetkilendirme başarısız. Kullanıcı adı / şifre / merchantId'yi kontrol edin.";
    if (status === 403) return "Hepsiburada isteği engelledi (yetki/User-Agent). Entegrasyon kullanıcısının izinleri açık mı?";
    if (status === 404) return "Adres bulunamadı (endpoint). Bu uç henüz hesabınızla doğrulanmadı.";
    if (status === 429) return "Hepsiburada servis limitine takıldı. Biraz bekleyin.";
    return fallback;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const body = this.parseBody(text);
    if (!res.ok) {
      throw new HepsiburadaApiError(res.status, `Hepsiburada API ${res.status}: ${this.extractError(res.status, body, res.statusText)}`, body);
    }
    return body as T;
  }

  /** Bağlantı testi: az veriyle listing uç noktasına vurur. Auth + erişim doğrulanır. */
  async test(): Promise<{ ok: true; sample: unknown }> {
    const sample = await this.request<unknown>(
      `${HOSTS.listing}/listings/merchantid/${encodeURIComponent(this.credentials.merchantId)}?offset=0&limit=1`
    );
    return { ok: true, sample };
  }

  /** Mağaza listing'leri (fiyat/stok/sku). Sayfalı. */
  async listListings(params: { offset?: number; limit?: number } = {}): Promise<unknown> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    return this.request<unknown>(
      `${HOSTS.listing}/listings/merchantid/${encodeURIComponent(this.credentials.merchantId)}?offset=${offset}&limit=${limit}`
    );
  }

  /** Ödemesi tamamlanmış siparişler (OMS). Sayfalı. */
  async listOrders(params: { offset?: number; limit?: number } = {}): Promise<unknown> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return this.request<unknown>(
      `${HOSTS.oms}/orders/merchantid/${encodeURIComponent(this.credentials.merchantId)}?offset=${offset}&limit=${limit}`
    );
  }
}
