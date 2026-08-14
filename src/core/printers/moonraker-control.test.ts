/**
 * Moonraker kontrol komutları — SAHTE BAŞARI koruması.
 *
 * NEDEN VARLAR: doğrulama yalnız "durum beklenen değerde mi" diye bakıyordu, komut ÖNCESİ durumla
 * SONRAKİNİ ayırt etmiyordu.
 *   • Boştaki yazıcıda "İptal" → Klipper 400 döner, sonra okunan "standby" beklenen listede
 *     olduğu için arayüz "İptal edildi" diyordu; hiçbir baskı iptal edilmemişti.
 *   • Boştaki (soğuk nozullu) yazıcıda "Filament değiştir" → M600 makrosunun PAUSE kısmı çalışıp
 *     ekstrüzyon adımı patlıyor, catch dalı "paused" görüp BAŞARILI dönüyordu. Yazıcı boş bir işte
 *     duraklamış kalıyor, sonraki baskı "Yazıcı şu an meşgul" ile reddediliyordu.
 *   • Hız (M220) ve katman duraklatması, istek zaman aşımına uğrarsa komut yazıcıda UYGULANMIŞ
 *     olsa bile hata fırlatıyordu (MADDE 9'un ilkesinin tersi).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  moonrakerControl, moonrakerChangeFilament, moonrakerSetSpeed,
  moonrakerSetPauseAtLayer, clearMoonrakerCaps, pickLightTarget, allLightTargets, fetchMoonrakerCaps,
} from "./moonraker";

/** Sahte Moonraker: URL kalıbına göre yanıt üretir, çağrıları kaydeder. */
interface FakeState {
  state: string;
  speedFactor: number;
  /** /printer/gcode/script çağrısında fırlatılacak hata (zaman aşımı benzetimi). */
  scriptThrows?: boolean;
  /** Script çalıştıktan sonra durumun ne olacağı. */
  afterScript?: () => void;
  pauseAtLayer?: { enable: boolean; layer: number };
  controlStatus?: number;
}

let fake: FakeState;
const calls: string[] = [];

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function statusPayload(): unknown {
  return {
    result: {
      status: {
        print_stats: { state: fake.state, filename: "x.gcode", print_duration: 10, info: {} },
        virtual_sdcard: { progress: 0.5, is_active: fake.state === "printing", file_position: 100 },
        extruder: { temperature: 210, target: 210 },
        heater_bed: { temperature: 60, target: 60 },
        gcode_move: { speed_factor: fake.speedFactor },
        "gcode_macro SET_PRINT_STATS_INFO": { pause_at_layer: fake.pauseAtLayer },
      },
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  fake = { state: "standby", speedFactor: 1 };
  clearMoonrakerCaps();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
    if (u.includes("/printer/objects/query")) return jsonRes(statusPayload());
    if (u.includes("/printer/objects/list")) return jsonRes({ result: { objects: ["print_stats", "led cavity_led"] } });
    if (u.includes("/printer/gcode/help")) {
      return jsonRes({ result: { M600: "change filament", SET_PAUSE_AT_LAYER: "pause", SET_LED: "led" } });
    }
    if (u.includes("/printer/gcode/script")) {
      if (fake.scriptThrows) throw new Error("The operation was aborted");
      fake.afterScript?.();
      return jsonRes({ result: "ok" });
    }
    if (u.includes("/printer/print/")) return jsonRes({ result: "ok" }, fake.controlStatus ?? 200);
    return jsonRes({ result: {} });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("duraklat/devam/iptal — komut ÖNCESİ durum doğrulama sayılmaz", () => {
  it("boştaki yazıcıda 'iptal' SAHTE BAŞARI dönmez", async () => {
    fake.state = "standby";
    fake.controlStatus = 400;
    await expect(moonrakerControl("10.0.0.1", 7125, "cancel")).rejects.toThrow(/süren bir baskı yok/i);
    // Komut yazıcıya HİÇ gönderilmemeli.
    expect(calls.some((c) => c.includes("/printer/print/cancel"))).toBe(false);
  });

  it("zaten duraklamış yazıcıda 'duraklat' reddedilir", async () => {
    fake.state = "paused";
    await expect(moonrakerControl("10.0.0.1", 7125, "pause")).rejects.toThrow(/basmıyor/i);
  });

  it("basan yazıcıda 'devam' reddedilir", async () => {
    fake.state = "printing";
    await expect(moonrakerControl("10.0.0.1", 7125, "resume")).rejects.toThrow(/duraklatılmış bir baskı yok/i);
  });

  it("basan yazıcıda 'duraklat' gerçek geçişle doğrulanır", async () => {
    fake.state = "printing";
    // Komut isteğinden hemen sonra yazıcı duraklar.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
      if (u.includes("/printer/print/pause")) { fake.state = "paused"; return jsonRes({ result: "ok" }); }
      if (u.includes("/printer/objects/query")) return jsonRes(statusPayload());
      return jsonRes({ result: {} });
    }));
    const r = await moonrakerControl("10.0.0.1", 7125, "pause");
    expect(r).toEqual({ verified: true, state: "paused" });
  });
});

