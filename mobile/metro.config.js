// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");
const sharedCore = path.resolve(repoRoot, "src", "core");

const config = getDefaultConfig(projectRoot);

// Masaüstü uygulamasıyla AYNI iş mantığını paylaş (kâr/maliyet/KDV/kural hesapları).
// ../src/core saf TypeScript — Node/Prisma bağımlılığı yok, RN'e doğrudan import edilir.
config.watchFolders = [sharedCore];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "@core": sharedCore,
};

module.exports = config;
