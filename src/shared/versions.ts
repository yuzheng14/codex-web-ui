const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function validVersion(version: string) {
  const match = versionPattern.exec(version);
  return Boolean(
    match &&
    (!match[4] ||
      match[4]
        .split('.')
        .every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))),
  );
}
export function compareVersions(left: string, right: string): number {
  if (!validVersion(left) || !validVersion(right)) throw new Error('Invalid release version');
  const a = versionPattern.exec(left)!;
  const b = versionPattern.exec(right)!;
  for (let i = 1; i <= 3; i++) {
    const difference = BigInt(a[i]!) - BigInt(b[i]!);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split('.');
  const bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
