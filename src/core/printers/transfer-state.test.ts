/**
 * AKTARIM SÜRERKEN YAZICIYA DURUM SORGUSU BİNDİRME.
 *
 * Ölçüldü (21 Ağu 2026): Snapmaker U1'e büyük bir dosya yüklenirken yazıcı %40-50
 * civarında ağdan tamamen düştü — ICMP yok, 7125/80/22'nin üçü de "bağlantı reddedildi"
 * DEĞİL zaman aşımı verdi (adreste yanıt veren cihaz kalmamış), aynı anda Neptune 4 Pro
 * 2 ms'de yanıtlıyordu. Aktarım da o anda iptal oldu.
 *
 * Biz de tam o sırada yükü artırıyorduk: panel her turda, relay 10 saniyede bir aynı
 * yazıcıyı yokluyordu. `commandInFlight` freni yalnız duraklat/iptal komutlarını kapsıyor.
 *
 * Bu dosya iki şeyi kilitler:
 *  1) Aktarım sürerken durum yoklaması YAPILMAZ (yazıcıya binen yük kalkar).
 *  2) Kart "Yazıcıya ulaşılamadı" yalanını söylemez — son bilinen durum döner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn(), extras: vi.fn(async () => ({ caps: { discovered: true }, read: true })) }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    printFileProduct: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
    printerConfig: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("./moonraker", () => ({
  fetchMoonrakerStatus: (host: string, port: number) => h.probe(host, port),
  fetchMoonrakerMeta: vi.fn(async () => null),
  moonrakerThumbUrl: vi.fn(() => ""),
  fetchMoonrakerExtras: () => h.extras(),
  emptyMoonrakerExtras: () => ({}),
  parseStatus: vi.fn(() => ({ online: true })),
  moonrakerPortu: (_host: string, port: number) => port,
}));

vi.mock("./bambu", () => ({
  getBambuStatus: vi.fn(async () => ({ online: false })),
  getBambuAmsSlots: vi.fn(async () => []),
}));

import { getMoonrakerStatusCached, resetPrinterStatusCache } from "./status-cache";
import { aktarimBasladi, aktarimBitti, aktarimSuruyor, aktarimlariSifirla } from "./transfer-state";

const ONLINE = { online: true, state: "printing" };

beforeEach(() => {
  resetPrinterStatusCache();
  aktarimlariSifirla();
  h.probe.mockReset();
  h.probe.mockResolvedValue(ONLINE);
});

afterEach(() => {
  aktarimlariSifirla();
});

describe("aktarım kaydı", () => {
  it("başlayınca sürüyor, bitince bitiyor", () => {
    expect(aktarimSuruyor("10.0.0.5")).toBe(false);
    aktarimBasladi("10.0.0.5");
    expect(aktarimSuruyor("10.0.0.5")).toBe(true);
    aktarimBitti("10.0.0.5");
    expect(aktarimSuruyor("10.0.0.5")).toBe(false);
  });

  it("yalnız o yazıcıyı kapsar", () => {
    aktarimBasladi("10.0.0.5");
    expect(aktarimSuruyor("10.0.0.6")).toBe(false);
  });

  it("EMNİYET KEMERİ: süre dolarsa yoklama sonsuza dek susmaz", () => {
    // `aktarimBitti` bir şekilde çağrılmazsa (süreç çöktü, kod yolu atlandı) kayıt
    // kendiliğinden düşmeli — yoksa yazıcı o oturumda bir daha hiç yoklanmaz.
    aktarimBasladi("10.0.0.5", 5);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 50);
    expect(aktarimSuruyor("10.0.0.5")).toBe(false);
    vi.useRealTimers();
  });
});

describe("durum önbelleği aktarım sırasında", () => {
  it("aktarım sürerken YAZICIYA SORULMAZ, son bilinen durum döner", async () => {
    // Önce bir kez gerçek okuma yapılsın (önbellek dolsun).
    const ilk = await getMoonrakerStatusCached("10.0.0.5", 7125);
    expect(ilk).toEqual(ONLINE);
    const oncekiSorgu = h.probe.mock.calls.length;

    // Aktarım başladı: yazıcı artık cevap veremiyor olsa bile kart bozulmamalı.
    aktarimBasladi("10.0.0.5");
    h.probe.mockRejectedValue(new Error("ulaşılamıyor"));

    for (let i = 0; i < 3; i++) {
      const d = await getMoonrakerStatusCached("10.0.0.5", 7125);
      expect(d, "aktarım sırasında son bilinen durum korunmalı").toEqual(ONLINE);
    }
    expect(h.probe.mock.calls.length, "aktarım sürerken yazıcıya HİÇ sorulmamalı").toBe(oncekiSorgu);
  });

  it("aktarım bitince yoklama yeniden başlar", async () => {
    await getMoonrakerStatusCached("10.0.0.5", 7125);
    aktarimBasladi("10.0.0.5");
    await getMoonrakerStatusCached("10.0.0.5", 7125);
    const susarken = h.probe.mock.calls.length;

    aktarimBitti("10.0.0.5");
    // Önbellek tazeliği geçsin diye zamanı ileri al.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    await getMoonrakerStatusCached("10.0.0.5", 7125);
    vi.useRealTimers();
    expect(h.probe.mock.calls.length).toBeGreaterThan(susarken);
  });

  it("hiç önbellek yoksa aktarım sırasında da bir kez sorar (kart boş kalmasın)", async () => {
    aktarimBasladi("10.0.0.9");
    await getMoonrakerStatusCached("10.0.0.9", 7125);
    expect(h.probe.mock.calls.length).toBeGreaterThan(0);
  });
});
