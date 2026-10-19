/** Gateway file settings, independent of Codex's model and conversation settings. */
export interface GatewayConfig {
  host: string;
  port: number;
  publicOrigin: string[];
  developmentOrigins: string[];
  dataDir: string;
  codex: {
    binary: string;
    home?: string;
    requestTimeoutMs: number;
    maxLineBytes: number;
  };
  auth: { mode: 'local' } | { mode: 'cloudflare-access'; issuer: string; audience: string };
  projects: { id: string; name: string; path: string }[];
  limits: { eventBytes: number; wsBytes: number; itemBytes: number };
}

export interface GatewayConfigSnapshot {
  path: string;
  revision: string;
  saved: GatewayConfig;
  running: GatewayConfig;
  restartRequired: boolean;
  writable: boolean;
  readOnlyReason?: string;
}

export interface GatewayConfigImport {
  config: GatewayConfig;
  preserved: string[];
}
