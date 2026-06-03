/**
 * Hepsiburada Marketplace API istemcisi.
 *
 * Auth (DOĞRULANDI, 2026-06 test hesabıyla canlı): HTTP Basic Auth = base64(merchantId:secretKey)
 * + ZORUNLU `User-Agent: <developerUsername>` header. merchantId ayrıca path param.
 * Ortam: "test" (SIT) veya "prod" (canlı) — host'lar buna göre seçilir.
 *
 * Kanonik bilgi: docs/hepsiburada/ (README/test-certification/business-rules-faq).
 */

export type HbEnvironment = "test" | "prod";

export interface HepsiburadaCredentials {
  merchantId: string;
  secretKey: string;
  developerUsername: string;
  environment: HbEnvironment;
}

export interface HepsiburadaListing {
  merchantSku?: string;
  hepsiburadaSku?: string;
  listingId?: string;
  sku?: string;
  barcode?: string;
  productBarcode?: string;
  productName?: string;
  productId?: string;
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

/** Ortam bazlı host'lar. test = SIT (-sit), prod = canlı. (README §0) */
export function hepsiburadaHosts(env: HbEnvironment) {
  return env === "prod"
    ? {
        oms: "https://oms-external.hepsiburada.com",
        omsStub: "https://oms-external.hepsiburada.com", // canlıda test sipariş üretimi yok
        listing: "https://listing-external.hepsiburada.com",
        mpop: "https://mpop.hepsiburada.com",
      }
    : {
        oms: "https://oms-external-sit.hepsiburada.com",
        omsStub: "https://oms-stub-external-sit.hepsiburada.com", // sadece TEST sipariş üretimi (DOĞRULANDI)
        listing: "https://listing-external-sit.hepsiburada.com", // DOĞRULANDI
        mpop: "https://mpop-sit.hepsiburada.com",
      };
}

export class HepsiburadaApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "HepsiburadaApiError";
  }
}

export class HepsiburadaClient {
  private readonly hosts: ReturnType<typeof hepsiburadaHosts>;
  constructor(private readonly credentials: HepsiburadaCredentials) {
    this.hosts = hepsiburadaHosts(credentials.environment);
  }

  get environment(): HbEnvironment {
    return this.credentials.environment;
  }

  private headers(): HeadersInit {
    const token = Buffer.from(`${this.credentials.merchantId}:${this.credentials.secretKey}`, "utf8").toString("base64");
    return {
      Authorization: `Basic ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      // HB User-Agent'ı ZORUNLU tutuyor → developer username (entegratör adı). Eksikse 403.
      "User-Agent": this.credentials.developerUsername || "MagiclandHub",
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
    if (status === 401) return "Yetkilendirme başarısız. merchantId / gizli anahtar (secret key) doğru mu?";
    if (status === 403) return "Hepsiburada isteği engelledi. Geliştirici kullanıcı adı (User-Agent) doğru mu, yetki tanımlı mı?";
    if (status === 404) return "Adres bulunamadı (endpoint). Ortam (Test/Canlı) seçimi doğru mu?";
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

  /** Bağlantı testi: az veriyle listing uç noktasına vurur. Auth + ortam + erişim doğrulanır. */
  async test(): Promise<{ ok: true; environment: HbEnvironment; sample: unknown }> {
    const sample = await this.request<unknown>(
      `${this.hosts.listing}/listings/merchantid/${encodeURIComponent(this.credentials.merchantId)}?offset=0&limit=1`
    );
    return { ok: true, environment: this.credentials.environment, sample };
  }

  /** Mağaza listing'leri (fiyat/stok/sku). Sayfalı. (DOĞRULANDI şema: README §0) */
  async listListings(params: { offset?: number; limit?: number } = {}): Promise<unknown> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    return this.request<unknown>(
      `${this.hosts.listing}/listings/merchantid/${encodeURIComponent(this.credentials.merchantId)}?offset=${offset}&limit=${limit}`
    );
  }

  /** Ödemesi tamamlanmış siparişler (OMS). Sayfalı. */
  async listOrders(params: { offset?: number; limit?: number } = {}): Promise<unknown> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return this.request<unknown>(
      `${this.hosts.oms}/orders/merchantid/${encodeURIComponent(this.credentials.merchantId)}?offset=${offset}&limit=${limit}`
    );
  }
}
