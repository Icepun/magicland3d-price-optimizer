import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pencere tepsideyken arayüz yoklamayı ve çizimi durdurur (19 Kas 2026). Bu testler sinyalin
 * iki yönünü kilitler: ana süreç "gizli" deyince durur, "görünür" deyince geri gelir; köprü
 * yoksa (tarayıcı) davranış eskisiyle aynıdır.
 */
type Kopru = { gorunurMu: () => Promise<boolean>; onGorunur: (cb: (g: boolean) => void) => () => void };

// Projede tarayıcı test ortamı yok; modülün dokunduğu kadarını taklit eden küçük bir sahte DOM.
const sahteBelge = {
  hidden: false,
  dinleyiciler: new Set<() => void>(),
  addEventListener(_olay: string, fn: () => void) { this.dinleyiciler.add(fn); },
  removeEventListener(_olay: string, fn: () => void) { this.dinleyiciler.delete(fn); },
  gizlilikDegisti() { for (const fn of [...this.dinleyiciler]) fn(); },
};

async function yukle(kopru?: Kopru) {
  vi.resetModules();
  vi.stubGlobal("window", { trendyolPriceOptimizer: kopru ? { platform: "win32", pencere: kopru } : undefined });
  vi.stubGlobal("document", sahteBelge);
  return import("./pencere-gorunur");
}

function sahteKopru(baslangic: boolean) {
  let bildir: (g: boolean) => void = () => {};
  const kopru: Kopru = {
    gorunurMu: vi.fn(async () => baslangic),
    onGorunur: vi.fn((cb) => {
      bildir = cb;
      return () => {};
    }),
  };
  return { kopru, gonder: (g: boolean) => bildir(g) };
}

beforeEach(() => {
  sahteBelge.hidden = false;
  sahteBelge.dinleyiciler.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("pencere görünür mü", () => {
  it("köprü yokken (tarayıcı) yalnız document.hidden'a bakar", async () => {
    const m = await yukle();
    expect(m.pencereSinyaliVar()).toBe(false);
    expect(m.pencereGizliMi()).toBe(false);
    sahteBelge.hidden = true;
    expect(m.pencereGizliMi()).toBe(true);
  });

  it("ana süreç 'gizli' deyince gizli sayılır ve aboneler haberdar olur; geri gelince de", async () => {
    const { kopru, gonder } = sahteKopru(true);
    const m = await yukle(kopru);
    const degisti = vi.fn();
    const birak = m.gizlilikAbone(degisti);
    await Promise.resolve();
    expect(m.pencereGizliMi()).toBe(false);

    gonder(false); // tepsiye alındı
    expect(m.pencereGizliMi()).toBe(true);
    expect(degisti).toHaveBeenCalledTimes(1);
    gonder(false); // aynı durum yeniden bildirildi → gürültü yok
    expect(degisti).toHaveBeenCalledTimes(1);

    gonder(true); // geri açıldı
    expect(m.pencereGizliMi()).toBe(false);
    expect(degisti).toHaveBeenCalledTimes(2);

    birak();
    gonder(false);
    expect(degisti).toHaveBeenCalledTimes(2);
  });

  it("açılışta pencere henüz gösterilmemişse ilk durum ana süreçten öğrenilir", async () => {
    const { kopru } = sahteKopru(false);
    const m = await yukle(kopru);
    expect(m.pencereGorunurMu()).toBe(true); // yanıt gelene kadar yoklama kesilmez
    await new Promise((r) => setTimeout(r, 0));
    expect(m.pencereGorunurMu()).toBe(false);
  });

  it("köprü yanıt vermezse 'görünür' kalır — yoklama sessizce durmaz", async () => {
    const kopru: Kopru = { gorunurMu: vi.fn(async () => { throw new Error("ipc yok"); }), onGorunur: vi.fn(() => () => {}) };
    const m = await yukle(kopru);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.pencereGizliMi()).toBe(false);
  });

  it("tarayıcının kendi gizlilik olayı da abonelere ulaşır", async () => {
    const m = await yukle();
    const degisti = vi.fn();
    const birak = m.gizlilikAbone(degisti);
    sahteBelge.gizlilikDegisti();
    expect(degisti).toHaveBeenCalledTimes(1);
    birak();
    sahteBelge.gizlilikDegisti();
    expect(degisti).toHaveBeenCalledTimes(1);
  });
});

describe("sunucuda (window/document yok)", () => {
  it("hiçbir şey gizli sayılmaz ve abonelik güvenle boş döner", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    const m = await import("./pencere-gorunur");
    expect(m.pencereGizliMi()).toBe(false);
    expect(m.pencereSinyaliVar()).toBe(false);
    expect(() => m.gizlilikAbone(() => {})()).not.toThrow();
  });
});
