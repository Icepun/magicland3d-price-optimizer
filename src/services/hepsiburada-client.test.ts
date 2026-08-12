/**
 * Hepsiburada istemcisi — İPTAL/İADE uçlarının DENEME davranışı.
 *
 * Bu iki ucun yolu doğrulanamadı (belgeler kapalı, elimizde canlı kimlik yok). Sözleşme şu:
 * hata fırlatma, yol yoksa null dön ve bir daha deneme, geçici hatada sonraki turda tekrar dene.
 * Sipariş çekimi bu uca BAĞLI OLMAMALI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HepsiburadaClient } from "./hepsiburada-client";

const credentials = {
  merchantId: "m-1",
  secretKey: "s-1",
  developerUsername: "dev",
  environment: "prod" as const,
};

function mockFetch(handler: (url: string) => { status: number; body?: unknown }) {
  const calls: string[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      text: async () => JSON.stringify(body ?? {}),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fake);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("iptal/iade listesi", () => {
  it("hiçbir aday yol yoksa null döner ve bir daha denenmez", async () => {
    const calls = mockFetch(() => ({ status: 404 }));
    const client = new HepsiburadaClient(credentials);

    expect(await client.listClaimPackages("cancelled")).toBeNull();
    const firstRound = calls.length;
    expect(firstRound).toBeGreaterThan(0);

    // İkinci çağrı ağa hiç çıkmaz: her sipariş tazelemesinde yok olan yolu denemek boşuna.
    expect(await client.listClaimPackages("cancelled")).toBeNull();
    expect(calls.length).toBe(firstRound);
  });

  it("çalışan yol hatırlanır", async () => {
    const calls = mockFetch((url) =>
      url.includes("/packages/merchantid/m-1/cancelled")
        ? { status: 200, body: { items: [{ OrderNumber: "A1" }] } }
        : { status: 404 }
    );
    const client = new HepsiburadaClient(credentials);

    const first = (await client.listClaimPackages("cancelled")) as { items: unknown[] };
    expect(first.items).toHaveLength(1);

    const before = calls.length;
    await client.listClaimPackages("cancelled", { offset: 100 });
    // Tek istek: aday listesi baştan taranmaz.
    expect(calls.length).toBe(before + 1);
  });

  it("geçici hatada yol 'yok' sayılmaz — sonraki turda yeniden denenir", async () => {
    let status = 500;
    const calls = mockFetch(() =>
      status === 200 ? { status: 200, body: { items: [] } } : { status }
    );
    const client = new HepsiburadaClient(credentials);

    expect(await client.listClaimPackages("returned")).toBeNull();
    const afterFailure = calls.length;

    status = 200;
    expect(await client.listClaimPackages("returned")).not.toBeNull();
    expect(calls.length).toBeGreaterThan(afterFailure);
  });

  it("ağ hatası fırlatmaz — sipariş çekimi bu uca bağlı değil", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ağ koptu");
      })
    );
    const client = new HepsiburadaClient(credentials);

    await expect(client.listClaimPackages("returned")).resolves.toBeNull();
  });
});
