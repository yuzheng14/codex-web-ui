import { z } from 'zod';
export const cursorSchema = z.string().min(1).max(4096);
export const idSchema = z.string().min(1).max(256);
export const settingsSchema = z
  .object({
    model: z.string().min(1).max(200).optional(),
    reasoningEffort: z.string().min(1).max(40).optional(),
    approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  })
  .strict();
export const operationSchema = z.object({ clientOperationId: z.string().uuid() }).strict();
export const confirmCompatibilitySchema = operationSchema.extend({
  codexEpoch: idSchema,
  codexVersion: z.string().min(1).max(200),
  verifiedVersion: z.string().min(1).max(200),
  confirm: z.literal(true),
});
export const createThreadSchema = operationSchema.extend({ settings: settingsSchema.optional() });
export const resumeThreadSchema = createThreadSchema.extend({
  confirmExternalStopped: z.boolean().optional(),
});
const taskTextSchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine((text) => text.trim().length > 0, 'Text must not be blank');
export const startTurnSchema = createThreadSchema.extend({
  text: taskTextSchema,
});
export const steerSchema = operationSchema.extend({
  expectedTurnId: idSchema,
  text: taskTextSchema,
});
export const interruptSchema = operationSchema.extend({ expectedTurnId: idSchema });
export const resolveActionSchema = operationSchema.extend({
  resolution: z.union([
    z.object({ decision: z.string().min(1).max(200) }).strict(),
    z.object({ answers: z.record(z.string(), z.array(z.string().max(10_000)).max(50)) }).strict(),
  ]),
});
export const reconcileSchema = operationSchema.extend({ confirmEnded: z.literal(true) });
export const subscribeSchema = z
  .object({
    type: z.literal('subscribe'),
    threadId: idSchema,
    after: z
      .object({ serverEpoch: idSchema, seq: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
