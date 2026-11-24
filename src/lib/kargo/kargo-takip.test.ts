/**
 * KARGO TAKİBİ → SHOPIFY. Gerçek müşteriye mail giden tek otomatik yazım burası; kurallar kilitli:
 *  • Test ortamı gönderisi Shopify'a ASLA yazılmaz.
 *  • Kurye almadan (durum "olusturuldu") Shopify'a dokunulmaz.
 *  • Kurye alınca tek gönderim açılır (takip no = barkod, "Other", HepsiJet bağlantısı, müşteriye bildir).
 *  • İki masaüstü aynı anda koşsa da gönderim BİR kez açılır (satır sahiplenilir).
 *  • Aynı barkodla elle işaretlenmişse yenisi açılmaz, mevcut benimsenir; başka takip no ile
 *    gönderilmişse dokunulmaz.
 *  • Teslimde DELIVERED olayı bir kez yazılır.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-kargo-takip-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const h = vi.hoisted(() => ({
  ortam: "prod" as "test" | "prod",
  takip: { status: "OK", data: [] } as unknown,
  bilgi: null as null | {
    iptal: boolean;
    acikGonderimEmirleri: string[];
    gonderimler: { id: string; takipNo: string | null; teslimEdildi: boolean }[];
  },
  cagrilar: [] as string[],
  gonderimGecikmesiMs: 0,
}));

vi.mock("@/services/hepsijet-settings", () => ({
  hepsijetKimligi: async () => ({ ortam: h.ortam, kullaniciAdi: "k", sifre: "s" }),
}));
vi.mock("@/services/hepsijet-client", () => ({
  HepsijetClient: class {
    async takip(barkodlar: string[]) {
      h.cagrilar.push(`takip:${barkodlar.join(",")}`);
      return h.takip;
    }
  },
}));
vi.mock("@/services/shopify-settings", () => ({ getShopifyCredentials: async () => ({}) }));
vi.mock("@/services/shopify-client", () => ({
  ShopifyClient: class {
    async kargoBilgisi(id: string) {
      h.cagrilar.push(`bilgi:${id}`);
      return h.bilgi ? { id, ad: "#1", adres: null, kalemler: [], ...h.bilgi } : null;
    }
    async gonderimAc(g: { gonderimEmirleri: string[]; takipNo: string; takipUrl: string; musteriyeBildir: boolean }) {
      if (h.gonderimGecikmesiMs) await new Promise((r) => setTimeout(r, h.gonderimGecikmesiMs));
      h.cagrilar.push(`gonderimAc:${g.takipNo}:${g.takipUrl}:${g.musteriyeBildir}:${g.gonderimEmirleri.join(",")}`);
      return "gid://shopify/Fulfillment/77";
    }
    async teslimEdildiIsaretle(id: string) {
      h.cagrilar.push(`teslim:${id}`);
    }
  },
}));

type Db = typeof import("@/lib/prisma").prisma;
let db: Db;
let takip: typeof import("./kargo-takip");

beforeAll(async () => {
  ({ prisma: db } = await import("@/lib/prisma"));
  await (await import("@/lib/runtime-schema")).ensureRuntimeSchema();
  takip = await import("./kargo-takip");
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.cargoShipment.deleteMany({});
  h.ortam = "prod";
  h.takip = { status: "OK", data: [] };
  h.bilgi = { iptal: false, acikGonderimEmirleri: ["gid://shopify/FulfillmentOrder/10"], gonderimler: [] };
  h.cagrilar = [];
  h.gonderimGecikmesiMs = 0;
});

async function gonderi(ek: Partial<{ barcode: string; environment: string; status: string; shopifyFulfillmentId: string | null; kind: string }> = {}) {
  const simdi = Date.now();
  return db.cargoShipment.create({
    data: {
      id: `cs_${Math.random().toString(36).slice(2)}`,
      platform: "shopify",
      externalOrderId: "sh-555",
      orderNumber: "#1227",
      carrier: "hepsijet",
      environment: ek.environment ?? "prod",
      kind: ek.kind ?? "STD",
      barcode: ek.barcode ?? "CPR100000000001",
      status: ek.status ?? "olusturuldu",
      shopifyFulfillmentId: ek.shopifyFulfillmentId ?? null,
      createdAtMs: simdi,
      updatedAtMs: simdi,
    },
  });
}

const kuryeAldi = (barkod = "CPR100000000001", durum = "ACCEPTED") => ({
  status: "OK",
  data: [
    {
      customerDeliveryNo: barkod,
      deliveryStatus: durum,
      operationStatus: "IN_TRANSFER",
      lastTransaction: durum === "DELIVERED" ? "Teslim edildi" : "Kurye teslim aldı",
      transactions: [{ transactionDateTime: "2026-11-25T10:00:00+03:00", transaction: "Kurye teslim aldı", deliveryStatus: "ACCEPTED" }],
    },
  ],
});

const shopifyYazimlari = () => h.cagrilar.filter((c) => c.startsWith("gonderimAc") || c.startsWith("teslim:"));

describe("kargo takibi → Shopify", () => {
  it("kurye almadıysa Shopify'a hiç gidilmez", async () => {
    await gonderi();
    await takip.kargoTakibiTuru();
    expect(h.cagrilar).toEqual(["takip:CPR100000000001"]);
    expect((await db.cargoShipment.findFirstOrThrow()).status).toBe("olusturuldu");
  });

  it("kurye alınca: durum + hareketler yazılır, TEK gönderim açılır (barkod, HepsiJet bağlantısı, bildirim açık)", async () => {
    await gonderi();
    h.takip = kuryeAldi();
    const sonuc = await takip.kargoTakibiTuru();
    expect(sonuc).toMatchObject({ degisen: 1, shopifyGonderildi: 1 });
    expect(shopifyYazimlari()).toEqual([
      "gonderimAc:CPR100000000001:https://hepsijet.com/gonderi-takibi/CPR100000000001:true:gid://shopify/FulfillmentOrder/10",
    ]);
    const s = await db.cargoShipment.findFirstOrThrow();
    expect(s).toMatchObject({ status: "yolda", statusText: "Kurye teslim aldı", shopifyFulfillmentId: "gid://shopify/Fulfillment/77", shopifyError: null });
    expect(s.shopifyShippedAtMs).toBeGreaterThan(0);

    // Sonraki tur: yeniden açılmaz, değişmeyen satıra yazılmaz.
    h.cagrilar = [];
    const ikinci = await takip.kargoTakibiTuru();
    expect(ikinci).toMatchObject({ degisen: 0, shopifyGonderildi: 0 });
    expect(shopifyYazimlari()).toEqual([]);
  });

  it("TEST ortamı gönderisi Shopify'a ASLA yazılmaz", async () => {
    h.ortam = "test";
    await gonderi({ environment: "test" });
    h.takip = kuryeAldi("CPR100000000001", "DELIVERED");
    await takip.kargoTakibiTuru();
    expect((await db.cargoShipment.findFirstOrThrow()).status).toBe("teslim");
    expect(h.cagrilar.some((c) => c.startsWith("bilgi:") || c.startsWith("gonderimAc") || c.startsWith("teslim:"))).toBe(false);
  });

  it("iade (RETURNED) gönderisi Shopify'a yazılmaz", async () => {
    await gonderi({ kind: "RETURNED" });
    h.takip = kuryeAldi();
    await takip.kargoTakibiTuru();
    expect(shopifyYazimlari()).toEqual([]);
  });

  it("iki masaüstü aynı anda: gönderim BİR kez açılır", async () => {
    await gonderi();
    h.takip = kuryeAldi();
    h.gonderimGecikmesiMs = 30;
    const satir = await db.cargoShipment.findFirstOrThrow();
    // İki makineyi taklit: aynı satırı iki ayrı tur aynı anda sahiplenmeye çalışır.
    const g = globalThis as unknown as { __MLHUB_KARGO_TURU__?: unknown };
    const birinci = takip.kargoTakibiTuru();
    g.__MLHUB_KARGO_TURU__ = undefined; // ikinci süreç kendi turunu başlatsın
    const ikinci = takip.kargoTakibiTuru();
    await Promise.all([birinci, ikinci]);
    expect(h.cagrilar.filter((c) => c.startsWith("gonderimAc"))).toHaveLength(1);
    expect((await db.cargoShipment.findUniqueOrThrow({ where: { id: satir.id } })).shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/77");
  });

  it("aynı barkodla elle işaretlenmişse yenisi açılmaz, mevcut benimsenir", async () => {
    await gonderi();
    h.takip = kuryeAldi();
    h.bilgi = { iptal: false, acikGonderimEmirleri: [], gonderimler: [{ id: "gid://shopify/Fulfillment/5", takipNo: "CPR100000000001", teslimEdildi: false }] };
    await takip.kargoTakibiTuru();
    expect(shopifyYazimlari()).toEqual([]);
    expect((await db.cargoShipment.findFirstOrThrow()).shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/5");
  });

  it("başka takip numarasıyla gönderilmişse dokunulmaz ve bir daha denenmez", async () => {
    await gonderi();
    h.takip = kuryeAldi();
    h.bilgi = { iptal: false, acikGonderimEmirleri: [], gonderimler: [{ id: "gid://shopify/Fulfillment/5", takipNo: "ARAS999", teslimEdildi: false }] };
    await takip.kargoTakibiTuru();
    const s = await db.cargoShipment.findFirstOrThrow();
    expect(s.shopifyFulfillmentId).toBe(takip.SHOPIFY_ATLA);
    expect(s.shopifyError).toMatch(/başka takip numarasıyla/);
    h.cagrilar = [];
    await takip.kargoTakibiTuru();
    expect(h.cagrilar.some((c) => c.startsWith("bilgi:"))).toBe(false);
  });

  it("teslimde DELIVERED bir kez yazılır", async () => {
    await gonderi({ status: "yolda", shopifyFulfillmentId: "gid://shopify/Fulfillment/77" });
    h.takip = kuryeAldi("CPR100000000001", "DELIVERED");
    const sonuc = await takip.kargoTakibiTuru();
    expect(sonuc.shopifyTeslim).toBe(1);
    expect(shopifyYazimlari()).toEqual(["teslim:gid://shopify/Fulfillment/77"]);
    const s = await db.cargoShipment.findFirstOrThrow();
    expect(s.status).toBe("teslim");
    expect(s.shopifyDeliveredAtMs).toBeGreaterThan(0);
    h.cagrilar = [];
    await takip.kargoTakibiTuru();
    expect(shopifyYazimlari()).toEqual([]);
  });

  it("kurye almadan teslim (iki tur arası) → önce gönderim, sonraki turda teslim", async () => {
    await gonderi();
    h.takip = kuryeAldi("CPR100000000001", "DELIVERED");
    await takip.kargoTakibiTuru();
    expect(shopifyYazimlari()).toEqual([expect.stringMatching(/^gonderimAc:/)]);
    h.cagrilar = [];
    await takip.kargoTakibiTuru();
    expect(shopifyYazimlari()).toEqual(["teslim:gid://shopify/Fulfillment/77"]);
  });
});
