import { t } from '../i18n';
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
        {t('commands:session_commands')}
        <span>{t('commands:applies_to_the_current_project_and_session')}</span>
      </div>
      <div
        id={id}
        role="listbox"
        aria-label={t('commands:slash_commands')}
        className="slash-options"
      >
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
          {t('commands:no_matching_commands_type_help_to_view_supported')}
        </p>
      )}
      <div className="slash-menu-footer">{t('commands:to_select_enter_to_run_esc_to_close')}</div>
    </div>
  );
}
