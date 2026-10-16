import { useEffect, useRef } from 'react';
import type { SlashCommand } from '../lib/slash-commands';

interface Props {
  id: string;
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onExecute: (command: SlashCommand) => void;
}

export function SlashCommandMenu({ id, commands, selectedIndex, onSelect, onExecute }: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, commands[selectedIndex]?.name]);

  return (
    <div className="slash-menu">
      <div className="slash-menu-heading">
        会话命令 <span>作用于当前项目与会话</span>
      </div>
      <div id={id} role="listbox" aria-label="Slash 命令" className="slash-options">
        {commands.map((command, index) => (
          <button
            key={command.name}
            id={`${id}-${command.name}`}
            ref={index === selectedIndex ? selectedRef : undefined}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === selectedIndex}
            aria-disabled={Boolean(command.unavailableReason)}
            className="slash-option"
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={(event) => {
              if (event.pointerType === 'mouse') onSelect(index);
            }}
            onClick={() => onExecute(command)}
          >
            <span className="slash-option-title">
              <strong>/{command.name}</strong>
              <span>{command.usage}</span>
            </span>
            <span>{command.description}</span>
            {command.unavailableReason && (
              <span className="slash-unavailable">{command.unavailableReason}</span>
            )}
          </button>
        ))}
      </div>
      {commands.length === 0 && (
        <p className="slash-empty" role="status">
          没有匹配的命令。输入 /help 查看支持范围。
        </p>
      )}
      <div className="slash-menu-footer">↑ ↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>
  );
}
