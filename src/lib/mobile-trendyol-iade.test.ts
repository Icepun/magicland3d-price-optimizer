import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TRENDYOL_STATUS_KINDS } from "@/core/order-status-kind";

/**
 * TELEFONUN TRENDYOL İADELERİ — masaüstüyle AYNI kural (`core/trendyol-iade.ts`).
 *
 * Trendyol iade edilen paketi "Delivered" bırakıyor; telefon iade taleplerine bakmazsa iade
 * edilen sipariş telefonun cirosunda ve yazdığı finans geçmişinde "satıldı" kalır — üstelik
 * masaüstünün "iade" yazdığı kaydı yeniden satışa çevirir. Bu dosya telefonun GERÇEK
 * `getTrendyolOrders` fonksiyonunu çalıştırır; yalnız ağ katmanı (`fetchT`) sahte.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

type Satir = Record<string, unknown>;

const h = vi.hoisted(() => ({
  siparisler: [] as Satir[],
  talepler: [] as Satir[] | { status: number },
  istekler: [] as string[],
}));

vi.mock("@/lib/api/http", () => ({
  fetchT: async (url: string) => {
    h.istekler.push(url);
    const yanit = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const u = new URL(url);
    if (u.pathname.endsWith("/claims")) {
      if (!Array.isArray(h.talepler)) return yanit(h.talepler.status, {});
      return yanit(200, { content: h.talepler, totalPages: 1 });
    }
    // Her pencere aynı siparişleri döndürse de telefon paket kimliğiyle tekilleştirir.
    return yanit(200, { content: u.searchParams.get("page") === "0" ? h.siparisler : [] });
  },
}));

/** Telefon modülü `@/…` takma adlarını telefonun kökünden çözer — yol bu yüzden değişkende. */
const TELEFON_TY_MODULU = "../../mobile/src/lib/api/trendyol";
interface TelefonSiparisi {
  id: string;
  status: string;
  total: number;
}

async function telefonSiparisleri(): Promise<TelefonSiparisi[]> {
  const m = (await import(/* @vite-ignore */ TELEFON_TY_MODULU)) as {
    getTrendyolOrders: (gun: number) => Promise<TelefonSiparisi[]>;
  };
  return m.getTrendyolOrders(30);
}

const iptalMi = (status: string) => TRENDYOL_STATUS_KINDS[status]?.kind === "cancelled";

const paket = (id: number, status: string, adet: number) => ({
  id,
  orderNumber: `S-${id}`,
  orderDate: Date.now() - 3 * 86_400_000,
  status,
  totalPrice: 249.99 * adet,
  lines: [{ productName: "Kol Standı", quantity: adet, price: 249.99, barcode: "B1" }],
});

const talep = (paketId: number, durumlar: string[]) => ({
  orderNumber: `S-${paketId}`,
  orderOutboundPackageId: paketId,
  orderShipmentPackageId: paketId + 1_000,
  items: [
    {
      orderLine: { id: paketId * 10 },
      claimItems: durumlar.map((name, i) => ({ id: `${paketId}-${i}`, claimItemStatus: { name } })),
    },
  ],
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TRENDYOL_SELLER_ID", "123");
  vi.stubEnv("EXPO_PUBLIC_TRENDYOL_API_KEY", "k");
  vi.stubEnv("EXPO_PUBLIC_TRENDYOL_API_SECRET", "s");
  h.siparisler = [];
  h.talepler = [];
  h.istekler = [];
});

describe("telefon Trendyol iadeleri", () => {
  it("bütün adetleri kabul edilmiş iade → İade (ciro dışı); kısmi iade ve iptal edilmiş talep dokunulmaz", async () => {
    h.siparisler = [paket(1, "Delivered", 2), paket(2, "Delivered", 2), paket(3, "Delivered", 1)];
    h.talepler = [
      talep(1, ["Accepted", "Accepted"]),
      talep(2, ["Accepted"]),
      talep(3, ["Cancelled"]),
    ];

    const siparisler = await telefonSiparisleri();
    const durum = Object.fromEntries(siparisler.map((o) => [o.id, o.status]));

    expect(durum).toEqual({ "ty-1": "Returned", "ty-2": "Delivered", "ty-3": "Delivered" });
    expect(iptalMi(durum["ty-1"])).toBe(true);
    // Telefonun ciro süzgeci aynı adları iptal sayıyor mu?
    expect(oku("mobile/src/lib/api/orders.ts")).toContain('"Returned"');
  });

  it("zaten iptal görünen paketin adı korunur", async () => {
    h.siparisler = [paket(4, "UnDelivered", 1)];
    h.talepler = [talep(4, ["Accepted"])];
    const [o] = await telefonSiparisleri();
    expect(o.status).toBe("UnDelivered");
  });

  it("iade ucu alınamazsa siparişler ETKİLENMEZ", async () => {
    h.siparisler = [paket(5, "Delivered", 1)];
    h.talepler = { status: 500 };
    const [o] = await telefonSiparisleri();
    expect(o.status).toBe("Delivered");
    expect(h.istekler.some((u) => u.includes("/claims"))).toBe(true);
  });

  it("çekirdek kopyası masaüstüyle birebir", () => {
    expect(oku("mobile/src/core/trendyol-iade.ts")).toBe(oku("src/core/trendyol-iade.ts"));
  });
});
