/**
 * Moonraker BAĞLANTI PORTU — kayıtlı port yanlışsa kendi kendini onarır.
 *
 * CANLI ÖLÇÜM (12 Ağu): Neptune 4 Pro/Plus veritabanında port 7125 kayıtlı ama ikisi de yalnız
 * port 80'de yanıt veriyor. Eskiden yalnız durum sorgusu adayları tarıyordu; uygulama yeni
 * açıldığında ilk iş durum sorgusu değilse (ışık, yetenek, dosya listesi, hız…) istek doğrudan
 * kayıtlı porta gidip boşa düşüyordu.
 *
 * Beklenen davranış:
 *   • çalışan port bulunur ve kullanılır,
 *   • bulunduktan sonra HER istek tek çağrı eder (her istekte iki port denenmez),
 *   • yazıcı hiç yanıt vermiyorsa kısa süre tekrar taranmaz,
 *   • kayıtlı port üst üste düşerse unutulur ve yeniden keşfedilir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchMoonrakerStatus, moonrakerFiles, resolveMoonrakerPort, clearMoonrakerPort,
  clearMoonrakerCaps,
} from "./moonraker";

const HOST = "192.168.9.9";
/** Yazıcının GERÇEKTEN dinlediği portlar (testte değiştirilir). */
let openPorts: number[] = [80];
let calls: { port: number; path: string }[] = [];

function jsonRes(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function statusPayload(): unknown {
  return {
    result: {
      status: {
        print_stats: { state: "standby", filename: null, print_duration: 0, info: {} },
        virtual_sdcard: { progress: 0 },
        extruder: { temperature: 25, target: 0 },
        heater_bed: { temperature: 24, target: 0 },
      },
    },
  };
}

beforeEach(() => {
  openPorts = [80];
  calls = [];
  clearMoonrakerPort();
  clearMoonrakerCaps();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url));
    // URL, http'nin varsayılan portunu (80) boş bırakır — "80" yazılmış olsa bile.
    const port = Number(u.port || 80);
    calls.push({ port, path: u.pathname + u.search });
    // Kapalı port: bağlantı kurulamaz (gerçekte istek asılı kalıp zaman aşımına düşüyor).
    if (!openPorts.includes(port)) throw new Error("connect ECONNREFUSED");
    if (u.pathname === "/printer/objects/query") return jsonRes(statusPayload());
    if (u.pathname === "/server/files/list") return jsonRes({ result: [] });
    return jsonRes({ result: {} });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kayıtlı port yanıt vermiyorsa çalışan port bulunur", () => {
  it("durum sorgusu 80'e düşer ve orada okur", async () => {
    const st = await fetchMoonrakerStatus(HOST, 7125);
    expect(st.online).toBe(true);
    expect(await resolveMoonrakerPort(HOST, 7125)).toBe(80);
  });

  it("durum sorgusu OLMADAN da (ilk iş dosya listesiyse) doğru porta gider", async () => {
    await expect(moonrakerFiles(HOST, 7125)).resolves.toEqual([]);
    const listCalls = calls.filter((c) => c.path.startsWith("/server/files/list"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].port).toBe(80);
  });

  it("port bulunduktan sonra her istek TEK çağrı eder (her istekte iki port denenmez)", async () => {
    await moonrakerFiles(HOST, 7125); // keşif burada olur
    calls = [];
    await moonrakerFiles(HOST, 7125);
    await moonrakerFiles(HOST, 7125);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.port === 80)).toBe(true);
  });

  it("durum sorgusunun bulduğu portu diğer uçlar da kullanır (ek keşif yok)", async () => {
    await fetchMoonrakerStatus(HOST, 7125);
    calls = [];
    await moonrakerFiles(HOST, 7125);
    expect(calls).toEqual([{ port: 80, path: "/server/files/list?root=gcodes" }]);
  });
});

describe("yazıcı hiç yanıt vermiyorsa", () => {
  it("her istekte yeniden taranmaz", async () => {
    openPorts = [];
    await expect(moonrakerFiles(HOST, 7125)).rejects.toThrow();
    const first = calls.length;
    expect(first).toBeGreaterThan(1); // ilk seferde adaylar taranır
    calls = [];
    await expect(moonrakerFiles(HOST, 7125)).rejects.toThrow();
    expect(calls).toHaveLength(1); // tarama yasağı: yalnız kayıtlı port denenir
  });

  it("çevrimdışı durum sorgusu adayları bir kez tarar, sonra tek denemeye düşer", async () => {
    openPorts = [];
    const a = await fetchMoonrakerStatus(HOST, 7125);
    expect(a.online).toBe(false);
    calls = [];
    const b = await fetchMoonrakerStatus(HOST, 7125);
    expect(b.online).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("yazıcının portu gerçekten değişirse uygulama kendini onarır", () => {
  it("kayıtlı port üst üste düşerse unutulur ve yeni port bulunur", async () => {
    await moonrakerFiles(HOST, 7125);
    expect(await resolveMoonrakerPort(HOST, 7125)).toBe(80);

    openPorts = [7125]; // yazıcı artık 7125'te
    for (let i = 0; i < 3; i++) {
      await expect(moonrakerFiles(HOST, 7125)).rejects.toThrow();
    }
    await expect(moonrakerFiles(HOST, 7125)).resolves.toEqual([]);
    expect(await resolveMoonrakerPort(HOST, 7125)).toBe(7125);
  });

  it("adres değişikliğinde keşfedilen port unutulur", async () => {
    await moonrakerFiles(HOST, 7125);
    clearMoonrakerPort(HOST);
    openPorts = [7125];
    await expect(moonrakerFiles(HOST, 7125)).resolves.toEqual([]);
    expect(await resolveMoonrakerPort(HOST, 7125)).toBe(7125);
  });
});
