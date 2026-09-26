import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { kapaliTurler, kendiKaydim, telefondaKapali } from "../../mobile/src/lib/bildirim-tercih";

/**
 * TELEFONUN KENDİ BİLDİRİM TERCİHİ — "Simay telefonuna yalnız sipariş bildirimi istiyor".
 * (Test `mobile/` altına konulamaz — bkz. mobile/AGENTS.md; kökten sınanır.)
 */
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("telefon kendi kaydını bulur", () => {
  const satirlar = [
    { token: "ExponentPushToken[eski]", cihazId: "c-1", kapali: "baski-bitti", updatedAt: "2026-09-01T10:00:00.000+00:00" },
    { token: "ExponentPushToken[yeni]", cihazId: "c-1", kapali: "baski-sorun", updatedAt: "2026-09-20T10:00:00.000+00:00" },
    { token: "ExponentPushToken[baska]", cihazId: "c-2", kapali: "", updatedAt: "2026-09-25T10:00:00.000+00:00" },
  ];

  it("token biliniyorsa doğrudan onunla", () => {
    expect(kendiKaydim(satirlar, "ExponentPushToken[eski]", "c-1")?.kapali).toBe("baski-bitti");
  });

  it("token henüz yoksa cihaz kimliğiyle — en son açılan kayıt", () => {
    expect(kendiKaydim(satirlar, null, "c-1")?.kapali).toBe("baski-sorun");
  });

  it("hiçbiri yoksa kayıt yok → her şey açık", () => {
    expect(kendiKaydim(satirlar, null, null)).toBeNull();
    expect(kapaliTurler(null)).toEqual([]);
  });

  it("masaüstü eski sürümse (kolon yok) her şey açık", () => {
    expect(kapaliTurler({ token: "x" })).toEqual([]);
  });
});

describe("telefondaki liste tercihle süzülür", () => {
  const kapali = kapaliTurler({ kapali: "baski-bitti,baski-sorun" });

  it("baskı bildirimleri gizlenir, sipariş görünür", () => {
    expect(telefondaKapali({ id: "printer-done:p1:1", type: "printer-done" }, kapali)).toBe(true);
    expect(telefondaKapali({ id: "printer-fault:p1:1", type: "printer-error" }, kapali)).toBe(true);
    expect(telefondaKapali({ id: "print-p1", type: "print" }, kapali)).toBe(true);
    expect(telefondaKapali({ id: "order-new:trendyol:9", type: "order-new" }, kapali)).toBe(false);
  });

  it("stok/filament telefon tercihinde yok — hep görünür", () => {
    expect(telefondaKapali({ id: "stock-p1", type: "stock" }, kapali)).toBe(false);
    expect(telefondaKapali({ id: "filament-pla__siyah", type: "filament" }, kapali)).toBe(false);
  });
});

describe("telefon kaydı", () => {
  const push = oku("mobile/src/lib/push.ts");

  it("var olan satırda ad ve tercih ezilmez; token yenilenince taşınır", () => {
    expect(push).toContain("cihazAdi = COALESCE(cihazAdi, excluded.cihazAdi)");
    expect(push).not.toMatch(/DO UPDATE SET[^`]*kapali\s*=/);
    expect(push).toContain("COALESCE((SELECT kapali FROM PushToken WHERE cihazId = ? AND token <> ?");
    expect(push).toContain("DELETE FROM PushToken WHERE cihazId = ? AND token <> ?");
  });

  it("masaüstü güncellenmemişse eski biçimle kaydolur (bildirimler yine gelir)", () => {
    expect(push).toMatch(/no such column/);
    expect(push).toContain("INSERT INTO PushToken (token, platform, createdAt, updatedAt) VALUES (?, ?, ?, ?)");
  });

  it("liste sorgusu tercih kolonu yoksa düşmez", () => {
    expect(oku("mobile/src/lib/db/notifications.ts")).toContain("sql: `SELECT * FROM PushToken`");
  });
});
