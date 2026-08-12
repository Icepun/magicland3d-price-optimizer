/**
 * Bambu kontrol komutları — BAYAT DURUMDAN SAHTE BAŞARI koruması.
 *
 * NEDEN VARLAR: `conn.print` yalnız MQTT raporu geldiğinde tazelenir ve yeniden bağlanmada
 * TEMİZLENMEZ. Bambu firmware "son istemci kazanır" (Handy/Studio bağlanınca bizi susturur):
 * `conn.connected` true kalır, `gcode_state` önceki işten kalma "FINISH" değerinde donar.
 * Eski kod ne tazelik ne de "yazıcı gerçekten basıyor mu" ön koşulu kontrol ediyordu; kullanıcı
 * "İptal"e basınca komut yazıcıya GİDİYOR, doğrulama döngüsü ilk turda donmuş durumu görüp
 * anında {verified:true} dönüyordu — kullanıcıya "iptal edildi" deniyordu ama ya hiçbir şey
 * olmamıştı ya da Handy'den başlatılmış canlı bir baskı öldürülmüştü.
 *
 * Ayrıca kontrol yolundaki pushall isteği KISALTILMIŞ gönderiliyordu (`version`/`push_target`
 * yok — diğer beş çağrı yeri bunları şart koşuyor) ve yine de `lastPushallAt`'ı damgalayıp
 * gerçek kurtarma isteklerini susturuyordu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClient {
  handlers: Record<string, ((...a: unknown[]) => void)[]>;
  published: { topic: string; payload: string }[];
  on(ev: string, fn: (...a: unknown[]) => void): FakeClient;
  subscribe(): void;
  publish(topic: string, payload: string, opts?: unknown, cb?: (e?: Error) => void): void;
  end(): void;
}

const h = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock("mqtt", () => ({
  default: {
    connect: () => {
      const c: FakeClient = {
        handlers: {},
        published: [],
        on(ev, fn) { (c.handlers[ev] ??= []).push(fn); return c; },
        subscribe() { /* yok say */ },
        publish(topic, payload, _opts, cb) { c.published.push({ topic, payload }); cb?.(); },
        end() { /* yok say */ },
      };
      h.clients.push(c);
      return c;
    },
  },
}));

import { bambuControl, getBambuStatus, dropBambuConns } from "./bambu";

const HOST = "10.0.0.9";
const SERIAL = "SER123";
const CODE = "12345678";

function client(): FakeClient {
  return h.clients[h.clients.length - 1] as FakeClient;
}

function push(print: Record<string, unknown>): void {
  client().handlers.message?.forEach((f) => f("t", Buffer.from(JSON.stringify({ print }))));
}

/** Reddi ANINDA yakala: sahte zaman ilerletilirken bekleyen promise "unhandled" sayılmasın. */
function watch<T>(p: Promise<T>) {
  return p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }));
}

/** Bağlantıyı kur, ilk durum raporunu ilet — kontrol testleri buradan başlar. */
async function setup(gcodeState: string): Promise<void> {
  const p = getBambuStatus(HOST, CODE, SERIAL); // ensureConn senkron çalışır → istemci hazır
  client().handlers.connect?.forEach((f) => f());
  push({ gcode_state: gcodeState, nozzle_temper: 210, bed_temper: 60 });
  await vi.advanceTimersByTimeAsync(3000);
  await p;
  client().published.length = 0;
}

beforeEach(() => {
  h.clients.length = 0;
  dropBambuConns(HOST, SERIAL);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  dropBambuConns(HOST, SERIAL);
});

describe("bambuControl — ön koşul ve tazelik", () => {
  it("bitmiş (FINISH) yazıcıda 'iptal' komutu GÖNDERİLMEZ", async () => {
    await setup("FINISH");
    const s = watch(bambuControl(HOST, CODE, SERIAL, "cancel"));
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await s;
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.e.message).toMatch(/süren bir baskı yok/i);
    expect(client().published.some((m) => m.payload.includes('"command":"stop"'))).toBe(false);
  });

  it("basan yazıcıda 'devam' reddedilir", async () => {
    await setup("RUNNING");
    const s = watch(bambuControl(HOST, CODE, SERIAL, "resume"));
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await s;
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.e.message).toMatch(/duraklatılmış bir baskı yok/i);
  });

  it("basan yazıcıda 'duraklat' KOMUT SONRASI gelen raporla doğrulanır", async () => {
    await setup("RUNNING");
    const s = watch(bambuControl(HOST, CODE, SERIAL, "pause"));
    await vi.advanceTimersByTimeAsync(1000); // saat ilerler → yeni rapor "komuttan sonra" sayılır
    push({ gcode_state: "PAUSE" });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await s;
    expect(r).toEqual({ ok: true, v: { verified: true, state: "PAUSE" } });
    expect(client().published.some((m) => m.payload.includes('"command":"pause"'))).toBe(true);
  });

  it("komut sonrası YENİ rapor gelmezse doğrulanmış sayılmaz (donmuş durum kanıt değildir)", async () => {
    await setup("PAUSE");
    // Donmuş durum zaten "PAUSE"; eski kod 'resume' sonrası... değil ama 'pause' komutunu
    // anında doğrulanmış sayıyordu. Yazıcı susarsa dürüst hata gelmeli.
    const s = watch(bambuControl(HOST, CODE, SERIAL, "resume"));
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await s;
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.e.message).toMatch(/uygulamadı/i);
  });

  it("durum BAYATSA komut gönderilmeden net hata verilir", async () => {
    await setup("RUNNING");
    vi.setSystemTime(Date.now() + 30_000); // 30sn'dir hiç rapor yok
    const s = watch(bambuControl(HOST, CODE, SERIAL, "cancel"));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await s;
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.e.message).toMatch(/durumunu bildirmiyor/i);
    expect(client().published.some((m) => m.payload.includes('"command":"stop"'))).toBe(false);
  });
});

describe("pushall isteği TAM biçimde gönderilir", () => {
  it("kontrol yolundaki pushall version/push_target alanlarını taşır", async () => {
    await setup("RUNNING");
    const s = watch(bambuControl(HOST, CODE, SERIAL, "pause"));
    await vi.advanceTimersByTimeAsync(1000);
    push({ gcode_state: "PAUSE" });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await s).ok).toBe(true);
    const pushalls = client().published.filter((m) => m.payload.includes('"pushall"'));
    expect(pushalls.length).toBeGreaterThan(0);
    for (const m of pushalls) {
      expect(m.payload).toContain('"version":1');
      expect(m.payload).toContain('"push_target":1');
    }
  });
});
