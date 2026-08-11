import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Şifreleme anahtarı sabit olsun ki test cwd'ye anahtar dosyası yazmasın.
process.env.TRENDYOL_CREDENTIAL_KEY = "test-anahtari-turso-settings";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-turso-settings-"));
const settingsFile = path.join(tempDir, "turso-settings.json");
process.env.TURSO_SETTINGS_FILE = settingsFile;

const TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.cok-gizli-turso-tokeni.imza";
const URL = "libsql://ornek-veritabani.turso.io";

let mod: typeof import("./turso-settings");

async function writeRaw(content: unknown) {
  await fs.writeFile(settingsFile, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

async function readRaw(): Promise<Record<string, string | undefined>> {
  return JSON.parse(await fs.readFile(settingsFile, "utf8"));
}

beforeEach(async () => {
  delete process.env.MLHUB_TURSO_PLAINTEXT_BRIDGE;
  mod = await import("./turso-settings");
  await writeRaw({});
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Turso ayarları — token şifreleme", () => {
  it("diskteki eski düz metin token okunmaya devam eder", async () => {
    await writeRaw({ url: URL, authToken: TOKEN });

    const conn = await mod.getTursoConnection();

    expect(conn.url).toBe(URL);
    expect(conn.authToken).toBe(TOKEN);
  });

  it("ilk okumada düz metin token sessizce şifreliye taşınır", async () => {
    await writeRaw({ url: URL, authToken: TOKEN });

    await mod.getTursoConnection();

    const raw = await readRaw();
    expect(raw.authTokenEnc).toBeTruthy();
    expect(raw.authTokenEnc).not.toContain(TOKEN);
    // Şifreli biçim: iv.authTag.ciphertext
    expect(raw.authTokenEnc?.split(".")).toHaveLength(3);
  });

  it("göçten sonra şifreli token doğru çözülür (tam tur)", async () => {
    await writeRaw({ url: URL, authToken: TOKEN });
    await mod.getTursoConnection();

    // Düz metin köprüsü kapalıyken bile şifreliden okunabilmeli.
    const raw = await readRaw();
    await writeRaw({ url: raw.url, authTokenEnc: raw.authTokenEnc });

    const conn = await mod.getTursoConnection();
    expect(conn.authToken).toBe(TOKEN);
    expect(conn.url).toBe(URL);
  });

  it("köprü kapalıyken göç düz metin kopyayı dosyadan siler", async () => {
    process.env.MLHUB_TURSO_PLAINTEXT_BRIDGE = "0";
    await writeRaw({ url: URL, authToken: TOKEN });

    await mod.getTursoConnection();

    const raw = await readRaw();
    expect(raw.authToken).toBeUndefined();
    expect(raw.authTokenEnc).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
  });

  it("kaydetme token'ı şifreli yazar", async () => {
    process.env.MLHUB_TURSO_PLAINTEXT_BRIDGE = "0";

    await mod.saveTursoSettings({ url: URL, authToken: TOKEN });

    const raw = await readRaw();
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect((await mod.getTursoConnection()).authToken).toBe(TOKEN);
  });

  it("token boş bırakılırsa mevcut token korunur", async () => {
    await mod.saveTursoSettings({ url: URL, authToken: TOKEN });

    await mod.saveTursoSettings({ url: "libsql://ornek-veritabani-2.turso.io" });

    const conn = await mod.getTursoConnection();
    expect(conn.url).toBe("libsql://ornek-veritabani-2.turso.io");
    expect(conn.authToken).toBe(TOKEN);
  });

  it("düz metin köprüsü açıkken main.js'in okuduğu alan korunur", async () => {
    await mod.saveTursoSettings({ url: URL, authToken: TOKEN });

    const raw = await readRaw();
    expect(raw.authToken).toBe(TOKEN);
    expect(raw.authTokenEnc).toBeTruthy();
  });

  it("çözülemeyen şifreli token varsa token yokmuş gibi davranır", async () => {
    await writeRaw({ url: URL, authTokenEnc: "bozuk.veri.blogu" });

    const pub = await mod.getPublicTursoSettings();

    expect(pub.hasAuthToken).toBe(false);
    expect(pub.url).toBe(URL);
  });
});

describe("Turso ayarları — token sızıntısı", () => {
  it("herkese açık ayar yanıtı ham token içermez", async () => {
    await mod.saveTursoSettings({ url: URL, authToken: TOKEN });

    const pub = await mod.getPublicTursoSettings();

    expect(JSON.stringify(pub)).not.toContain(TOKEN);
    expect(pub.hasAuthToken).toBe(true);
    expect(pub.authTokenMasked).toBe(`••••••••${TOKEN.slice(-4)}`);
  });

  it("maske token'ın baş kısmını göstermez", async () => {
    await mod.saveTursoSettings({ url: URL, authToken: TOKEN });

    const { authTokenMasked } = await mod.getPublicTursoSettings();

    expect(authTokenMasked.startsWith("eyJ")).toBe(false);
    expect(authTokenMasked.length).toBeLessThan(16);
  });

  it("bağlantı kaldırılınca dosyada token kalmaz", async () => {
    await mod.saveTursoSettings({ url: URL, authToken: TOKEN });

    await mod.clearTursoSettings();

    const raw = await readRaw();
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect((await mod.getPublicTursoSettings()).hasAuthToken).toBe(false);
  });
});
