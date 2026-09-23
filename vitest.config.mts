import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "src"),
      // Mobil modülleri kökten test edebilmek için: mobilin `@core/…` takma adı masaüstündeki
      // `src/core`'un bayt kopyasıdır (check-core doğrular), aynı yere çözülür.
      "@core": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "src/core"),
    },
  },
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
