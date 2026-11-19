import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kisaBellek } from "./okunmamis-bildirimler";

let n = 0;
const ad = () => `test-${++n}-${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

/**
 * Zil (20 sn) ve masaüstü bildirimi (12 sn) aynı listeyi ayrı ayrı okuyordu. Bu bellek ikisini
 * tek okumaya indirir — ama bildirim GECİKMEMELİ: süre dolunca eski veri verilmez.
 */
describe("kısa ömürlü ortak okuma", () => {
  it("ömür içinde ikinci isteyen veritabanına gitmez", async () => {
    const b = kisaBellek<string>(ad(), 8_000);
    const oku = vi.fn(async () => "liste");
    expect(await b.al(oku)).toBe("liste");
    vi.setSystemTime(Date.now() + 7_999);
    expect(await b.al(oku)).toBe("liste");
    expect(oku).toHaveBeenCalledTimes(1);
  });

  it("ömür dolunca ESKİ veriyi vermez, taze okumayı bekler", async () => {
    const b = kisaBellek<string>(ad(), 8_000);
    let surum = 1;
    const oku = vi.fn(async () => `v${surum}`);
    await b.al(oku);
    surum = 2;
    vi.setSystemTime(Date.now() + 8_000);
    expect(await b.al(oku)).toBe("v2");
  });

  it("aynı anda gelen iki istek tek okuma paylaşır", async () => {
    const b = kisaBellek<string>(ad(), 8_000);
    let coz: (v: string) => void = () => {};
    const oku = vi.fn(() => new Promise<string>((r) => (coz = r)));
    const a = b.al(oku);
    const c = b.al(oku);
    coz("ortak");
    expect(await Promise.all([a, c])).toEqual(["ortak", "ortak"]);
    expect(oku).toHaveBeenCalledTimes(1);
  });

  it("düşürülünce sonraki istek yeniden okur; süren eski okuma belleğe yazılmaz", async () => {
    const b = kisaBellek<string>(ad(), 8_000);
    const cozenler: Array<(v: string) => void> = [];
    const oku = vi.fn(() => new Promise<string>((r) => cozenler.push(r)));
    const eski = b.al(oku); // okundu işaretinden ÖNCE başlayan okuma
    b.dusur(); // kullanıcı bildirimi okudu
    const yeni = b.al(oku);
    expect(oku).toHaveBeenCalledTimes(2);
    cozenler[1]("okunduktan sonra");
    cozenler[0]("okunmadan önce");
    expect(await yeni).toBe("okunduktan sonra");
    expect(await eski).toBe("okunmadan önce");
    expect(await b.al(oku), "geç gelen eski liste taze listenin üstüne yazmaz").toBe("okunduktan sonra");
    expect(oku).toHaveBeenCalledTimes(2);
  });

  it("okuma hata verirse bellek kirlenmez, sonraki istek yeniden dener", async () => {
    const b = kisaBellek<string>(ad(), 8_000);
    let ilk = true;
    const oku = vi.fn(async () => {
      if (ilk) {
        ilk = false;
        throw new Error("ağ");
      }
      return "liste";
    });
    await expect(b.al(oku)).rejects.toThrow("ağ");
    expect(await b.al(oku)).toBe("liste");
  });
});
