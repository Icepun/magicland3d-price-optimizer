/**
 * Turso (libSQL) HTTP client — saf fetch, native modül/polyfill YOK (Expo Go uyumlu).
 * Hrana over HTTP protokolü: POST /v2/pipeline.
 * Masaüstü uygulamasıyla AYNI veritabanı (token .env'den, EXPO_PUBLIC_*).
 *
 * Not: 2 özel cihaz için token bundle'a gömülür (masaüstündeki gibi). Public değil.
 */

import { setDbDateStorage } from "@core/sqlite-date";

const URL = process.env.EXPO_PUBLIC_TURSO_URL;
const TOKEN = process.env.EXPO_PUBLIC_TURSO_TOKEN;

/**
 * Tarih biçimini SABİTLE — telefon her zaman libSQL/HTTP üzerinden konuşur, yani kolonlara
 * ISO METİN yazılır. Ortak çekirdekteki otomatik tespit `process.env.TURSO_DATABASE_URL`'e bakar;
 * React Native'de o değişken YOKTUR ve varsayılan yanlış tarafa ("epoch-ms") düşerdi.
 * (Karşılaştırma yapan sorgular ayrıca `dbEpochMs()` ile biçimden bağımsızdır.)
 */
setDbDateStorage("iso-text");

export type SqlValue = string | number | boolean | null | undefined;

type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

function encode(v: SqlValue): HranaValue {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: v };
  }
  return { type: "text", value: String(v) };
}

function decode(v: HranaValue): SqlValue {
  switch (v.type) {
    case "null":
      return null;
    case "integer":
      return Number(v.value);
    case "float":
      return v.value;
    case "text":
      return v.value;
    case "blob":
      return v.base64; // nadir; ham base64
    default:
      return null;
  }
}

export interface ExecuteResult<T = Record<string, SqlValue>> {
  rows: T[];
  rowsAffected: number;
  lastInsertRowid: number | null;
}

interface Stmt {
  sql: string;
  args?: SqlValue[];
}

/** Hrana'nın bir ifade sonucu (execute yanıtı ve batch adımı aynı biçim). */
interface HranaStmtResult {
  cols: { name: string }[];
  rows: HranaValue[][];
  affected_row_count?: number;
  last_insert_rowid?: string | null;
}

/** Hrana toplu isteğinin sonucu: adım başına sonuç YA DA hata (koşulu tutmayan adımda ikisi de null). */
interface HranaBatchResult {
  step_results: (HranaStmtResult | null)[];
  step_errors: ({ message: string } | null)[];
}

type HranaResult =
  | { type: "ok"; response: { type: "execute"; result: HranaStmtResult } | { type: "batch"; result: HranaBatchResult } | { type: "close" } }
  | { type: "error"; error: { message: string } };

/** Pipeline isteğini gönder, ham sonuç dizisini döndür (zaman aşımı + HTTP hatası burada). */
async function gonder(requests: unknown[]): Promise<HranaResult[]> {
  if (!URL || !TOKEN) {
    throw new Error(
      "Turso bağlantı bilgisi yok. mobile/.env içinde EXPO_PUBLIC_TURSO_URL ve EXPO_PUBLIC_TURSO_TOKEN tanımlı mı?"
    );
  }
  // 12sn timeout: zayıf hücresel ağda takılan istek iOS varsayılanıyla ~60sn askıda kalıyordu
  // (pull-to-refresh spinner'ı kilitleniyordu). react-query retry:1 kısa denemeyle telafi eder.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(`${URL}/v2/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: [...requests, { type: "close" }] }), // Hrana v2: stmt'siz kapatma
      signal: ctrl.signal,
    });
  } catch (e) {
    throw ctrl.signal.aborted ? new Error("Turso zaman aşımı (12sn) — bağlantıyı kontrol et") : e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Turso HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { results: HranaResult[] };
  return json.results;
}

function sonuca(r: HranaStmtResult): ExecuteResult {
  const { cols, rows, affected_row_count, last_insert_rowid } = r;
  return {
    rows: rows.map((row) => {
      const obj: Record<string, SqlValue> = {};
      row.forEach((cell, i) => (obj[cols[i].name] = decode(cell)));
      return obj;
    }),
    rowsAffected: affected_row_count ?? 0,
    lastInsertRowid: last_insert_rowid ? Number(last_insert_rowid) : null,
  };
}

