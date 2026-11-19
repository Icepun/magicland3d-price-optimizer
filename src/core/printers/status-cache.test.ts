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

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  // `mergeMoonrakerExtras` GERÇEK kod ve `next.caps`/`next.read` okuyor; boş nesne
  // fırlatıyor ve extras önbelleği hiç dolmuyordu (test sessizce yanlış şeyi ölçerdi).
  extras: vi.fn(async () => ({ caps: { discovered: true }, read: true })),
}));

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
  // Kalıcı WebSocket hızlı yolu bu ikisini çağırıyor; taklitte YOKSA modül `undefined`
  // döndürür ve durum önbelleğinin tamamı patlar.
  parseStatus: vi.fn(() => ({ online: true })),
  moonrakerPortu: (_host: string, port: number) => port,
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

/**
 * SAYFA AÇILIŞI (`?fresh=1`) yan önbellekleri SÜPÜRMEMELİ.
 *
 * Ölçüldü (20 Ağu 2026): fresh mount 0,263/0,371/0,285 sn ↔ düz tur 0,0069/0,0063/0,0076 sn.
 * Aradaki farkın tamamı, tam sıfırlamanın extras ve Bambu slot önbelleklerini de silmesinden
 * geliyordu — o ikisi isabet yoksa yanıtı BEKLETİYOR. Fresh'in asıl işi bayat DURUMU ve
 * çevrimdışı geri çekilmesini kırmak; yan bilgiler (ışık ≤15 sn, slot renkleri ≤60 sn)
 * arka planda tazelenip bir sonraki yoklamada düzeliyor.
 */
describe("fresh mount hafif olmalı", () => {
  it("bumpStatusOnly yan önbellekleri SİLMEZ, tam sürüm siler", async () => {
    // ⚠️ Anahtarı ELLE kurma: biçim tutmazsa silme sessizce hiçbir şey yapmaz ve test
    // "önbellek korundu" diye YANLIŞ yere yeşil yanar. Dışa açık yardımcılar kullanılıyor.
    const { getMoonrakerExtrasCached, bumpMoonrakerStatusOnly, bumpMoonrakerStatus } =
      await import("./status-cache");

    // Extras önbelleğini doldur (ilk çağrı ağa gider, ikincisi isabet).
    await getMoonrakerExtrasCached("10.0.0.5", 7125);
    const ilk = h.extras.mock.calls.length;
    await getMoonrakerExtrasCached("10.0.0.5", 7125);
    expect(h.extras.mock.calls.length, "ikinci çağrı önbellekten gelmeli").toBe(ilk);

    // Hafif bump: extras KORUNUR.
    bumpMoonrakerStatusOnly("10.0.0.5", 7125);
    await getMoonrakerExtrasCached("10.0.0.5", 7125);
    expect(h.extras.mock.calls.length, "hafif bump extras'ı düşürmemeli").toBe(ilk);

    // Tam bump: extras düşer → yeniden çekilir.
    bumpMoonrakerStatus("10.0.0.5", 7125);
    await getMoonrakerExtrasCached("10.0.0.5", 7125);
    expect(h.extras.mock.calls.length, "tam bump extras'ı düşürmeli").toBeGreaterThan(ilk);
  });
});

/**
 * 19 Kas 2026 — yazıcı Wi-Fi'dan düşünce ilk başarısız yoklama 5,5 sn sürüyor ve sonunda
 * histerezis gereği ZATEN önceki değeri döndürüyordu: panel 5,5 sn bekleyip aynı şeyi
 * gösteriyordu (Kasım'da 217 yanıt). Elde son bilinen durum varken yoklama bütçeyle beklenir.
 */
