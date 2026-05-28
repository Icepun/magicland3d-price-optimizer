/**
 * electron-builder v25.1.8 bazı durumlarda latest.yml dosyasını GitHub release'e
 * upload etmiyor — bu da electron-updater'ın "Cannot find latest.yml" hatasıyla
 * patlamasına neden oluyor.
 *
 * Bu script publish sonrası çalışır:
 *   1. package.json'dan sürümü okur
 *   2. dist/latest.yml dosyasını alır
 *   3. GitHub API üzerinden ilgili release'e upload eder (varsa üzerine yazar)
 *
 * Kullanım: GITHUB_TOKEN ortam değişkeniyle çalıştır.
 *   node scripts/upload-latest-yml.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.warn(
    "⚠ GITHUB_TOKEN/GH_TOKEN yok — latest.yml upload atlandı.\n" +
      "  Daha sonra elle çalıştırmak için:\n" +
      "    GITHUB_TOKEN=<token> node scripts/upload-latest-yml.mjs"
  );
  process.exit(0); // build pipeline'ı bozmasın
}

// package.json'dan sürüm + repo bilgisi al
const pkg = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
);
const version = pkg.version;
const tag = `v${version}`;

const publish = pkg.build?.publish;
const ghCfg = Array.isArray(publish)
  ? publish.find((p) => p.provider === "github")
  : publish?.provider === "github"
    ? publish
    : null;

if (!ghCfg) {
  console.error("HATA: package.json build.publish github config eksik.");
  process.exit(1);
}

const { owner, repo } = ghCfg;

// Platforma göre doğru update manifest'i: Windows latest.yml, macOS latest-mac.yml.
// Böylece aynı release'e iki platformun manifesti de eklenebilir (tek update, iki OS).
const ymlName = process.platform === "darwin" ? "latest-mac.yml" : "latest.yml";
const ymlPath = path.join(projectRoot, "dist", ymlName);

if (!fs.existsSync(ymlPath)) {
  console.error(`HATA: ${ymlPath} bulunamadı. Önce 'npm run build' / 'electron-builder' koştur.`);
  process.exit(1);
}

const ymlContent = fs.readFileSync(ymlPath);

const ghHeaders = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "magicland3d-publish-helper",
};

async function main() {
  console.log(`📦 ${owner}/${repo} — ${tag} → latest.yml upload`);

  // 1. Release'i bul
  const relRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
    { headers: ghHeaders }
  );
  if (!relRes.ok) {
    throw new Error(
      `Release ${tag} bulunamadı: ${relRes.status} ${relRes.statusText}`
    );
  }
  const release = await relRes.json();
  console.log(`   ✓ release id: ${release.id}`);

  // 2. Mevcut latest.yml asset'i varsa sil
  const existing = (release.assets || []).find((a) => a.name === "latest.yml");
  if (existing) {
    console.log(`   • mevcut latest.yml siliniyor (id ${existing.id})`);
    const delRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/assets/${existing.id}`,
      { method: "DELETE", headers: ghHeaders }
    );
    if (!delRes.ok && delRes.status !== 404) {
      throw new Error(`Asset silinemedi: ${delRes.status} ${delRes.statusText}`);
    }
  }

  // 3. Yeni latest.yml'i upload et
  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=latest.yml`;
  const upRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...ghHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(ymlContent.length),
    },
    body: ymlContent,
  });
  if (!upRes.ok) {
    const body = await upRes.text();
    throw new Error(`Upload başarısız: ${upRes.status} ${upRes.statusText}\n${body}`);
  }
  const asset = await upRes.json();
  console.log(`   ✓ uploaded: ${asset.browser_download_url}`);
}

main().catch((err) => {
  console.error("\n❌ HATA:", err.message);
  process.exit(1);
});
