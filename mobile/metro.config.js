// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const sharedCore = path.resolve(projectRoot, "src", "core");

const config = getDefaultConfig(projectRoot);

// Masaüstüyle AYNI iş mantığı (kâr/maliyet/KDV/kural). src/core, masaüstündeki
// ../src/core'un kopyasıdır — EAS bulut build'i parent dizini yüklemediği için
// vendor'landı. Güncellemek için: `npm run sync-core`. Saf TS, Node/Prisma yok.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "@core": sharedCore,
};

module.exports = config;
