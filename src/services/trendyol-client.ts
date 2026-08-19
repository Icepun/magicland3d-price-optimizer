export type TrendyolEnvironment = "prod" | "stage";

export interface TrendyolCredentials {
  sellerId: string;
  apiKey: string;
  apiSecret: string;
  environment: TrendyolEnvironment;
  integratorName: string;
}

export interface TrendyolProduct {
  id?: string;
  productCode?: number | string;
  approved?: boolean;
  archived?: boolean;
  /** Satışta mı (pasif/satışa-kapalı = false). Tükendi ürünlerde true kalır. */
  onSale?: boolean;
  rejected?: boolean;
  blacklisted?: boolean;
  barcode: string;
  title?: string;
  categoryName?: string;
  stockCode?: string;
  quantity?: number;
  salePrice?: number;
  listPrice?: number;
  dimensionalWeight?: number;
  productMainId?: string;
  images?: Array<{ url?: string }>;
  /** Trendyol'un bildirdiği komisyon oranı (v2). Biçimi yüzde (örn. 21.0) — kesire ÇEVRİLİR. */
  commission?: number;
}

/**
 * ÜRÜN V2 GÖVDESİ — `content[]` altında `variants[]`.
 * İki uç iki farklı biçim veriyor; ikisi de burada tanımlı.
 */
export interface TrendyolV2Page<T> {
  totalElements?: number;
  totalPages?: number;
  page?: number;
  size?: number;
  nextPageToken?: string;
  content?: T[];
}

interface TrendyolV2Variant {
  variantId?: number;
  barcode?: string;
  stockCode?: string;
  onSale?: boolean;
  archived?: boolean;
  blacklisted?: boolean;
  locked?: boolean;
  commission?: number;
  price?: { salePrice?: number; listPrice?: number; priceSeenByCustomer?: number };
  stock?: { quantity?: number };
}

export interface TrendyolV2Content {
  contentId?: number;
  productMainId?: string;
  title?: string;
  category?: { name?: string };
  images?: Array<{ url?: string }>;
  variants?: TrendyolV2Variant[];
}

/** Hafif uçta fiyat/stok DÜZ duruyor (price./stock. sarmalayıcısı yok). */
export interface TrendyolV2StokFiyat {
  contentId?: number;
  productMainId?: string;
  variants?: Array<{
    variantId?: number;
    barcode?: string;
    stockCode?: string;
    salePrice?: number;
    listPrice?: number;
    quantity?: number;
  }>;
}

/**
 * v2 "onaylı ürün" → eski (v1) düz ürün biçimi.
 *
 * `id` alanı v2'de yok; eşleştirme `externalId` üzerinden yapıldığı için varyant kimliği
 * oraya konuyor — barkod zaten ayrıca taşınıyor ve eşleştirme öncelik sırasında barkoda da
 * bakıyor, yani kimlik biçimi değişse bile eşleşme barkoddan kurtarılabiliyor.
 */
function duzlestirOnayli(c: TrendyolV2Content): TrendyolProduct[] {
  const ortak = {
    title: c.title,
    categoryName: c.category?.name,
    productMainId: c.productMainId,
    images: c.images,
  };
  return (c.variants ?? [])
    .filter((v) => !!v.barcode)
    .map((v) => ({
      ...ortak,
      id: v.variantId != null ? String(v.variantId) : undefined,
      barcode: String(v.barcode),
      stockCode: v.stockCode,
      salePrice: v.price?.salePrice,
      listPrice: v.price?.listPrice,
      quantity: v.stock?.quantity,
      commission: v.commission,
      onSale: v.onSale,
      archived: v.archived,
      blacklisted: v.blacklisted,
      // v2'nin onaylı ucunda "rejected" yok — reddedilenler ayrı uçta. Onaylı liste
      // tanımı gereği reddedilmemiş olduğu için sabit false doğru.
      rejected: false,
      approved: true,
    }));
}

/** v2 "stok ve fiyat" → eski düz biçim. Buradaki alanlar zaten düz. */
function duzlestirStokFiyat(c: TrendyolV2StokFiyat): TrendyolProduct[] {
  return (c.variants ?? [])
    .filter((v) => !!v.barcode)
    .map((v) => ({
      id: v.variantId != null ? String(v.variantId) : undefined,
      barcode: String(v.barcode),
      stockCode: v.stockCode,
      productMainId: c.productMainId,
      salePrice: v.salePrice,
      listPrice: v.listPrice,
      quantity: v.quantity,
      approved: true,
    }));
}

export interface TrendyolProductPage {
  totalElements?: number;
  totalPages?: number;
  page?: number;
  size?: number;
  content?: TrendyolProduct[];
}

export interface TrendyolSettlementItem {
  id?: string | number;
  barcode?: string;
  transactionDate?: number;
  orderDate?: number;
  commissionRate?: number;
  commissionAmount?: number;
  sellerRevenue?: number;
  credit?: number;
  debt?: number;
  orderNumber?: string | number;
  shipmentPackageId?: string | number;
  transactionType?: string;
  [key: string]: unknown;
}

