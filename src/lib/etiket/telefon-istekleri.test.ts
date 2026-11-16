import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  yaziciDurumu: vi.fn(),
  trendyolBas: vi.fn(),
  hbBas: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  remotePrisma: {
    labelPrintRequest: { findMany: h.findMany, updateMany: h.updateMany, update: h.update },
  },
}));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/etiket/ham-yazici", () => ({ yaziciDurumu: h.yaziciDurumu }));
vi.mock("@/lib/etiket/bas", () => {
  class EtiketBasilamadi extends Error {}
  return { EtiketBasilamadi, trendyolEtiketiBas: h.trendyolBas, hbEtiketiBas: h.hbBas };
});

import { bekleyenleriIsle } from "./telefon-istekleri";
import { ETIKET_ISTEGI_OMRU_MS } from "@/core/etiket-uygunluk";

const istek = (o: Record<string, unknown> = {}) => ({
  id: "r1",
  platform: "trendyol",
  orderNumber: "11223344",
  labelKey: "7330039048986936",
  trackingNumber: "7330039048986936",
  packageNumber: null,
  createdAtMs: Date.now() - 3_000,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.yaziciDurumu.mockResolvedValue({ yazicilar: ["Xprinter XP-490B"], secili: "Xprinter XP-490B", elleSecildi: true });
  h.updateMany.mockResolvedValue({ count: 1 });
  h.update.mockResolvedValue({});
  h.trendyolBas.mockResolvedValue({ anahtar: "7330039048986936", basildi: "", etiketSayisi: 1 });
  h.hbBas.mockResolvedValue({ anahtar: "62755431389885", basildi: "", etiketSayisi: 1 });
});

describe("telefondan etiket istekleri", () => {
  it("Trendyol isteğini sahiplenir, basar ve 'done' yazar", async () => {
    h.findMany.mockResolvedValue([istek()]);
    await bekleyenleriIsle();
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", status: "pending" }, data: expect.objectContaining({ status: "running" }) })
    );
    expect(h.trendyolBas).toHaveBeenCalledWith("7330039048986936");
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" }, data: expect.objectContaining({ status: "done" }) })
    );
  });

  it("Hepsiburada isteği paket no + teslimat no ile basılır", async () => {
    h.findMany.mockResolvedValue([
      istek({ platform: "hepsiburada", packageNumber: "5543138988", trackingNumber: "62755431389885", labelKey: "62755431389885" }),
    ]);
    await bekleyenleriIsle();
    expect(h.hbBas).toHaveBeenCalledWith("5543138988", "62755431389885");
  });

  it("ömrü geçmiş istek BASILMAZ, 'basılmadı' hatası yazılır", async () => {
    h.findMany.mockResolvedValue([istek({ createdAtMs: Date.now() - ETIKET_ISTEGI_OMRU_MS - 1_000 })]);
    await bekleyenleriIsle();
    expect(h.trendyolBas).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error" }) })
    );
    expect(h.yaziciDurumu).not.toHaveBeenCalled();
  });

  it("etiket yazıcısı olmayan bilgisayar isteği SAHİPLENMEZ (yazıcılı masaüstüne bırakır)", async () => {
    h.yaziciDurumu.mockResolvedValue({ yazicilar: ["HP LaserJet"], secili: null, elleSecildi: false });
    h.findMany.mockResolvedValue([istek()]);
    await bekleyenleriIsle();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.trendyolBas).not.toHaveBeenCalled();
  });

  it("başka masaüstü aldıysa (koşullu güncelleme 0 satır) basmaz — çift baskı yok", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    h.findMany.mockResolvedValue([istek()]);
    await bekleyenleriIsle();
    expect(h.trendyolBas).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("baskı hatası isteğe mesajıyla yazılır", async () => {
    h.trendyolBas.mockRejectedValue(new Error("ağ"));
    h.findMany.mockResolvedValue([istek()]);
    await bekleyenleriIsle();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error", error: "Etiket basılamadı. Tekrar dene." }) })
    );
  });

  it("bekleyen yoksa işletim sistemine yazıcı sorulmaz", async () => {
    h.findMany.mockResolvedValue([]);
    await bekleyenleriIsle();
    expect(h.yaziciDurumu).not.toHaveBeenCalled();
  });
});
