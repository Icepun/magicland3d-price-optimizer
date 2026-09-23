import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TELEFONDAN YAZMA — TEK PARÇA.
 *
 * Mobil `batch()` Hrana boru hattında her ifadeyi AYRI uyguluyordu: biri düşse de sonrakiler
 * yazılıyordu. Örn. reklam bütçesi değişirken eski dönem kapanıp yeni dönem yazılamazsa bütçe
 * tamamen kayboluyordu. `writeBatch` libSQL istemcisinin kendi yöntemini kullanır:
 * BEGIN → her adım bir öncekinin başarısına bağlı → COMMIT → COMMIT olmadıysa ROLLBACK.
 */

type Adim = { condition?: unknown; stmt: { sql: string; args?: unknown[] } };
type Istek = { requests: { type: string; batch?: { steps: Adim[] } }[] };

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

let gonderilen: Istek[] = [];

function yanit(govde: unknown, status = 200) {
  return new Response(JSON.stringify(govde), { status, headers: { "Content-Type": "application/json" } });
}

const bos = { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };
const kapat = { type: "ok", response: { type: "close" } };

function batchYaniti(step_results: unknown[], step_errors: unknown[]) {
  return yanit({
    results: [{ type: "ok", response: { type: "batch", result: { step_results, step_errors } } }, kapat],
  });
}

async function modul() {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TURSO_URL", "https://ornek.turso.io");
  vi.stubEnv("EXPO_PUBLIC_TURSO_TOKEN", "jeton");
  return import("../../mobile/src/lib/turso");
}

