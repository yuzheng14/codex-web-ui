import packageJson from '../../package.json' with { type: 'json' };
import { codexCompatibilitySchema } from '../shared/codex-compatibility.js';

/** This package's immutable declaration is shared by runtime, npm metadata and release docs. */
export const CODEX_COMPATIBILITY = codexCompatibilitySchema.parse(packageJson.covroCodex);
