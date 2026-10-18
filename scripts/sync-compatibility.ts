import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CODEX_COMPATIBILITY } from '../src/codex/compatibility.js';
import {
  codexCompatibilitySchema,
  type CodexCompatibilityManifest,
} from '../src/shared/codex-compatibility.js';

export function compatibilityMarkdown(metadata: unknown, chinese = false) {
  const manifest = codexCompatibilitySchema.parse(metadata);
  const versions = manifest.verified.map((version) => `\`${version}\``).join(', ');
  const blocked = manifest.unsupported
    .map((entry) => `\`${entry.version}\`: ${entry.reason}`)
    .join('; ');
  return chinese
    ? `推荐 Codex CLI：**${manifest.recommended}**。已验证版本：${versions}。${blocked ? `明确不支持：${blocked}。` : ''}`
    : `Recommended Codex CLI: **${manifest.recommended}**. Verified versions: ${versions}.${blocked ? ` Unsupported: ${blocked}.` : ''}`;
}
export function compatibilityBlock(metadata: CodexCompatibilityManifest, chinese = false) {
  return `<!-- codex-compatibility:start -->\n\n${compatibilityMarkdown(metadata, chinese)}\n\n<!-- codex-compatibility:end -->`;
}
export function verifyCompatibility(write = false) {
  const protocol = JSON.parse(readFileSync('src/codex/protocol-version.json', 'utf8')) as {
    version: string;
  };
  if (protocol.version !== `codex-cli ${CODEX_COMPATIBILITY.recommended}`)
    throw new Error('Recommended Codex must match the generated protocol baseline');
  for (const filename of ['README.md', 'README.zh-CN.md', 'docs/compatibility.md']) {
    const source = readFileSync(filename, 'utf8');
    const pattern = /<!-- codex-compatibility:start -->[\s\S]*?<!-- codex-compatibility:end -->/g;
    const blocks = source.match(pattern);
    if (blocks?.length !== 1) throw new Error(`Expected one compatibility block in ${filename}`);
    const updated = source.replace(
      pattern,
      compatibilityBlock(CODEX_COMPATIBILITY, filename !== 'README.md'),
    );
    if (write) writeFileSync(filename, updated);
    else if (source !== updated) throw new Error(`${filename} is stale; run pnpm compat:sync`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyCompatibility(!process.argv.includes('--check'));
}
