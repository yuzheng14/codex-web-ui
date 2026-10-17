import { useId, useRef, useState } from 'react';
import type { AsyncQuestion, AsyncQuestionReply } from '../../shared/types';
import { asyncQuestionId } from '../../shared/async-questions';
import { Button } from './ui/button';
import { Icon } from './Icon';

export interface AsyncQuestionControls {
  disabled: boolean;
  onReply: (replies: AsyncQuestionReply[]) => Promise<boolean>;
}

export function AsyncQuestionCard({
  itemId,
  questions,
  replies = [],
  disabled,
  onReply,
}: AsyncQuestionControls & {
  itemId: string;
  questions: AsyncQuestion[];
  replies?: AsyncQuestionReply[];
}) {
  const id = useId();
  const [choices, setChoices] = useState<number[]>(() =>
    questions.map((q) => (q.options?.length ? 0 : -1)),
  );
  const [texts, setTexts] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sent, setSent] = useState<string[]>();
  const recorded = questions.map(
    (q, index) =>
      replies.find((reply) => reply.questionItemId === asyncQuestionId(itemId, index))?.answer ??
      replies.find((reply) => reply.questionItemId === itemId && reply.question === q.title)
        ?.answer ??
      sent?.[index],
  );
  const resolved = recorded.every((answer) => answer !== undefined);
  const answers = questions.map(
    (q, index) =>
      recorded[index] ??
      (choices[index] === -1 ? texts[index] : q.options?.[choices[index] ?? 0])?.trim() ??
      '',
  );
  const locked = disabled || sending || Boolean(resolved);
  return (
    <section className="async-question-card" aria-label="Codex 的提问">
      <div className="async-question-heading">
        <span>
          <Icon name="chat" size={16} />
          需要你的回答
        </span>
        <small>{resolved ? '已发送回答' : sending ? '正在发送…' : '可稍后回答'}</small>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked || sendingRef.current || answers.some((answer) => !answer)) return;
          sendingRef.current = true;
          setSending(true);
          try {
            if (
              await onReply(
                questions.flatMap((q, index) =>
                  recorded[index] !== undefined
                    ? []
                    : [
                        {
                          questionItemId: asyncQuestionId(itemId, index),
                          question: q.title,
                          answer: answers[index]!,
                        },
                      ],
                ),
              )
            )
              setSent(answers);
          } finally {
            sendingRef.current = false;
            setSending(false);
          }
        }}
      >
        {questions.map((question, index) => (
          <fieldset key={index} disabled={locked || recorded[index] !== undefined}>
            <legend>{question.title}</legend>
            {recorded[index] !== undefined ? (
              <p className="async-question-answer">{recorded[index]}</p>
            ) : (
              <>
                {question.options?.map((option, choice) => (
                  <label className="question-option" key={choice}>
                    <input
                      type="radio"
                      name={`${id}-${index}`}
                      checked={choices[index] === choice}
                      onChange={() =>
                        setChoices((previous) =>
                          previous.map((value, i) => (i === index ? choice : value)),
                        )
                      }
                    />
                    <span>{option}</span>
                  </label>
                ))}
                {Boolean(question.options?.length) && (
                  <label className="question-option">
                    <input
                      type="radio"
                      name={`${id}-${index}`}
                      checked={choices[index] === -1}
                      onChange={() =>
                        setChoices((previous) =>
                          previous.map((value, i) => (i === index ? -1 : value)),
                        )
                      }
                    />
                    <span>自由回答</span>
                  </label>
                )}
                {choices[index] === -1 && (
                  <textarea
                    className="text-input"
                    aria-label={`${question.title}：自由回答`}
                    placeholder="输入你的回答"
                    rows={2}
                    maxLength={10000}
                    value={texts[index] ?? ''}
                    onChange={(event) =>
                      setTexts((previous) => {
                        const next = [...previous];
                        next[index] = event.target.value;
                        return next;
                      })
                    }
                  />
                )}
              </>
            )}
          </fieldset>
        ))}
        {!resolved && (
          <div className="async-question-footer">
            <span>回答会发送到当前会话，Codex 可以继续执行。</span>
            <Button type="submit" disabled={locked || answers.some((answer) => !answer)}>
              {sending ? '正在发送…' : '发送回答'}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}
