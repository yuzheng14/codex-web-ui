import type { AsyncQuestionReply } from './types.js';

// The native desktop/CLI envelope correlates ordinary user messages with async questions.
const opening = '<send_user_message_question_reply>';
const closing = '</send_user_message_question_reply>';

export function asyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify(['request_user_input_async', itemId, index]);
}

export function encodeQuestionReplies(replies: AsyncQuestionReply[]): string {
  return `${opening}${JSON.stringify(replies)}${closing}`;
}

export function parseQuestionReplies(text: string): AsyncQuestionReply[] | undefined {
  let content = text.trim();
  if (content.startsWith('# Context from my IDE setup:\n')) {
    const delimiter = '\n## My request for Codex:\n';
    const index = content.lastIndexOf(delimiter);
    if (index < 0) return;
    content = content.slice(index + delimiter.length).trim();
  }
  if (!content.startsWith(opening) || !content.endsWith(closing)) return;
  try {
    const parsed: unknown = JSON.parse(content.slice(opening.length, -closing.length));
    const replies: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (
      !replies.length ||
      !replies.every(
        (reply): reply is AsyncQuestionReply =>
          typeof reply === 'object' &&
          reply !== null &&
          'questionItemId' in reply &&
          typeof reply.questionItemId === 'string' &&
          Boolean(reply.questionItemId.trim()) &&
          'question' in reply &&
          typeof reply.question === 'string' &&
          'answer' in reply &&
          typeof reply.answer === 'string',
      )
    )
      return;
    return replies.map(({ questionItemId, question, answer }) => ({
      questionItemId,
      question,
      answer,
    }));
  } catch {
    return;
  }
}
