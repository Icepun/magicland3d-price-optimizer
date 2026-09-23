/**
 * YENİ SİPARİŞ BİLDİRİMİ — "her sipariş geldiği anda, bir kez" kuralını sabitler.
 *
 * Sahadaki üç şikâyetin testi (23 Eyl 2026):
 *   - stokta olan ürüne gelen siparişte hiç bildirim yoktu,
 *   - "üretilecek" bildirimi telefona/masaüstüne hiç gitmiyordu,
 *   - stok 0'a düşünce günler önceki siparişin alarmı yeniden doğuyordu.
 * Veritabanı bellek içi taklit: yalnız bildirim tablosunun "tekil kimlik + okundu" davranışı.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  bildirim: new Map<string, { okundu: boolean; severity: string; body: string }>(),
  ayar: new Map<string, string>(),
}));
const push = vi.hoisted(() => ({ gonderilen: [] as Array<{ title: string; body: string }> }));

vi.mock("./prisma", () => ({
  prisma: {
    notification: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => db.bildirim.has(id)).map((id) => ({ id })),
    },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        db.ayar.has(where.key) ? { key: where.key, value: db.ayar.get(where.key)! } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        if (!db.ayar.has(where.key)) db.ayar.set(where.key, create.value);
      },
    },
    $executeRawUnsafe: async (
      _sql: string, id: string, _type: string, severity: string, _title: string, body: string,
      _href: string, _createdAt: string, acknowledgedAt: string | null,
    ) => {
      if (db.bildirim.has(id)) return 0;
      db.bildirim.set(id, { okundu: acknowledgedAt != null, severity, body });
      return 1;
    },
  },
}));
vi.mock("./push-notify", () => ({
  pushToAllDevices: vi.fn(async (title: string, body: string) => {
    push.gonderilen.push({ title, body });
    return {};
  }),
}));

import {
  NEW_ORDER_WINDOW_MS,
  buildNewOrderNotification,
  newOrderNotificationId,
  notifyNewOrders,
  resetNewOrderBaselineCache,
  type NotifyOrder,
} from "./order-notify";

const siparis = (no: string, over: Partial<NotifyOrder> = {}): NotifyOrder => ({
  platform: "trendyol",
  orderNumber: no,
  orderedAtMs: Date.now(),
  actionable: true,
  lines: [{ name: "Ejderha", quantity: 1, product: { id: "p1", name: "Ejderha", stock: 3, madeToOrder: false } }],
  ...over,
});

beforeEach(() => {
  db.bildirim.clear();
  db.ayar.clear();
  push.gonderilen.length = 0;
  resetNewOrderBaselineCache();
});

describe("notifyNewOrders", () => {
  it("İLK çalışmada o an görünen siparişler SESSİZCE işaretlenir — telefon bombalanmaz", async () => {
    const adet = await notifyNewOrders([siparis("A1"), siparis("A2")]);
    expect(adet).toBe(0);
    expect(push.gonderilen).toHaveLength(0);
    expect([...db.bildirim.values()].every((b) => b.okundu)).toBe(true);
  });

  it("taban çizgisinden sonra gelen sipariş bildirilir ve telefona gider", async () => {
    await notifyNewOrders([siparis("A1")]); // taban çizgisi
    const adet = await notifyNewOrders([siparis("A1"), siparis("B7")]);
    expect(adet).toBe(1);
    expect(push.gonderilen).toHaveLength(1);
    expect(push.gonderilen[0].body).toContain("#B7");
    expect(db.bildirim.get("order-new:trendyol:B7")?.okundu).toBe(false);
  });

  it("aynı sipariş İKİNCİ kez bildirilmez (stok sonradan 0'a düşse bile)", async () => {
    await notifyNewOrders([siparis("A1")]);
    await notifyNewOrders([siparis("B7")]);
    push.gonderilen.length = 0;
    const stokBitti = siparis("B7", {
      lines: [{ name: "Ejderha", quantity: 1, product: { id: "p1", name: "Ejderha", stock: 0, madeToOrder: false } }],
    });
    expect(await notifyNewOrders([stokBitti])).toBe(0);
    expect(push.gonderilen).toHaveLength(0);
  });

  it("taban çizgisinden ÖNCE verilmiş sipariş eski sayılır (sessiz)", async () => {
    await notifyNewOrders([siparis("A1")]);
    const eski = siparis("C3", { orderedAtMs: Date.now() - 6 * 60 * 60_000 });
    expect(await notifyNewOrders([eski])).toBe(0);
    expect(db.bildirim.get("order-new:trendyol:C3")?.okundu).toBe(true);
  });

  it("pencereden eski sipariş hiç dokunulmaz", async () => {
    await notifyNewOrders([siparis("A1")]);
    await notifyNewOrders([siparis("D4", { orderedAtMs: Date.now() - NEW_ORDER_WINDOW_MS - 60_000 })]);
    expect(db.bildirim.has("order-new:trendyol:D4")).toBe(false);
  });

  it("üretilecek sipariş de telefona gider (eskiden yalnız zilde kalıyordu)", async () => {
    await notifyNewOrders([siparis("A1")]);
    await notifyNewOrders([
      siparis("E5", { lines: [{ name: "Lamba", quantity: 1, product: { id: "p2", name: "Lamba", stock: 0, madeToOrder: true } }] }),
    ]);
    expect(push.gonderilen).toHaveLength(1);
    expect(push.gonderilen[0].title).toContain("üretilecek");
  });

  it("birikmiş çok sayıda sipariş tek özetle toplanır", async () => {
    await notifyNewOrders([siparis("A1")]);
    await notifyNewOrders(["F1", "F2", "F3", "F4", "F5", "F6"].map((no) => siparis(no)));
    expect(push.gonderilen).toHaveLength(4); // 3 ayrı + 1 özet
    expect(push.gonderilen[3].body).toContain("3 yeni sipariş daha");
  });

  it("paket kimliği değişse de (Trendyol) sipariş NUMARASI aynı olduğu için tek bildirim", async () => {
    await notifyNewOrders([siparis("A1")]);
    await notifyNewOrders([siparis("11563168410")]);
    await notifyNewOrders([siparis("11563168410")]);
    expect(push.gonderilen).toHaveLength(1);
  });
});

describe("Shopify sipariş numarası", () => {
  it("diyezle gelen numara bildirimde tek diyezle yazılır (eskiden \"Shopify ##1124\")", () => {
    const b = buildNewOrderNotification(siparis("#1124", { platform: "shopify" }));
    expect(b.body).toContain("Shopify #1124");
    expect(b.body).not.toContain("##");
  });

  it("diyezli ve diyezsiz numara AYNI bildirim kimliğine düşer (çift bildirim yok)", () => {
    expect(newOrderNotificationId({ platform: "shopify", orderNumber: "#1124" })).toBe(
      newOrderNotificationId({ platform: "shopify", orderNumber: "1124" })
    );
  });
});
