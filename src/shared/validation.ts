import { z } from 'zod';
import { imageDataBytes, MAX_IMAGE_BYTES, MAX_IMAGES } from './images.js';
import type { TaskMessage } from './types.js';
export const cursorSchema = z.string().min(1).max(4096);
export const idSchema = z.string().min(1).max(256);
const projectNameSchema = z.string().trim().min(1).max(100);
export const createProjectSchema = z
  .object({ path: z.string().trim().min(1).max(4096), name: projectNameSchema.optional() })
  .strict();
export const renameProjectSchema = z.object({ name: projectNameSchema }).strict();
export const removeProjectSchema = z.object({}).strict();
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
export const forkThreadSchema = createThreadSchema;
export const resumeThreadSchema = createThreadSchema.extend({
  confirmExternalStopped: z.boolean().optional(),
});
const taskFields = {
  text: z.string().max(100_000),
  images: z
    .array(z.string().refine((value) => imageDataBytes(value) !== undefined, 'Invalid image'))
    .max(MAX_IMAGES)
    .refine(
      (images) =>
        images.reduce((sum, image) => sum + (imageDataBytes(image) ?? Infinity), 0) <=
        MAX_IMAGE_BYTES,
      'Images exceed size limit',
    )
    .optional(),
};
const hasContent = (input: TaskMessage) => Boolean(input.text.trim() || input.images?.length);
export const startTurnSchema = createThreadSchema
  .extend({
    ...taskFields,
  })
  .refine(hasContent, 'Text or an image is required');
export const steerSchema = operationSchema
  .extend({
    expectedTurnId: idSchema,
    ...taskFields,
  })
  .refine(hasContent, 'Text or an image is required');
export const interruptSchema = operationSchema.extend({ expectedTurnId: idSchema });
const elicitationValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(10_000)).max(500),
]);
export const resolveActionSchema = operationSchema.extend({
  resolution: z.union([
    z
      .object({
        decision: z.string().min(1).max(200),
        content: z.record(z.string().max(1000), elicitationValueSchema).optional(),
      })
      .strict(),
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
export const socketMessageSchema = z.discriminatedUnion('type', [
  subscribeSchema,
  z.object({ type: z.literal('unsubscribe') }).strict(),
]);

export const archiveThreadSchema = z.object({ archived: z.boolean() }).strict();
export const archivedQuerySchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');
