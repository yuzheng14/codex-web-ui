import { z } from 'zod';

export const backupIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/);
export const backupTriggers = ['manual', 'preUpgrade', 'preRestore'] as const;
export const backupPhases = [
  'waiting',
  'copying',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'corrupt',
] as const;
export const backupManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    complete: z.literal(true),
    id: backupIdSchema,
    createdAt: z.number().int().positive(),
    appVersion: z.string().min(1),
    commit: z.string().optional(),
    trigger: z.enum(backupTriggers),
    configPath: z.string(),
    dataDir: z.string(),
    schemaVersion: z.number().int().positive(),
    migrationHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    files: z
      .array(
        z
          .object({
            name: z.enum(['app.sqlite', 'config.json']),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(2),
    protectedBy: z.string().optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.files.map((file) => file.name)).size === 2 &&
      value.migrationHashes.length === value.schemaVersion,
  );
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export interface BackupRecord {
  id: string;
  phase: (typeof backupPhases)[number];
  trigger: (typeof backupTriggers)[number];
  createdAt: number;
  updatedAt: number;
  path: string;
  message: string;
  progress?: number;
  manifest?: BackupManifest;
}
export interface BackupStatus {
  directory: string;
  schemaVersion: number;
  records: BackupRecord[];
  active?: BackupRecord;
  supported: boolean;
  unsupportedReason?: string;
}
export interface BackupController {
  status(): Promise<BackupStatus>;
  start(input: { clientOperationId: string }): Promise<BackupStatus>;
  cancel(id: string): Promise<BackupStatus>;
  verify(id: string): Promise<BackupStatus>;
  close(): Promise<void>;
}