describe("filament değişimi (M600) — yalnız baskı sürerken", () => {
  it("boştaki yazıcıda M600 GÖNDERİLMEZ", async () => {
    fake.state = "standby";
    await expect(moonrakerChangeFilament("10.0.0.1", 7125)).rejects.toThrow(/baskı sürerken/i);
    expect(calls.some((c) => c.includes("/printer/gcode/script"))).toBe(false);
  });

  it("zaten duraklamış yazıcıda M600 GÖNDERİLMEZ", async () => {
    fake.state = "paused";
    await expect(moonrakerChangeFilament("10.0.0.1", 7125)).rejects.toThrow(/zaten duraklatılmış/i);
    expect(calls.some((c) => c.includes("/printer/gcode/script"))).toBe(false);
  });

  it("basan yazıcıda gönderilir ve duraklama DOĞRULANIR", async () => {
    fake.state = "printing";
    fake.afterScript = () => { fake.state = "paused"; };
    await expect(moonrakerChangeFilament("10.0.0.1", 7125)).resolves.toBeUndefined();
    expect(calls.some((c) => c.includes("/printer/gcode/script"))).toBe(true);
  });
});

describe("MADDE 9 ilkesi hız ve katman duraklatmasında da geçerli", () => {
  it("istek zaman aşımına uğrasa da hız uygulandıysa BAŞARILI sayılır", async () => {
    fake.state = "printing";
    fake.scriptThrows = true;
    fake.speedFactor = 1.75; // komut aslında yazıcıda çalıştı
    await expect(moonrakerSetSpeed("10.0.0.1", 7125, 175)).resolves.toBe(175);
  });

  it("hız gerçekten uygulanmadıysa asıl hata yüzeye çıkar", async () => {
    fake.state = "printing";
    fake.scriptThrows = true;
    fake.speedFactor = 1.5;
    await expect(moonrakerSetSpeed("10.0.0.1", 7125, 175)).rejects.toThrow();
  });

  it("katman duraklatması yazıcıda oluştuysa zaman aşımı hata sayılmaz", async () => {
    fake.state = "printing";
    fake.scriptThrows = true;
    fake.pauseAtLayer = { enable: true, layer: 600 };
    await expect(moonrakerSetPauseAtLayer("10.0.0.1", 7125, 600)).resolves.toBeUndefined();
  });
});

describe("ışık hedefi TEK seçilir", () => {
  it("kabin ışığı el fenerine tercih edilir", () => {
    expect(pickLightTarget(["FLASHLIGHT_SWITCH", "MODLELIGHT_SWITCH"])).toBe("MODLELIGHT_SWITCH");
  });

  it("numaralı ikizi değil ASIL caselight seçilir", () => {
    expect(pickLightTarget(["caselight", "caselight1"])).toBe("caselight");
  });

  it("Snapmaker U1 kabin LED'i tanınır", () => {
    expect(pickLightTarget(["cavity_led"])).toBe("cavity_led");
  });
});