describe("sorunlu yazıcı paneli bekletmez", () => {
  it("bayat durum + YAVAŞ yoklama → bütçe dolunca son bilinen durum döner, yoklama arkada biter", async () => {
    h.probe.mockResolvedValueOnce(ONLINE);
    await getMoonrakerStatusCached("10.0.0.2", 7125);
    vi.setSystemTime(Date.now() + 7_000); // taze pencere geçti

    let coz: (v: unknown) => void = () => {};
    h.probe.mockImplementationOnce(() => new Promise((r) => (coz = r)));
    const p = getMoonrakerStatusCached("10.0.0.2", 7125);
    await vi.advanceTimersByTimeAsync(800);
    expect(await p).toEqual(ONLINE); // 5,5 sn değil, 0,8 sn sonra
    // Yoklama arkada bitince sonuç önbelleğe yazılır; sonraki tur onu görür.
    const BITTI = { online: true, state: "complete" };
    coz(BITTI);
    await vi.advanceTimersByTimeAsync(0);
    expect(await getMoonrakerStatusCached("10.0.0.2", 7125)).toEqual(BITTI);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("bayat durum + HIZLI yoklama → yeni durum hemen verilir (eskisi gösterilmez)", async () => {
    h.probe.mockResolvedValueOnce(ONLINE);
    await getMoonrakerStatusCached("10.0.0.3", 7125);
    vi.setSystemTime(Date.now() + 7_000);
    const DURAKLADI = { online: true, state: "paused" };
    h.probe.mockResolvedValueOnce(DURAKLADI);
    expect(await getMoonrakerStatusCached("10.0.0.3", 7125)).toEqual(DURAKLADI);
  });

  it("hiç veri yokken yoklama bütçesiz beklenir (gösterecek eski durum yok)", async () => {
    let coz: (v: unknown) => void = () => {};
    h.probe.mockImplementationOnce(() => new Promise((r) => (coz = r)));
    let dondu = false;
    const p = getMoonrakerStatusCached("10.0.0.4", 7125).then((v) => { dondu = true; return v; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dondu).toBe(false);
    coz(ONLINE);
    expect(await p).toEqual(ONLINE);
  });

  it("komut sonrası (tam bump) yoklama yine BEKLENİR — kart eski duruma zıplamaz", async () => {
    h.probe.mockResolvedValueOnce(ONLINE);
    await getMoonrakerStatusCached("10.0.0.6", 7125);
    bumpMoonrakerStatus("10.0.0.6", 7125);
    const DURAKLADI = { online: true, state: "paused" };
    let coz: (v: unknown) => void = () => {};
    h.probe.mockImplementationOnce(() => new Promise((r) => (coz = r)));
    let dondu = false;
    const p = getMoonrakerStatusCached("10.0.0.6", 7125).then((v) => { dondu = true; return v; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dondu, "komuttan sonra eski 'basıyor' durumu verilmemeli").toBe(false);
    coz(DURAKLADI);
    expect(await p).toEqual(DURAKLADI);
  });

  it("sayfa açılışı (hafif bump) çevrimdışı geri çekilmesini kırar ama bütçeyle bekler", async () => {
    const { bumpMoonrakerStatusOnly } = await import("./status-cache");
    h.probe.mockResolvedValueOnce(OFFLINE);
    await getMoonrakerStatusCached("10.0.0.7", 7125);
    expect(h.probe).toHaveBeenCalledTimes(1);

    // Yazıcı geri geldi ve hızlı yanıt veriyor → açılışta HEMEN çevrimiçi görünür.
    bumpMoonrakerStatusOnly("10.0.0.7", 7125);
    h.probe.mockResolvedValueOnce(ONLINE);
    expect(await getMoonrakerStatusCached("10.0.0.7", 7125)).toEqual(ONLINE);

    // Yazıcı yine düştü ve yoklama takılıyor → açılış 0,8 sn'den fazla beklemez.
    vi.setSystemTime(Date.now() + 7_000);
    h.probe.mockResolvedValueOnce(OFFLINE);
    await getMoonrakerStatusCached("10.0.0.7", 7125); // histerezis: önceki "çevrimiçi" bir kez daha
    vi.setSystemTime(Date.now() + 30_000);
    h.probe.mockImplementationOnce(() => new Promise(() => {}));
    bumpMoonrakerStatusOnly("10.0.0.7", 7125);
    const p = getMoonrakerStatusCached("10.0.0.7", 7125);
    await vi.advanceTimersByTimeAsync(800);
    await expect(p).resolves.toBeDefined();
  });
});
