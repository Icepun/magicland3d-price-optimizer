# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# src/core is a VENDORED COPY — never edit by hand

`src/core/` is copied from the desktop app's `../src/core` via `npm run sync-core`
(which deletes `printers/` and `*.test.ts`). Any manual edit here WILL be silently
destroyed by the next sync. Change the desktop copy instead, then run `npm run sync-core`.
Before every OTA/build, run `npm run check-core` — it fails loudly if the two copies
have drifted (i.e. desktop core changed but mobile wasn't re-synced).
