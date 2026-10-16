/** Human-chosen names have their own bound; generated titles retain their shorter policy. */
export const MAX_THREAD_NAME_CHARACTERS = 100;

export function threadNameError(name: string): string | undefined {
  if (!name.trim()) return '请输入会话名称。用法：/rename <名称>';
  // Control characters are intentionally rejected from a display name.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name))
    return '会话名称不能包含换行或控制字符。';
  if ([...name.trim()].length > MAX_THREAD_NAME_CHARACTERS)
    return `会话名称最多 ${MAX_THREAD_NAME_CHARACTERS} 个字符。`;
  return undefined;
}