/**
 * TÜM IŞIKLAR — kullanıcı: "ya açarım, ya kaparım. açtığımda ikisi de açılır."
 * Düğme yalnız BİR ışığı sürüyordu; yazıcılarda iki bağımsız ışık var.
 *
 * Nesne adları gerçek yazıcılardan okundu (14 Ağu 2026):
 *   Neptune 4 Pro  → output_pin caselight, output_pin caselight1 (+ mutlak ON/OFF makroları)
 *   Neptune 4 Plus → yalnız FLASHLIGHT_SWITCH, MODLELIGHT_SWITCH (kabuk betiği, durum okunamaz)
 */
describe("tüm ışıklar birlikte sürülür", () => {
  it("Neptune 4 Pro: iki pin de listede, kabin ışığı ÖNCE", () => {
    expect(allLightTargets(["caselight1", "caselight"])).toEqual(["caselight", "caselight1"]);
  });

  it("Neptune 4 Plus: logo ÖNCE, kafa ışığı da listede (eskiden düşüyordu)", () => {
    const t = allLightTargets(["FLASHLIGHT_SWITCH", "MODLELIGHT_SWITCH"]);
    expect(t[0]).toBe("MODLELIGHT_SWITCH");
    expect(t).toContain("FLASHLIGHT_SWITCH");
    expect(t).toHaveLength(2);
  });

  it("tek ışıklı yazıcıda davranış değişmez", () => {
    expect(allLightTargets(["cavity_led"])).toEqual(["cavity_led"]);
  });

  it("aynı hedef iki kez listelenmez", () => {
    const t = allLightTargets(["caselight", "caselight", "caselight1"]);
    expect(t).toEqual(["caselight", "caselight1"]);
  });

  it("hiç ışık yoksa boş kalır", () => {
    expect(allLightTargets([])).toEqual([]);
  });
});

/**
 * KEŞİF gerçekten TÜM ışıkları alıyor mu? Yukarıdaki testler yalnız yardımcı fonksiyonu
 * deniyordu; `fetchMoonrakerCaps` onu KULLANMASA da geçiyorlardı (sabotajla görüldü).
 * Bu blok bağlantının kendisini kilitler.
 */
describe("keşif: ışık hedefleri caps'e TAM yazılır", () => {
  /** Gerçek Neptune 4 Pro nesne listesi (14 Ağu 2026, yazıcıdan okundu). */
  function n4proSunucusu() {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/printer/objects/list")) {
        return jsonRes({ result: { objects: ["print_stats", "output_pin caselight", "output_pin caselight1", "output_pin beeper"] } });
      }
      if (u.includes("/printer/gcode/help")) return jsonRes({ result: { SET_PIN: "pin" } });
      if (u.includes("/printer/objects/query")) return jsonRes(statusPayload());
      return jsonRes({ result: {} });
    }));
  }

  it("Neptune 4 Pro'nun İKİ pini de sürülür", async () => {
    clearMoonrakerCaps();
    n4proSunucusu();
    const caps = await fetchMoonrakerCaps("10.0.0.9", 80);
    expect(caps.lightKind).toBe("pin");
    expect(caps.lightTargets).toEqual(["caselight", "caselight1"]);
  });

  it("Neptune 4 Plus'ın İKİ değiştir makrosu da sürülür", async () => {
    clearMoonrakerCaps();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/printer/objects/list")) {
        return jsonRes({ result: { objects: ["print_stats", "gcode_macro FLASHLIGHT_SWITCH", "gcode_macro MODLELIGHT_SWITCH"] } });
      }
      if (u.includes("/printer/gcode/help")) {
        return jsonRes({ result: { FLASHLIGHT_SWITCH: "hotend", MODLELIGHT_SWITCH: "logo" } });
      }
      if (u.includes("/printer/objects/query")) return jsonRes(statusPayload());
      return jsonRes({ result: {} });
    }));
    const caps = await fetchMoonrakerCaps("10.0.0.8", 80);
    expect(caps.lightKind).toBe("toggle");
    expect(caps.lightTargets).toEqual(["MODLELIGHT_SWITCH", "FLASHLIGHT_SWITCH"]);
  });
});
