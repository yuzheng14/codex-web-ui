import { t } from '../i18n';
interface ThreadOriginInput {
  originator?: string | null;
  source: string;
}

export function threadOrigin(thread: ThreadOriginInput): { label: string; description: string } {
  const { originator, source } = thread;
  if (originator?.trim()) {
    switch (originator) {
      case 'codex_web_ui':
        return { label: 'Web', description: t('sidebar:created_by_covro_this_web_page') };
      case 'codex-tui':
        return { label: 'CLI', description: t('sidebar:created_by_the_codex_terminal_cli') };
      // Exact client names verified in Codex rust-v0.162.1:
      // app-server-protocol/src/protocol/common.rs and
      // app-server/src/request_processors/initialize_processor.rs.
      case 'codex_vscode':
        return {
          label: 'VS Code',
          description: t('sidebar:created_by_the_codex_extension_in_vs_code'),
        };
      case 'Codex Desktop':
        return {
          label: 'Codex Desktop',
          description: t('sidebar:created_by_the_codex_desktop_app'),
        };
      default:
        return {
          label: originator,
          description: t('sidebar:recorded_creator', { v0: originator }),
        };
    }
  }

  // Session source describes a Codex runtime category, not always the creating client.
  switch (source) {
    case 'cli':
      return { label: 'CLI', description: t('sidebar:recorded_as_a_codex_terminal_cli_source') };
    case 'vscode':
      return {
        label: t('sidebar:interactive_client'),
        description: t('sidebar:codex_only_recorded_an_interactive_source_category_it'),
      };
    // Codex's public appServer value maps to its core MCP session source.
    case 'appServer':
    case 'mcp':
      return { label: 'MCP', description: t('sidebar:recorded_as_a_codex_mcp_service_source') };
    case 'exec':
      return {
        label: t('sidebar:command_line_task'),
        description: t('sidebar:recorded_as_a_non_interactive_codex_command_line'),
      };
    default:
      return {
        label: t('sidebar:source_unconfirmed'),
        description:
          source && source !== 'unknown'
            ? t('sidebar:no_recognizable_creator_codex_source_is_recorded_as', { v0: source })
            : t('sidebar:no_recognizable_creator_information'),
      };
  }
}
