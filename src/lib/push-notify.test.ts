import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gerçek libSQL/Prisma client'ı yüklenmesin — bu dosya yalnız gönderim mantığını sınar.
const findMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("./prisma", () => ({
  remotePrisma: {
    pushToken: {
      findMany: (...a: unknown[]) => findMany(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { pushToAllDevices } from "./push-notify";

function token(i: number): string {
  return `ExponentPushToken[${String(i).padStart(4, "0")}]`;
}

/** Sahte fetch yanıtı (yalnız kullandığımız alanlar). */
function yanit(gövde: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => gövde, text: async () => JSON.stringify(gövde) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  findMany.mockReset();
  deleteMany.mockReset();
  deleteMany.mockResolvedValue({ count: 0 });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // Günlük satırları test çıktısını kirletmesin (davranış yine de doğrulanıyor).
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("push gönderimi", () => {
  it("100'den fazla cihazı ayrı isteklere böler", async () => {
    const tokenlar = Array.from({ length: 250 }, (_, i) => ({ token: token(i) }));
    findMany.mockResolvedValue(tokenlar);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const mesajlar = JSON.parse(init.body) as unknown[];
      return yanit({ data: mesajlar.map((_, i) => ({ status: "ok", id: `bilet-${i}` })) });
    });

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    const gonderimler = fetchMock.mock.calls.filter((c) => String(c[0]).includes("push/send"));
    expect(gonderimler).toHaveLength(3);
    const boyutlar = gonderimler.map((c) => JSON.parse((c[1] as { body: string }).body).length);
    expect(boyutlar).toEqual([100, 100, 50]);
    expect(ozet.gonderildi).toBe(250);
    expect(ozet.hata).toBe(0);
  });

  it("servis isteği reddederse hata sayar ve sade Türkçe sebep döner, hata fırlatmaz", async () => {
    findMany.mockResolvedValue([{ token: token(1) }, { token: token(2) }]);
    fetchMock.mockResolvedValue(
      yanit({ errors: [{ code: "MessageRateExceeded", message: "too many" }] }, false, 429)
    );

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    expect(ozet.gonderildi).toBe(0);
    expect(ozet.hata).toBe(2);
    expect(ozet.sebepler).toEqual(["Çok sık bildirim gönderildi, biraz sonra tekrar deneyin."]);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("200 dönse bile gövdedeki hata dalını işler", async () => {
    findMany.mockResolvedValue([{ token: token(1) }]);
    fetchMock.mockResolvedValue(yanit({ errors: [{ code: "InvalidCredentials", message: "bad" }] }));

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    expect(ozet.hata).toBe(1);
    expect(ozet.sebepler[0]).toContain("yeniden kurmak");
  });

  it("ağ kopukluğunu yutmaz, sebep olarak bildirir", async () => {
    findMany.mockResolvedValue([{ token: token(1) }]);
    fetchMock.mockRejectedValue(new Error("network down"));

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    expect(ozet.hata).toBe(1);
    expect(ozet.sebepler[0]).toContain("İnternet");
  });

  it("bilette DeviceNotRegistered gelen cihazın kaydını siler", async () => {
    findMany.mockResolvedValue([{ token: token(1) }, { token: token(2) }]);
    deleteMany.mockResolvedValue({ count: 1 });
    fetchMock.mockResolvedValue(
      yanit({
        data: [
          { status: "ok", id: "bilet-a" },
          { status: "error", message: "yok", details: { error: "DeviceNotRegistered" } },
        ],
      })
    );

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    expect(ozet.gonderildi).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: { in: [token(2)] } } });
    expect(ozet.temizlenenKayit).toBe(1);
  });

  it("ölü cihazı MAKBUZ üzerinden de yakalayıp siler", async () => {
    findMany.mockResolvedValue([{ token: token(1) }]);
    deleteMany.mockResolvedValue({ count: 1 });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("getReceipts")) {
        return yanit({
          data: {
            "bilet-a": { status: "error", message: "yok", details: { error: "DeviceNotRegistered" } },
          },
        });
      }
      return yanit({ data: [{ status: "ok", id: "bilet-a" }] });
    });

    const ozet = await pushToAllDevices("Başlık", "Gövde", {
      makbuzlariBekle: true,
      makbuzGecikmeMs: 0,
    });

    expect(ozet.gonderildi).toBe(1);
    expect(ozet.teslim).toEqual({ basarili: 0, hatali: 1 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: { in: [token(1)] } } });
  });

  it("kayıtlı telefon yoksa hiç istek atmaz", async () => {
    findMany.mockResolvedValue([]);

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ozet.toplamCihaz).toBe(0);
  });

  it("cihaz listesi okunamazsa hata fırlatmaz", async () => {
    findMany.mockRejectedValue(new Error("db kapalı"));

    const ozet = await pushToAllDevices("Başlık", "Gövde", { makbuzGecikmeMs: 0 });

    expect(ozet.sebepler).toEqual(["Kayıtlı telefon listesi okunamadı."]);
  });
});
