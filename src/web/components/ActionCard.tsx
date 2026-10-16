import { useState } from 'react';
import type { ActionResolution, PendingAction } from '../../shared/types';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { PermissionDetails } from './PermissionDetails';
import { ElicitationForm } from './ElicitationForm';
import { actionStatusLabel } from '../lib/action-status';

export function ActionCard({
  action,
  disabled,
  onResolve,
}: {
  action: PendingAction;
  disabled: boolean;
  onResolve: (resolution: ActionResolution) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const pending = action.status === 'pending';
  const questions = action.questions ?? [];
  const answerFor = (id: string) =>
    answers[id] === '__other__' ? (other[id]?.trim() ?? '') : (answers[id]?.trim() ?? '');
  const canSubmit = questions.length > 0 && questions.every((question) => answerFor(question.id));
  // requestUserInput carries answers, not approval decisions. Use the input structure,
  // never words such as “允许” in the question, to describe the confirmation.
  const choosing =
    questions.length > 0 &&
    questions.every(
      (question) => question.options.length > 0 && answers[question.id] !== '__other__',
    );
  return (
    <section
      className={`action-card${action.kind === 'unsupported' ? ' action-card-unsupported' : ''}`}
      aria-label={action.title}
    >
      <div className="action-heading">
        <span className="action-icon">
          <Icon name={action.kind === 'questions' ? 'chat' : 'alert'} size={17} />
        </span>
        <h3>{action.title}</h3>
        <span className="action-state">
          {action.kind === 'unsupported' && action.status === 'expired'
            ? '请求未能处理'
            : actionStatusLabel(action.status)}
        </span>
      </div>
      {action.reason && <p>{action.reason}</p>}
      {action.cwd && (
        <p className="mono subtle action-cwd">
          <span>工作目录：</span>
          {action.cwd}
        </p>
      )}
      {action.command && (
        <pre className="command">
          <code>{action.command}</code>
        </pre>
      )}
      {action.kind === 'permissions' && action.permissionRequest && (
        <PermissionDetails request={action.permissionRequest} />
      )}
      {action.details !== undefined && (
        <details
          className="raw-details"
          open={action.kind === 'network' || action.kind === 'file' || undefined}
        >
          <summary>
            {action.kind === 'network'
              ? '网络访问目标'
              : action.kind === 'file'
                ? '变更详情'
                : action.kind === 'permissions' || action.kind === 'elicitation'
                  ? '技术详情'
                  : '请求详情'}
          </summary>
          <pre>{JSON.stringify(action.details, null, 2)}</pre>
        </details>
      )}
      {action.kind === 'elicitation' && action.elicitation ? (
        <ElicitationForm
          request={action.elicitation}
          actionId={action.actionId}
          status={action.status}
          disabled={disabled || !pending}
          onResolve={onResolve}
        />
      ) : action.kind === 'questions' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && pending && canSubmit)
              onResolve({
                answers: Object.fromEntries(
                  questions.map((question) => [question.id, [answerFor(question.id)]]),
                ),
              });
          }}
        >
          {questions.map((question) => (
            <fieldset key={question.id} disabled={disabled || !pending}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              {question.options.map((option, index) => (
                <label key={option.label} className="question-option">
                  <input
                    type="radio"
                    name={`${action.actionId}-${question.id}`}
                    value={option.label}
                    checked={answers[question.id] === option.label}
                    onChange={() =>
                      setAnswers((previous) => ({ ...previous, [question.id]: option.label }))
                    }
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  <span className="option-number">{index + 1}</span>
                </label>
              ))}
              {question.options.length > 0 && question.isOther && (
                <label className="question-option">
                  <input
                    type="radio"
                    name={`${action.actionId}-${question.id}`}
                    checked={answers[question.id] === '__other__'}
                    onChange={() =>
                      setAnswers((previous) => ({ ...previous, [question.id]: '__other__' }))
                    }
                  />
                  <span>其他回答</span>
                </label>
              )}
              {(question.options.length === 0 || answers[question.id] === '__other__') && (
                <input
                  className="text-input"
                  type={question.isSecret ? 'password' : 'text'}
                  aria-label={`${question.header}：自由回答`}
                  value={
                    question.options.length === 0
                      ? (answers[question.id] ?? '')
                      : (other[question.id] ?? '')
                  }
                  maxLength={10000}
                  onChange={(event) =>
                    question.options.length === 0
                      ? setAnswers((previous) => ({
                          ...previous,
                          [question.id]: event.target.value,
                        }))
                      : setOther((previous) => ({ ...previous, [question.id]: event.target.value }))
                  }
                  placeholder="输入你的回答"
                  autoComplete="off"
                />
              )}
            </fieldset>
          ))}
          <Button type="submit" disabled={disabled || !pending || !canSubmit}>
            {!pending ? actionStatusLabel(action.status) : choosing ? '确认选择' : '提交回答'}
          </Button>
        </form>
      ) : (
        <div className="action-options">
          {action.options.map((option) => (
            <Button
              key={option.id}
              variant={/decline|cancel|reject|deny/i.test(option.id) ? 'secondary' : 'default'}
              disabled={disabled || !pending}
              onClick={() => onResolve({ decision: option.id })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {action.kind === 'unsupported' && (
        <p className="inline-error">当前版本不支持此交互请求，未发送批准。请查看兼容性诊断。</p>
      )}
    </section>
  );
}
