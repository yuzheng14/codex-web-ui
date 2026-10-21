/** A suggestion only; repository validation still runs before starting Git. */
export function repositoryDirectory(repository: string): string {
  const name =
    repository
      .trim()
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '') ?? '';
  return name && name !== '.' && name !== '..' && !/[\\\s?#\0]/.test(name) ? name : '';
}
