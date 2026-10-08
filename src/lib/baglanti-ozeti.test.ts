import { describe, expect, it } from "vitest";

import { baglantiDurumu } from "./baglanti-ozeti";

const SIMDI = Date.parse("2026-10-09T15:00:00.000Z");

describe("entegrasyon durum özeti", () => {
  it("sipariş çekimi sağlam, eşitleme taze → iyi", () => {
    const d = baglantiDurumu({ bagli: true, siparis: { ok: true, count: 129 }, sonEsitlemeIso: "2026-10-08T10:00:00.000Z", nowMs: SIMDI });
    expect(d).toEqual({ ton: "iyi", bagli: true, siparisMetni: "129 sipariş çekildi", esitlemeGun: 1 });
  });

  it("fiyat eşitlemesi 13 gün önce → uyarı (denetimdeki durum)", () => {
    const d = baglantiDurumu({ bagli: true, siparis: { ok: true, count: 252 }, sonEsitlemeIso: "2026-09-26T22:28:22.550Z", nowMs: SIMDI });
    expect(d.ton).toBe("uyari");
    expect(d.esitlemeGun).toBe(12);
  });

  it("sipariş çekimi hata → hata; bağlı değilse kapalı", () => {
    expect(baglantiDurumu({ bagli: true, siparis: { ok: false }, sonEsitlemeIso: null, nowMs: SIMDI }).ton).toBe("hata");
    expect(baglantiDurumu({ bagli: false, siparis: null, sonEsitlemeIso: null, nowMs: SIMDI }).ton).toBe("kapali");
  });
});
