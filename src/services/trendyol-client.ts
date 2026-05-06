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
}

export interface TrendyolProductPage {
  totalElements?: number;
  totalPages?: number;
  page?: number;
  size?: number;
  content?: TrendyolProduct[];
}

export interface TrendyolPriceInventoryItem {
  barcode: string;
  quantity?: number;
  salePrice?: number;
  listPrice?: number;
}

export interface TrendyolBatchResponse {
  batchRequestId?: string;
  [key: string]: unknown;
}

export interface TrendyolSettlementItem {
  barcode?: string;
  transactionDate?: number;
  orderDate?: number;
  commissionRate?: number;
  commissionAmount?: number;
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...this.headers(),
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    const body = this.parseBody(text);

    if (!response.ok) {
      const message = this.extractErrorMessage(response.status, body, response.statusText);
      throw new TrendyolApiError(response.status, `Trendyol API ${response.status}: ${message}`, body);
    }

    return body as T;
  }

  async listProducts(params: {
    page?: number;
    size?: number;
    approved?: boolean;
    archived?: boolean;
    barcode?: string;
  } = {}): Promise<TrendyolProductPage> {
    const searchParams = new URLSearchParams();
    if (params.approved !== undefined) {
      searchParams.set("approved", String(params.approved));
    }
    searchParams.set("page", String(params.page ?? 0));
    searchParams.set("size", String(params.size ?? 100));
    if (params.barcode) searchParams.set("barcode", params.barcode);

    const result = await this.request<TrendyolProductPage>(
      `/integration/product/sellers/${this.credentials.sellerId}/products?${searchParams.toString()}`
    );
    if (typeof result !== "object" || result === null || !("content" in result)) {
      throw new TrendyolApiError(
        502,
        "Trendyol urun listesi beklenen formatta donmedi. API bilgileri ve ortam secimini kontrol edin.",
        result
      );
    }

    return result;
  }

  async updatePriceAndInventory(
    items: TrendyolPriceInventoryItem[]
  ): Promise<TrendyolBatchResponse> {
    return this.request<TrendyolBatchResponse>(
      `/integration/inventory/sellers/${this.credentials.sellerId}/products/price-and-inventory`,
      {
        method: "POST",
        body: JSON.stringify({ items }),
      }
    );
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
}