export interface TrendyolSettlementPage {
  totalElements?: number;
  totalPages?: number;
  page?: number;
  size?: number;
  content?: TrendyolSettlementItem[];
}

export interface TrendyolOrderLine {
  productName?: string;
  barcode?: string;
  merchantSku?: string;
  sku?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  /**
   * SATIR bazlı durum (paket durumundan AYRI): çok kalemli bir siparişte tek kalem iade
   * edilirse paket "Delivered" kalır ama bu alan "Returned"/"Cancelled" olur. Paket tutarı
   * (totalPrice) bu durumda ne oluyor DOĞRULANMADI → tutara dokunulmaz, yalnız işaretlenir.
   */
  orderLineItemStatusName?: string;
}

export interface TrendyolOrder {
  id?: number | string;
  orderNumber?: string;
  /** shipmentPackageStatus: Created, Picking, Invoiced, Shipped, Delivered, Cancelled... */
  status?: string;
  orderDate?: number;
  grossAmount?: number;
  totalPrice?: number;
  totalDiscount?: number;
  customerFirstName?: string;
  customerLastName?: string;
  cargoTrackingNumber?: number | string;
  cargoProviderName?: string;
  lines?: TrendyolOrderLine[];
  [key: string]: unknown;
}

export interface TrendyolOrderPage {
  totalElements?: number;
  totalPages?: number;
  page?: number;
  size?: number;
  content?: TrendyolOrder[];
}

export class TrendyolApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "TrendyolApiError";
  }
}

export class TrendyolClient {
  private readonly baseUrl: string;

  constructor(private readonly credentials: TrendyolCredentials) {
    this.baseUrl =
      credentials.environment === "stage"
        ? "https://stageapigw.trendyol.com"
        : "https://apigw.trendyol.com";
  }

  private headers(): HeadersInit {
    const token = Buffer.from(
      `${this.credentials.apiKey}:${this.credentials.apiSecret}`,
      "utf8"
    ).toString("base64");
    const integratorName =
      this.credentials.integratorName.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 30) ||
      "SelfIntegration";