async function pipeline(stmts: Stmt[]): Promise<ExecuteResult[]> {
  const results = await gonder(
    stmts.map((s) => ({ type: "execute" as const, stmt: { sql: s.sql, args: (s.args ?? []).map(encode) } }))
  );
  const out: ExecuteResult[] = [];
  for (const r of results) {
    if (r.type === "error") throw new Error(`Turso SQL: ${r.error.message}`);
    if (r.response.type !== "execute") continue;
    out.push(sonuca(r.response.result));
  }
  return out;
}

/** Tek sorgu çalıştır, satırları tipli döndür. */
export async function execute<T = Record<string, SqlValue>>(
  sql: string,
  args?: SqlValue[]
): Promise<ExecuteResult<T>> {
  const [result] = await pipeline([{ sql, args }]);
  return result as ExecuteResult<T>;
}

/**
 * Birden çok sorguyu TEK round-trip'te (sıralı) çalıştır — OKUMA içindir.
 * ⚠️ ATOMİK DEĞİL: boru hattında her istek ayrı uygulanır; biri düşse de sonrakiler yazılır.
 * Birlikte uygulanması gereken yazmalar için `writeBatch`.
 */
export async function batch(stmts: Stmt[]): Promise<ExecuteResult[]> {
  return pipeline(stmts);
}

/**
 * YAZMA KÜMESİ — TEK PARÇA: ya hepsi uygulanır ya hiçbiri.
 *
 * NEDEN: `batch()` atomik değildi. Örn. reklam bütçesi değiştirirken eski dönem kapanıp yeni
 * dönem yazılamazsa (ağ koptu, kısıt hatası) yarım kayıt kalıyordu: eski bütçe bitmiş, yenisi
 * yok. Hrana'nın koşullu toplu isteğiyle (libSQL istemcisinin kendi yöntemi): BEGIN → her adım
 * bir öncekinin başarısına bağlı → COMMIT → COMMIT olmadıysa ROLLBACK. Sonuçlar `batch()` ile
 * aynı biçimde (yalnız kullanıcı ifadeleri) döner.
 */
export async function writeBatch(stmts: Stmt[]): Promise<ExecuteResult[]> {
  if (stmts.length === 0) return [];
  const n = stmts.length;
  // IMMEDIATE: yazma kilidi baştan alınır (libSQL istemcisinin "write" kipi) — işlemin ortasında
  // okuma kilidinden yazmaya yükselirken "database is locked" ile düşmesin.
  const steps: unknown[] = [{ stmt: { sql: "BEGIN IMMEDIATE" } }];
  stmts.forEach((s, i) => {
    steps.push({ condition: { type: "ok", step: i }, stmt: { sql: s.sql, args: (s.args ?? []).map(encode) } });
  });
  steps.push({ condition: { type: "ok", step: n }, stmt: { sql: "COMMIT" } });
  steps.push({ condition: { type: "not", cond: { type: "ok", step: n + 1 } }, stmt: { sql: "ROLLBACK" } });

  const [r] = await gonder([{ type: "batch", batch: { steps } }]);
  if (!r) throw new Error("Turso: yanıt alınamadı.");
  if (r.type === "error") throw new Error(`Turso SQL: ${r.error.message}`);
  if (r.response.type !== "batch") throw new Error("Turso: beklenmeyen yanıt.");
  const hatalar = r.response.result.step_errors ?? [];
  const cikti = r.response.result.step_results ?? [];
  // İlk başarısız adımın gerçek hatası (BEGIN dahil) — kayıt geri alındı.
  for (let i = 0; i <= n + 1; i++) {
    if (hatalar[i]) throw new Error(`Turso SQL: ${hatalar[i]!.message}`);
  }
  if (!cikti[n + 1]) throw new Error("Kayıt tamamlanamadı, değişiklik geri alındı.");
  return cikti.slice(1, n + 1).map((x) => sonuca(x ?? { cols: [], rows: [] }));
}

/** Sadece satırları döndüren kısayol. */
export async function query<T = Record<string, SqlValue>>(
  sql: string,
  args?: SqlValue[]
): Promise<T[]> {
  return (await execute<T>(sql, args)).rows;
}
