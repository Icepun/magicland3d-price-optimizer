import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "app-temp/**",
    "out/**",
    "build/**",
    "dist/**",
    // Mobil uygulama Expo'nun kendi ESLint yapılandırmasıyla ayrı çalıştırılır.
    "mobile/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
