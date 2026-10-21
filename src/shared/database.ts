import { z } from 'zod';

export const databaseCompatibilitySchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    minRestorableSchemaVersion: z.number().int().positive(),
    backupFormatVersion: z.literal(1),
  })
  .strict()
  .refine((value) => value.minRestorableSchemaVersion <= value.schemaVersion);
export type DatabaseCompatibility = z.infer<typeof databaseCompatibilitySchema>;

export function databaseCompatibilityMarkdown(metadata: unknown) {
  const value = databaseCompatibilitySchema.parse(metadata);
  return `DB Schema: **${value.schemaVersion}**. Restorable schemas: **${value.minRestorableSchemaVersion}–${value.schemaVersion}**, subject to matching migration history. Backup format: **${value.backupFormatVersion}**. Older backups are migrated forward; newer schemas cannot be opened by this release. Downgrading the application does not downgrade its database; restore a compatible backup to roll back data.`;
}
