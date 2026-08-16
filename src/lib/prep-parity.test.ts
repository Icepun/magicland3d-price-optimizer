import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HEPSIBURADA_STATUS_KINDS,
  MANUAL_STATUS_KINDS,
  SHOPIFY_STATUS_KINDS,
  TRENDYOL_STATUS_KINDS,
} from "@/core/order-status-kind";
import { PREP_STATUSES, buildPrepItems } from "@/core/prep-list";

/**
 * HAZIRLIK LİSTESİ PARİTESİ — masaüstü ve telefon AYNI siparişleri, AYNI adetlerle listelemeli.
 *
 * NEDEN ÖNEMLİ: kullanıcı paketlemeye masada başlayıp atölyede telefonla bitiriyor. Bir cihaz
 * "Paket Bölündü" siparişini kapsama alıp diğeri almazsa o ürün hiç toplanmaz ve eksik kargo
 * çıkar. Bu yüzden hem gruplama (`core/prep-list`) hem durum kovaları (`core/order-status-kind`)
 * ortak; buradaki testler ORTAK OLMA durumunun bozulmadığını denetler.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("durum kovaları tek kaynaktan", () => {
  it("masaüstü sipariş rotası kendi durum tablosunu TUTMAZ", () => {
    const route = oku("src/app/api/orders/route.ts");
    expect(route).toContain('from "@/core/order-status-kind"');
    // Tabloyu yeniden tanımlayan bir kopya kalmadı (yalnız çekirdeğe bağlanan takma adlar).
    expect(route).not.toMatch(/const TRENDYOL_STATUS: Record</);
    expect(route).not.toMatch(/const HB_STATUS: Record</);
    expect(route).not.toMatch(/const MANUAL_STATUS: Record</);
  });

  it("telefon hazırlık kovalarını çekirdekten okur", () => {
    const prep = oku("mobile/src/lib/prep.ts");
    expect(prep).toContain('from "@core/order-status-kind"');
    expect(prep).toContain('from "@core/prep-list"');
    // Kendi eşleme tablosunu kurmuyor.
    expect(prep).not.toMatch(/Record<string, (?:StatusInfo|OrderStatusKind)>\s*=\s*\{/);
  });

  it("mobil çekirdek kopyası masaüstüyle birebir", () => {
    expect(oku("mobile/src/core/order-status-kind.ts")).toBe(oku("src/core/order-status-kind.ts"));
    expect(oku("mobile/src/core/prep-list.ts")).toBe(oku("src/core/prep-list.ts"));
  });
});

describe("hazırlık kapsamı", () => {
  it("hazırlık yalnız gönderilmemiş siparişleri kapsar", () => {
    expect(PREP_STATUSES).toEqual(["pending", "processing"]);
  });

  /**
   * "Paket Bölündü" (UnPacked) İPTAL DEĞİL — sipariş birden çok pakete ayrılıyor ve hâlâ
   * hazırlanması gerekiyor. Bir zamanlar iptal kovasındaydı; ciroyu düşürüyor ve bu satırı
   * hazırlık listesinden düşürüyordu.
   */
  it("Paket Bölündü hazırlık kapsamında kalır", () => {
    expect(TRENDYOL_STATUS_KINDS.UnPacked.kind).toBe("processing");
    expect(PREP_STATUSES).toContain(TRENDYOL_STATUS_KINDS.UnPacked.kind);
  });

  it("kargoya verilmiş ve iptal siparişler listeye girmez", () => {
    const disarida = [
      TRENDYOL_STATUS_KINDS.Shipped.kind,
      TRENDYOL_STATUS_KINDS.Cancelled.kind,
      HEPSIBURADA_STATUS_KINDS.Delivered.kind,
      HEPSIBURADA_STATUS_KINDS.Returned.kind,
      MANUAL_STATUS_KINDS.shipped.kind,
      SHOPIFY_STATUS_KINDS.FULFILLED,
      SHOPIFY_STATUS_KINDS.REFUNDED,
    ];
    for (const kind of disarida) expect(PREP_STATUSES).not.toContain(kind);
  });

  it("yeni ve hazırlanan siparişler her platformda listeye girer", () => {
    const iceride = [
      TRENDYOL_STATUS_KINDS.Created.kind,
      TRENDYOL_STATUS_KINDS.Picking.kind,
      HEPSIBURADA_STATUS_KINDS.Open.kind,
      HEPSIBURADA_STATUS_KINDS.Packaged.kind,
      MANUAL_STATUS_KINDS.pending.kind,
      SHOPIFY_STATUS_KINDS.UNFULFILLED,
      SHOPIFY_STATUS_KINDS.PARTIALLY_FULFILLED,
    ];
    for (const kind of iceride) expect(PREP_STATUSES).toContain(kind);
  });

  it("aynı ürün farklı siparişlerde tek satırda toplanır", () => {
    const liste = buildPrepItems([
      {
        orderNumber: "TY-1",
        statusKind: TRENDYOL_STATUS_KINDS.Created.kind,
        items: [{ name: "Vazo", quantity: 2, image: null, productId: "p1" }],
      },
      {
        orderNumber: "HB-9",
        statusKind: HEPSIBURADA_STATUS_KINDS.Packaged.kind,
        items: [{ name: "Vazo", quantity: 1, image: null, productId: "p1" }],
      },
      {
        orderNumber: "TY-2",
        statusKind: TRENDYOL_STATUS_KINDS.Shipped.kind, // kargoda → sayılmaz
        items: [{ name: "Vazo", quantity: 5, image: null, productId: "p1" }],
      },
    ]);
    expect(liste).toHaveLength(1);
    expect(liste[0].quantity).toBe(3);
    expect(liste[0].orderNumbers).toEqual(["TY-1", "HB-9"]);
  });
});
