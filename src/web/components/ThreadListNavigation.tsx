import { Component, createRef, type ReactNode } from 'react';

type Anchor = { id: string; top: number } | null;

/** Capture before React moves keyed rows, then retain the reader's visible row after sorting. */
export class ThreadListNavigation extends Component<{ context: string; children: ReactNode }> {
  private readonly list = createRef<HTMLElement>();
  getSnapshotBeforeUpdate(previous: Readonly<{ context: string; children: ReactNode }>): Anchor {
    const list = this.list.current;
    if (!list || list.scrollTop === 0 || previous.context !== this.props.context) return null;
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll<HTMLElement>('[data-thread-id]')].find(
      (row) => row.getBoundingClientRect().top >= top + 32,
    );
    return row ? { id: row.dataset.threadId!, top: row.getBoundingClientRect().top } : null;
  }
  componentDidUpdate(_previous: unknown, _state: unknown, anchor: Anchor) {
    const list = this.list.current;
    if (!list || !anchor) return;
    const row = [...list.querySelectorAll<HTMLElement>('[data-thread-id]')].find(
      (row) => row.dataset.threadId === anchor.id,
    );
    if (row) list.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }
  render() {
    return (
      <nav
        ref={this.list}
        className="project-list"
        aria-label="会话历史"
        style={{ overflowAnchor: 'none' }}
      >
        {this.props.children}
      </nav>
    );
  }
}
