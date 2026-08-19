/**
 * Yazıcı durumu önbelleği — İKİ gerilemenin koruması.
 *
 * 1) MADDE 6: kontrol komutundan hemen önce alınan durum 4 saniye daha "taze" sayılıyordu.
 *    Kullanıcı "Duraklat"a bastıktan sonra kart eski duruma geri zıplıyor, komut çalışmamış
 *    gibi görünüyordu. Komut gönderilince o yazıcının önbelleği ATILMALI.
 *
 * 2) MADDE 20: kapalı bir yazıcı 30 saniyede bir yeniden yoklanıyordu ve bu yoklama İSTEĞİ
 *    BEKLETİYORDU — çevrimdışı tek yazıcı, panelin tamamını (diğer üç yazıcıyı da) ~3 saniye
 *    geciktiriyordu. Artık: üstel geri çekilme + tazeleme ARKA PLANDA, çağırana son bilinen
 *    durum ANINDA döner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn() }));

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
  fetchMoonrakerExtras: vi.fn(async () => ({})),
  emptyMoonrakerExtras: () => ({}),
}));

vi.mock("./bambu", () => ({
  getBambuStatus: vi.fn(async () => ({ online: false })),
  getBambuAmsSlots: vi.fn(async () => []),
}));

import {
  getMoonrakerStatusCached, bumpMoonrakerStatus, resetPrinterStatusCache,
} from "./status-cache";

const ONLINE = { online: true, state: "printing" };
const OFFLINE = { online: false, state: "standby" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
  resetPrinterStatusCache();
  h.probe.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MADDE 6 — komut sonrası önbellek", () => {
  it("çevrimiçi durum 4 saniye taze sayılır (tek yoklama)", async () => {
    h.probe.mockResolvedValue(ONLINE);
    await getMoonrakerStatusCached("10.0.0.1", 7125);
    vi.setSystemTime(Date.now() + 2_000);
    await getMoonrakerStatusCached("10.0.0.1", 7125);
    expect(h.probe).toHaveBeenCalledTimes(1);
  });

  it("komut gönderilince önbellek ATILIR — kart eski duruma zıplamaz", async () => {
    h.probe.mockResolvedValue(ONLINE);
    await getMoonrakerStatusCached("10.0.0.1", 7125);
    expect(h.probe).toHaveBeenCalledTimes(1);

    bumpMoonrakerStatus("10.0.0.1", 7125);
    await getMoonrakerStatusCached("10.0.0.1", 7125);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("komuttan sonraki pencerede daha SIK yoklanır", async () => {
    h.probe.mockResolvedValue(ONLINE);
    bumpMoonrakerStatus("10.0.0.1", 7125);
    await getMoonrakerStatusCached("10.0.0.1", 7125);
    vi.setSystemTime(Date.now() + 1_000); // normalde 4sn taze sayılırdı
    await getMoonrakerStatusCached("10.0.0.1", 7125);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });
});

describe("MADDE 20 — çevrimdışı yazıcı diğerlerini yavaşlatmaz", () => {
  it("çevrimdışı sonuç geri çekilme süresince yeniden yoklanmaz", async () => {
    h.probe.mockResolvedValue(OFFLINE);
    await getMoonrakerStatusCached("10.0.0.9", 7125);
    expect(h.probe).toHaveBeenCalledTimes(1);

    // İlk geri çekilme aralığı 5 sn (eskiden 8'di; ekranda görülen kopukluk süresini bu
    // sayı belirlediği için kısaltıldı — yazıcılar LAN'da, sık denemek maliyetsiz).
    vi.setSystemTime(Date.now() + 3_000);
    await getMoonrakerStatusCached("10.0.0.9", 7125);
    expect(h.probe).toHaveBeenCalledTimes(1);
  });

  it("geri çekilme aralığı her başarısızlıkta İKİ KATINA çıkar", async () => {
    h.probe.mockResolvedValue(OFFLINE);
    await getMoonrakerStatusCached("10.0.0.9", 7125); // 1. başarısızlık → 5sn
    vi.setSystemTime(Date.now() + 6_000);
    await getMoonrakerStatusCached("10.0.0.9", 7125); // arka plan yoklaması (2. başarısızlık) → 10sn
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 6_000); // 10sn dolmadı
    await getMoonrakerStatusCached("10.0.0.9", 7125);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("çevrimdışı yazıcının yeniden denemesi İSTEĞİ BEKLETMEZ", async () => {
    h.probe.mockResolvedValueOnce(OFFLINE);
    const first = await getMoonrakerStatusCached("10.0.0.9", 7125);
    expect(first).toEqual(OFFLINE);

    // Sonraki yoklama ASLA çözülmesin (kapalı yazıcının zaman aşımını taklit eder).
    h.probe.mockImplementation(() => new Promise(() => {}));
    vi.setSystemTime(Date.now() + 9_000);

    // Beklemeden dönmeli: son bilinen durum anında verilir, tazeleme arka planda sürer.
    const second = await getMoonrakerStatusCached("10.0.0.9", 7125);
    expect(second).toEqual(OFFLINE);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });
});
