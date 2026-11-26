/** Panel verilerinin tipleri — `/api/dashboard`, fiyat hareketleri, Bugün şeridi, sipariş özeti. */
import type { BugunYazici } from "@/lib/panel-bugun";

export type PanelPlatform = "shopify" | "trendyol" | "hepsiburada" | "n11";

export interface PlatformStats {
  platform: PanelPlatform;
  activeListings: number;
  /** Maliyeti girilmediği için kâr hesabına giremeyen ilan sayısı. */
  missingCostListings: number;
  totalProfit: number;
  /** null = o platformda hesaplanacak ciro yok. SIFIR DEĞİL — "—" gösterilir. */
  averageMargin: number | null;
  negativeProfitCount: number;
  thinMarginCount: number;
}

export interface DashboardData {
  computedAt?: string | number | null;
  totalProducts: number;
  inStockCount: number;
  outOfStockCount: number;
  lowStockCount: number;
  lowStockProducts: { id: string; name: string; stock: number; imageUrl: string | null }[];
  lowStockShown: number;
  lowStockMore: number;
  lowStockMoreOutOfStock?: number;
  lowStockMoreLow?: number;
  missingCost: number;
  negativeListings: number;
  grandTotalProfit: number;
  platforms: PlatformStats[];
  problemProducts: {
    id: string;
    name: string;
    listingId?: string;
    platform?: PanelPlatform;
    salePrice: number;
    problem: string;
    profit: number | null;
    margin: number | null;
  }[];
  problemTotal: number;
  problemShown: number;
  problemMore: number;
  problemMoreNegative?: number;
  problemMoreMissingCost?: number;
}

export interface PriceChangeItem {
  productId: string;
  productName: string;
  firstPrice: number;
  lastPrice: number;
  changePercent: number | null;
  changeCount: number;
  lastChangedAt: string;
}

export interface PriceChangesData {
  computedAt?: string | number | null;
  days: number;
  totalChanges: number;
  productsAffected: number;
  recent: PriceChangeItem[];
}

export interface PanelBugun {
  yazici: BugunYazici;
  bitenRenkler: string[];
}

export interface OzetKovasi {
  revenue: number;
  profit: number;
  orderCount: number;
  incompleteOrders?: number;
}

export interface PanelSiparisleri {
  computedAt?: string;
  orders?: {
    platform: string;
    date: string | null;
    statusKind: string;
    total: number;
    profit?: number | null;
    currency?: string | null;
    dataIncomplete?: boolean;
    statusUnknown?: boolean;
    outsideWindow?: boolean;
    previousMonth?: boolean;
    returnLoss?: { loss: number } | null;
  }[];
  summary?: {
    days: number;
    from?: string;
    period?: string;
    shopify: OzetKovasi;
    trendyol: OzetKovasi;
    hepsiburada: OzetKovasi;
    /** n11 öncesi gövdede yok. */
    n11?: OzetKovasi;
    manual?: OzetKovasi;
    total: OzetKovasi;
  };
}

export const PRICE_CHANGES_URL = "/api/dashboard/price-changes?days=30&limit=8";
