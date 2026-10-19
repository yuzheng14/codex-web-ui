import { z } from 'zod';
import { npmPackageName } from '../src/shared/package.js';
import { packageMetadataUrl, validVersion } from '../src/updates/registry.js';

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const version = z.string().refine(validVersion);
const publishedRelease = z.object({
  name: z.literal(npmPackageName),
  version,
  covroCommit: commit.optional(),
  gitHead: commit.optional(),
});
const packageRegistrySchema = z
  .object({
    name: z.literal(npmPackageName),
    versions: z.record(version, publishedRelease),
    'dist-tags': z.record(z.string(), version),
  })
  .superRefine((metadata, context) => {
    for (const [key, release] of Object.entries(metadata.versions)) {
      if (key !== release.version)
        context.addIssue({ code: 'custom', message: `Version identity mismatch: ${key}` });
      if (release.covroCommit && release.gitHead && release.covroCommit !== release.gitHead)
        context.addIssue({ code: 'custom', message: `Commit identity mismatch: ${key}` });
    }
    for (const [tag, selected] of Object.entries(metadata['dist-tags'])) {
      if (!metadata.versions[selected])
        context.addIssue({
          code: 'custom',
          message: `Tag ${tag} references an unavailable version`,
        });
    }
  });

export type PublishedRelease = z.infer<typeof publishedRelease>;
export type PackageRegistry = z.infer<typeof packageRegistrySchema>;
export function releaseCommit(release: PublishedRelease) {
  return release.covroCommit ?? release.gitHead;
}

export async function readPackageRegistry(): Promise<PackageRegistry> {
  // Read the full history: a moved/deleted tag must not make a used sequence reusable.
  const response = await fetch(packageMetadataUrl(), {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (response.status === 404) return { name: npmPackageName, versions: {}, 'dist-tags': {} };
  if (!response.ok) throw new Error(`npm metadata failed: ${response.status}`);
  return packageRegistrySchema.parse(await response.json());
}
