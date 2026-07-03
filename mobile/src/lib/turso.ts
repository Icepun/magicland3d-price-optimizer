/**
 * Turso (libSQL) HTTP client — saf fetch, native modül/polyfill YOK (Expo Go uyumlu).
 * Hrana over HTTP protokolü: POST /v2/pipeline.
 * Masaüstü uygulamasıyla AYNI veritabanı (token .env'den, EXPO_PUBLIC_*).
 *
 * Not: 2 özel cihaz için token bundle'a gömülür (masaüstündeki gibi). Public değil.
 */

const URL = process.env.EXPO_PUBLIC_TURSO_URL;
const TOKEN = process.env.EXPO_PUBLIC_TURSO_TOKEN;

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

async function pipeline(stmts: Stmt[]): Promise<ExecuteResult[]> {
  if (!URL || !TOKEN) {
    throw new Error(
      "Turso bağlantı bilgisi yok. mobile/.env içinde EXPO_PUBLIC_TURSO_URL ve EXPO_PUBLIC_TURSO_TOKEN tanımlı mı?"
    );
  }

  type PipelineRequest =
    | { type: "execute"; stmt: { sql: string; args: ReturnType<typeof encode>[] } }
    | { type: "close" };
  const requests: PipelineRequest[] = stmts.map((s) => ({
    type: "execute" as const,
    stmt: { sql: s.sql, args: (s.args ?? []).map(encode) },
  }));
  requests.push({ type: "close" }); // Hrana v2: stmt'siz geçerli kapatma isteği

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
      body: JSON.stringify({ requests }),
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

  const json = (await res.json()) as {
    results: Array<
      | {
          type: "ok";
          response: {
            type: string;
            result?: {
              cols: { name: string }[];
              rows: HranaValue[][];
              affected_row_count?: number;
              last_insert_rowid?: string | null;
            };
          };
        }
      | { type: "error"; error: { message: string } }
    >;
  };

  const out: ExecuteResult[] = [];
  for (const r of json.results) {
    if (r.type === "error") throw new Error(`Turso SQL: ${r.error.message}`);
    if (r.response.type !== "execute" || !r.response.result) continue;
    const { cols, rows, affected_row_count, last_insert_rowid } = r.response.result;
    out.push({
      rows: rows.map((row) => {
        const obj: Record<string, SqlValue> = {};
        row.forEach((cell, i) => (obj[cols[i].name] = decode(cell)));
        return obj;
      }),
      rowsAffected: affected_row_count ?? 0,
      lastInsertRowid: last_insert_rowid ? Number(last_insert_rowid) : null,
    });
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

/** Birden çok sorguyu TEK round-trip'te (sıralı) çalıştır. */
export async function batch(stmts: Stmt[]): Promise<ExecuteResult[]> {
  return pipeline(stmts);
}

/** Sadece satırları döndüren kısayol. */
export async function query<T = Record<string, SqlValue>>(
  sql: string,
  args?: SqlValue[]
): Promise<T[]> {
  return (await execute<T>(sql, args)).rows;
}
