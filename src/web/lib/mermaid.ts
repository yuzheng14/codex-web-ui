let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize configuration and rendering: Mermaid's configuration is global. */
export function renderMermaid(source: string, dark: boolean, signal: AbortSignal) {
  const result = queue.then(async () => {
    signal.throwIfAborted();
    if (source.length > 50_000) throw new Error('Mermaid source exceeds the rendering limit');
    const { default: mermaid } = await import('mermaid');
    signal.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      theme: dark ? 'dark' : 'neutral',
      fontFamily: 'system-ui, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // Diagram directives/frontmatter cannot relax security or inject theme CSS.
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'suppressErrorRendering',
        'maxTextSize',
        'maxEdges',
        'dompurifyConfig',
        'theme',
        'themeCSS',
        'themeVariables',
        'fontFamily',
        'htmlLabels',
        'flowchart',
      ],
    });
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;';
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`mermaid-${++nextId}`, source, container);
      signal.throwIfAborted();
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = document.documentElement;
      if (root.localName !== 'svg' || document.querySelector('parsererror')) {
        throw new Error('Invalid Mermaid SVG');
      }
      const bounds = root
        .getAttribute('viewBox')
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      if (bounds?.length === 4 && bounds.every(Number.isFinite)) {
        root.setAttribute('width', String(bounds[2]));
        root.setAttribute('height', String(bounds[3]));
      }
      // SVG image mode disables scripts, links and external resources, and isolates styles.
      // Never insert generated SVG as page HTML or bind Mermaid's click callbacks.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
    } finally {
      container.remove();
    }
  });
  queue = result.catch(() => {});
  return result;
}
