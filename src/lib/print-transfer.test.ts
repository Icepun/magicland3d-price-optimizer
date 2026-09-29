/**
 * Baskı gönderiminin kara kutusu — "baskıyı başlattım, başlamamış, ekranda da bir şey yok"
 * (29 Eyl 2026). Sonuç ekrandan bağımsız kaydedilir, başarısızlık kalıcı bildirim olur.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "", bildirimler: [] as unknown[][], pushlar: [] as unknown[][] }));

vi.mock("@/lib/storage", () => ({ getUserDataDir: () => h.dir }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async (...args: unknown[]) => {
      h.bildirimler.push(args);
      return 1;
    }),
  },
}));
vi.mock("@/lib/push-notify", () => ({
  pushToAllDevices: vi.fn(async (...args: unknown[]) => {
    h.pushlar.push(args);
  }),
}));

const { baskiAktarimiBaslat, kisaSebep, yarimKalanAktarimlariBildir } = await import("./print-transfer");

const kuresel = globalThis as { __MLHUB_BASKI_AKTARIMI__?: number; __MLHUB_UYKU_ENGELI__?: (a: boolean) => void };

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "baski-test-"));
  h.bildirimler = [];
  h.pushlar = [];
  kuresel.__MLHUB_BASKI_AKTARIMI__ = 0;
});
afterEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
  delete kuresel.__MLHUB_UYKU_ENGELI__;
});

const bilgi = { printerId: "u1", printerName: "Snapmaker U1 Alt", label: "LEG_RIGHT.gcode", fileId: "f1" };

describe("baskı gönderimi kara kutusu", () => {
  it("başarısızlık KALICI bildirim + telefona push olur ve günlüğe yazılır", async () => {
    const bitir = baskiAktarimiBaslat(bilgi);
    await bitir({ ok: false, sebep: "Yazıcıyla bağlantı aktarım sırasında koptu. Uzun açıklama…" });

    expect(h.bildirimler).toHaveLength(1);
    const [, id, tip, onem, baslik, govde] = h.bildirimler[0] as string[];
    expect(id).toMatch(/^print-start-fail:/);
    expect(tip).toBe("printer-error");
    expect(onem).toBe("critical");
    expect(baslik).toContain("Baskı başlamadı");
    expect(govde).toContain("Snapmaker U1 Alt");
    expect(govde).toContain("LEG_RIGHT.gcode");
    expect(h.pushlar[0]?.[2]).toEqual({ tur: "baski-sorun" });

    const gunluk = fs.readFileSync(path.join(h.dir, "baski-gunlugu.log"), "utf8");
    expect(gunluk).toContain('"olay":"basladi"');
    expect(gunluk).toContain('"olay":"hata"');
  });

  it("başarıda bildirim gitmez; sonuç yalnız bir kez işlenir", async () => {
    const bitir = baskiAktarimiBaslat(bilgi);
    await bitir({ ok: true });
    await bitir({ ok: false, sebep: "sonradan" });
    expect(h.bildirimler).toHaveLength(0);
    expect(h.pushlar).toHaveLength(0);
  });

  it("aktarım sürerken uyku engellenir, bitince bırakılır", async () => {
    const cagrilar: boolean[] = [];
    kuresel.__MLHUB_UYKU_ENGELI__ = (a) => cagrilar.push(a);
    const a = baskiAktarimiBaslat(bilgi);
    const b = baskiAktarimiBaslat({ ...bilgi, printerId: "u2" });
    expect(kuresel.__MLHUB_BASKI_AKTARIMI__).toBe(2);
    await a({ ok: true });
    expect(cagrilar.at(-1)).toBe(true); // biri hâlâ sürüyor
    await b({ ok: true });
    expect(cagrilar.at(-1)).toBe(false);
    expect(kuresel.__MLHUB_BASKI_AKTARIMI__).toBe(0);
  });

  it("önceki oturumda yarıda kalan gönderim açılışta bildirilir; bu oturumunkine dokunulmaz", async () => {
    fs.writeFileSync(
      path.join(h.dir, "baski-aktarimlari.json"),
      JSON.stringify({ eski: { pid: -1, printerName: "U1 Üst", label: "X.gcode", startedAt: 1 } })
    );
    baskiAktarimiBaslat(bilgi); // bu süreçte süren gönderim
    expect(await yarimKalanAktarimlariBildir()).toBe(1);
    expect(String((h.bildirimler[0] as string[])[5])).toContain("yarıda kaldı");
    const kalan = JSON.parse(fs.readFileSync(path.join(h.dir, "baski-aktarimlari.json"), "utf8"));
    expect(Object.keys(kalan)).toEqual(["u1"]);
  });

  it("bildirim metni teknik izi atar ve kısalır", () => {
    expect(kisaSebep("Dosya yazıcıya yüklenemedi (veri bağlantısı). · iz: USER»331 PASS***»230")).toBe(
      "Dosya yazıcıya yüklenemedi (veri bağlantısı)."
    );
    expect(kisaSebep("a".repeat(300)).length).toBeLessThanOrEqual(140);
  });
});