function fetchKur(cevap: (istek: Istek) => Response) {
  gonderilen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const istek = JSON.parse(String(init.body)) as Istek;
      gonderilen.push(istek);
      return cevap(istek);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("writeBatch — istek biçimi", () => {
  it("BEGIN IMMEDIATE → koşullu adımlar → COMMIT → ROLLBACK, sonunda close", async () => {
    fetchKur(() => batchYaniti([bos, bos, bos, bos, null], [null, null, null, null, null]));
    const { writeBatch } = await modul();
    await writeBatch([
      { sql: "UPDATE A SET x = ?", args: [1.5] },
      { sql: "INSERT INTO B VALUES (?, ?, ?)", args: ["m", null, true] },
    ]);

    expect(gonderilen).toHaveLength(1);
    const [batchIstegi, kapatIstegi] = gonderilen[0].requests;
    expect(batchIstegi.type).toBe("batch");
    expect(kapatIstegi.type).toBe("close");
    const adimlar = batchIstegi.batch!.steps;
    expect(adimlar.map((a) => a.stmt.sql)).toEqual([
      "BEGIN IMMEDIATE",
      "UPDATE A SET x = ?",
      "INSERT INTO B VALUES (?, ?, ?)",
      "COMMIT",
      "ROLLBACK",
    ]);
    expect(adimlar[0].condition).toBeUndefined();
    expect(adimlar[1].condition).toEqual({ type: "ok", step: 0 });
    expect(adimlar[2].condition).toEqual({ type: "ok", step: 1 });
    expect(adimlar[3].condition).toEqual({ type: "ok", step: 2 });
    expect(adimlar[4].condition).toEqual({ type: "not", cond: { type: "ok", step: 3 } });
    // Değerler Hrana biçiminde kodlanır (boolean → integer).
    expect(adimlar[1].stmt.args).toEqual([{ type: "float", value: 1.5 }]);
    expect(adimlar[2].stmt.args).toEqual([
      { type: "text", value: "m" },
      { type: "null" },
      { type: "integer", value: "1" },
    ]);
  });

  it("boş liste ağa hiç çıkmaz", async () => {
    fetchKur(() => yanit({ results: [] }));
    const { writeBatch } = await modul();
    await expect(writeBatch([])).resolves.toEqual([]);
    expect(gonderilen).toHaveLength(0);
  });
});

describe("writeBatch — sonuç", () => {
  it("yalnız kullanıcı ifadelerinin sonuçları döner; SELECT satırları okunur", async () => {
    fetchKur(() =>
      batchYaniti(
        [
          bos,
          { ...bos, affected_row_count: 1 },
          { cols: [{ name: "remainingGrams" }], rows: [[{ type: "integer", value: "740" }]], affected_row_count: 0 },
          bos,
          null,
        ],
        [null, null, null, null, null]
      )
    );
    const { writeBatch } = await modul();
    const [guncelle, oku] = await writeBatch([
      { sql: "UPDATE FilamentSpool SET remainingGrams = remainingGrams - ?", args: [10] },
      { sql: "SELECT remainingGrams FROM FilamentSpool" },
    ]);
    expect(guncelle.rowsAffected).toBe(1);
    expect(oku.rows).toEqual([{ remainingGrams: 740 }]);
  });

  it("bir adım düşerse o adımın hatası atılır (kayıt geri alınır, yarım kalmaz)", async () => {
    // 1. ifade düştü → 2. ifade ve COMMIT çalışmadı, ROLLBACK çalıştı.
    fetchKur(() =>
      batchYaniti(
        [bos, null, null, null, bos],
        [null, { message: "UNIQUE constraint failed: AdBudget.id" }, null, null, null]
      )
    );
    const { writeBatch } = await modul();
    await expect(
      writeBatch([
        { sql: "UPDATE AdBudget SET validTo = ?", args: ["x"] },
        { sql: "INSERT INTO AdBudget VALUES (?)", args: ["y"] },
      ])
    ).rejects.toThrow("UNIQUE constraint failed");
  });

  it("COMMIT çalışmadıysa (hata mesajı olmasa bile) başarı sayılmaz", async () => {
    fetchKur(() => batchYaniti([bos, bos, null, bos], [null, null, null, null]));
    const { writeBatch } = await modul();
    await expect(writeBatch([{ sql: "DELETE FROM PrepDone WHERE key = ?", args: ["a"] }])).rejects.toThrow(
      "geri alındı"
    );
  });

  it("HTTP hatası yutulmaz", async () => {
    fetchKur(() => new Response("kapalı", { status: 503 }));
    const { writeBatch } = await modul();
    await expect(writeBatch([{ sql: "UPDATE A SET x = 1" }])).rejects.toThrow("503");
  });
});

describe("okuma batch'i davranışını korur", () => {
  it("execute istekleri + close; sonuçlar sırayla çözülür", async () => {
    fetchKur(() =>
      yanit({
        results: [
          { type: "ok", response: { type: "execute", result: { cols: [{ name: "n" }], rows: [[{ type: "integer", value: "3" }]] } } },
          { type: "ok", response: { type: "execute", result: { cols: [{ name: "s" }], rows: [[{ type: "text", value: "a" }]] } } },
          kapat,
        ],
      })
    );
    const { batch } = await modul();
    const [a, b] = await batch([{ sql: "SELECT 3 AS n" }, { sql: "SELECT 'a' AS s" }]);
    expect(gonderilen[0].requests.map((r) => r.type)).toEqual(["execute", "execute", "close"]);
    expect(a.rows).toEqual([{ n: 3 }]);
    expect(b.rows).toEqual([{ s: "a" }]);
  });
});

describe("telefonda birlikte yazılması gereken kayıtlar tek parça yazılıyor", () => {
  const dosyalar = ["ad-budgets", "cost-save", "finance", "prep", "rule-crud", "spools"];
  for (const f of dosyalar) {
    it(`${f}.ts writeBatch kullanıyor`, () => {
      const kaynak = fs.readFileSync(path.join(ROOT, `mobile/src/lib/db/${f}.ts`), "utf8");
      expect(kaynak).toMatch(/\bwriteBatch\(/);
      // Yazma ifadesiyle başlayan atomik olmayan batch kalmadı.
      expect(kaynak).not.toMatch(/(?<![A-Za-z])batch\(\s*\[\s*\{\s*sql:\s*`\s*(UPDATE|INSERT|DELETE)/i);
    });
  }
});
