export const releaseChannels = ['stable', 'beta', 'dev'] as const;
export type ReleaseChannel = (typeof releaseChannels)[number];
export interface UpdateSettings {
  channel: ReleaseChannel;
  automatic: boolean;
}
export type UpdatePhase =
  'installing' | 'waiting' | 'stopping' | 'verifying' | 'succeeded' | 'rolledBack' | 'failed';
export interface UpdateRun {
  id: string;
  from: string;
  target: string;
  channel: ReleaseChannel;
  phase: UpdatePhase;
  message: string;
  startedAt: number;
  updatedAt: number;
  committed?: boolean;
}
export interface UpdateStatus {
  version: string;
  commit?: string;
  source: 'npm';
  settings: UpdateSettings;
  available?: { version: string; channel: ReleaseChannel; commit?: string; downgrade: boolean };
  checkedAt?: number;
  checkError?: string;
  supported: boolean;
  unsupportedReason?: string;
  run?: UpdateRun;
}
export const updateActive = (run?: UpdateRun) =>
  Boolean(run && ['installing', 'waiting', 'stopping', 'verifying'].includes(run.phase));
export interface UpdateController {
  status(): Promise<UpdateStatus>;
  check(channel?: ReleaseChannel): Promise<UpdateStatus>;
  configure(settings: UpdateSettings): Promise<UpdateStatus>;
  start(input: {
    clientOperationId: string;
    channel?: ReleaseChannel;
    allowDowngrade?: boolean;
  }): Promise<UpdateStatus>;
  close(): void;
}
