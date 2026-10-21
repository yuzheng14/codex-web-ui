import { useEffect, type RefObject } from 'react';

/** Keep the whole composer, including its send button, above the soft keyboard.
 * VisualViewport also handles Safari, which does not resize the layout viewport.
 */
export function useMobileInputViewport(
  shellRef: RefObject<HTMLDivElement | null>,
  mobile: boolean,
) {
  useEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!mobile || !shell || !viewport) return;
    let frame = 0;
    function reset() {
      shell!.removeAttribute('data-mobile-input-focused');
      shell!.style.removeProperty('--input-viewport-height');
      shell!.style.removeProperty('--input-viewport-top');
    }
    function measure() {
      const editor = document.activeElement;
      // Leave pinch zoom and other editors to the browser.
      if (
        viewport!.scale !== 1 ||
        !(editor instanceof HTMLTextAreaElement) ||
        !editor.closest('.composer-box') ||
        !shell!.contains(editor)
      ) {
        reset();
        return;
      }
      shell!.style.setProperty('--input-viewport-height', `${viewport!.height}px`);
      shell!.style.setProperty('--input-viewport-top', `${viewport!.offsetTop}px`);
      shell!.setAttribute('data-mobile-input-focused', 'true');
      // On very short landscape screens the composer itself may need to scroll.
      // Keep its final action row reachable even with attachments or notices.
      const bottom = editor.closest<HTMLElement>('.bottom-region');
      if (bottom) bottom.scrollTop = bottom.scrollHeight;
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      reset();
    };
  }, [shellRef, mobile]);
}
