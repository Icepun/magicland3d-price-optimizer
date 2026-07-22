"use client";

import { useSyncExternalStore } from "react";

const subscribeClient = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/** Hydration ile uyumlu biçimde yalnız istemciye geçildikten sonra true döner. */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribeClient, getClientSnapshot, getServerSnapshot);
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Sistem hareket tercihini React'in harici-store sözleşmesiyle izler. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getServerSnapshot,
  );
}
