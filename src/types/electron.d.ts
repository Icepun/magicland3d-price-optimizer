export {};

type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdaterState {
  status: UpdaterStatus;
  message: string;
  version: string;
  availableVersion?: string;
  percent?: number;
  /** İndirme istatistikleri (download-progress) */
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

declare global {
  interface Window {
    trendyolPriceOptimizer?: {
      platform: NodeJS.Platform;
      updater?: {
        getStatus: () => Promise<UpdaterState>;
        getLogPath: () => Promise<string>;
        checkForUpdates: () => Promise<UpdaterState>;
        downloadUpdate: () => Promise<UpdaterState>;
        quitAndInstall: () => Promise<void>;
        onStatus: (callback: (status: UpdaterState) => void) => () => void;
      };
    };
  }
}