    return {
      Authorization: `Basic ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `${this.credentials.sellerId} - ${integratorName}`,
    };
  }

  private parseBody(text: string): unknown {
    if (!text.trim()) return {};

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private extractErrorMessage(status: number, body: unknown, fallback: string) {
    if (typeof body === "string") return body.slice(0, 500) || fallback;
    if (typeof body !== "object" || body === null) return fallback;

    const record = body as Record<string, unknown>;
    if (Array.isArray(record.errors)) {
      const messages = record.errors
        .map((item) => {
          if (typeof item === "object" && item !== null && "message" in item) {
            return String((item as { message?: unknown }).message);
          }
          return String(item);
        })
        .filter(Boolean);
      if (messages.length > 0) return messages.join(", ");
    }

    const candidates = [
      record.message,
      record.error,
      record.detail,
      record.exception,
    ];
    const first = candidates.find(Boolean);

    if (Array.isArray(first)) return first.map(String).join(", ");
    if (first && typeof first === "object") return JSON.stringify(first);
    if (first) return String(first);

    if (status === 401) {
      return "Authorization basarisiz. API Key, API Secret ve Satici ID bilgilerini kontrol edin.";
    }
    if (status === 403) {
      return "Trendyol istegi engelledi. User-Agent 'SaticiID - SelfIntegration' formatinda olmali ve hesabinizin API izni acik olmali.";
    }
    if (status === 429) {
      return "Trendyol servis limitine takildi. Biraz bekleyip tekrar deneyin.";
    }

    return fallback;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(20_000);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        cache: "no-store",
        headers: {
          ...this.headers(),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      if (signal.aborted) {
        throw new TrendyolApiError(
          408,
          "Trendyol API isteği 20 saniye içinde yanıt vermedi."
        );
      }
      throw error;
    }

    const text = await response.text();
    const body = this.parseBody(text);

    if (!response.ok) {
      const message = this.extractErrorMessage(response.status, body, response.statusText);
      /**
       * PLANLI BAKIM (brownout) — kullanıcıya ham API metni gösterme.
       *
       * Trendyol eski uçları kapatmadan önce gün içinde birkaç kez kısa süreli (10–15 dk)
       * kapatıyor ve İngilizce bir göç uyarısı döndürüyor. Kullanıcı bunu "bazen çalışıyor,
       * bazen çalışmıyor" olarak yaşıyor. Durum kodu dokümanda garanti edilmediği için
       * gövdedeki metne de bakılıyor.
       */
      const ham = `${message} ${typeof body === "string" ? body : JSON.stringify(body ?? "")}`.toLowerCase();
      if (response.status === 426 || ham.includes("brownout") || ham.includes("product v2")) {
        throw new TrendyolApiError(
          response.status,
          "Trendyol tarafında kısa süreli bakım var, birkaç dakika sonra tekrar deneyin.",
          body
        );
      }
      throw new TrendyolApiError(response.status, `Trendyol API ${response.status}: ${message}`, body);
    }

    return body as T;
  }

  /**
   * ÜRÜN V2 GÖÇÜ (15 Eylül 2026'da eski uç kapanıyor; o tarihe kadar günde 3×15 dk brownout).
   *
   * Eski tek uç (`/products` + `approved` parametresi) DÖRDE bölündü. Bizim kullandıklarımız:
   *   • `/products/approved`                      → onaylı ürünler (başlık, görsel, kategori)
   *   • `/products/approved/inventory-and-price`  → yalnız stok+fiyat (çok daha hafif)
   *
   * Yanıt yapısı KÖKTEN değişti: `content[]` artık düz ürün değil, altında `variants[]` olan
   * bir "içerik". Fiyat/stok varyantta. Çağıranların hiçbiri değişmesin diye burada eski
   * (v1) biçime DÜZLEŞTİRİLİYOR — göçün yüzey alanı tek dosyada kalıyor.
   */
  async listApprovedProducts(params: { page?: number; size?: number; barcode?: string } = {}): Promise<TrendyolProductPage> {
    const sp = new URLSearchParams();
    sp.set("page", String(params.page ?? 0));
    sp.set("size", String(Math.min(100, params.size ?? 100)));
    if (params.barcode) sp.set("barcode", params.barcode);

    const raw = await this.request<TrendyolV2Page<TrendyolV2Content>>(
      `/integration/product/sellers/${this.credentials.sellerId}/products/approved?${sp.toString()}`
    );
    this.assertV2(raw, "onaylı ürün");
    return {
      totalElements: raw.totalElements,
      totalPages: raw.totalPages,
      page: raw.page,
      size: raw.size,
      content: (raw.content ?? []).flatMap((c) => duzlestirOnayli(c)),
    };
  }

  /**
   * Fiyat yenilemesi için HAFİF uç. Dikkat: burada `salePrice`/`listPrice`/`quantity`
   * varyantın ALTINDA DÜZ duruyor (onaylı üründeki `price.` / `stock.` sarmalayıcısı YOK).
   * Bu yüzden ayrı bir düzleştirici gerekiyor.
   */
  async listApprovedInventoryAndPrice(params: { page?: number; size?: number } = {}): Promise<TrendyolProductPage> {
    const sp = new URLSearchParams();
    sp.set("page", String(params.page ?? 0));
    sp.set("size", String(Math.min(100, params.size ?? 100)));

    const raw = await this.request<TrendyolV2Page<TrendyolV2StokFiyat>>(
      `/integration/product/sellers/${this.credentials.sellerId}/products/approved/inventory-and-price?${sp.toString()}`
    );
    this.assertV2(raw, "stok ve fiyat");
    return {
      totalElements: raw.totalElements,
      totalPages: raw.totalPages,
      page: raw.page,
      size: raw.size,
      content: (raw.content ?? []).flatMap((c) => duzlestirStokFiyat(c)),
    };
  }

  private assertV2(raw: unknown, ne: string): void {
    if (typeof raw !== "object" || raw === null || !("content" in raw)) {
      throw new TrendyolApiError(
        502,
        `Trendyol ${ne} listesi beklenen formatta dönmedi. API bilgilerini ve ortam seçimini kontrol edin.`,
        raw
      );
    }
  }

  async getBatchRequestResult(batchRequestId: string): Promise<unknown> {
    return this.request(
      `/integration/product/sellers/${this.credentials.sellerId}/products/batch-requests/${batchRequestId}`
    );
  }

  async listSettlements(params: {
    startDate: number;
    endDate: number;
    page?: number;
    size?: number;
    transactionType?: string;
  }): Promise<TrendyolSettlementPage> {
    const searchParams = new URLSearchParams();
    searchParams.set("startDate", String(params.startDate));
    searchParams.set("endDate", String(params.endDate));
    searchParams.set("transactionType", params.transactionType ?? "Sale");
    searchParams.set("supplierId", this.credentials.sellerId);
    searchParams.set("page", String(params.page ?? 0));
    searchParams.set("size", String(params.size ?? 1000));

    return this.request<TrendyolSettlementPage>(
      `/integration/finance/che/sellers/${this.credentials.sellerId}/settlements?${searchParams.toString()}`
    );
  }

  /** Son siparişler (shipmentPackages). Varsayılan: en son güncellenen 50 sipariş. */
  async listOrders(params: {
    page?: number;
    size?: number;
    status?: string;
    startDate?: number;
    endDate?: number;
    orderByField?: string;
    orderByDirection?: "ASC" | "DESC";
  } = {}): Promise<TrendyolOrderPage> {
    const searchParams = new URLSearchParams();
    searchParams.set("page", String(params.page ?? 0));
    searchParams.set("size", String(params.size ?? 50));
    searchParams.set("orderByField", params.orderByField ?? "PackageLastModifiedDate");
    searchParams.set("orderByDirection", params.orderByDirection ?? "DESC");
    if (params.status) searchParams.set("status", params.status);
    if (params.startDate) searchParams.set("startDate", String(params.startDate));
    if (params.endDate) searchParams.set("endDate", String(params.endDate));

    return this.request<TrendyolOrderPage>(
      `/integration/order/sellers/${this.credentials.sellerId}/v2/orders?${searchParams.toString()}`
    );
  }
}
