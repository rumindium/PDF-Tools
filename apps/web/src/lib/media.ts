import { useEffect, useState } from 'react';

/**
 * Whether a media query currently matches, and a subscription to the changes.
 *
 * The app's layout is CSS's business and this does not change that — nothing here sets a width or a padding. It exists
 * for the two cases where a *behaviour* has to agree with the stylesheet rather than merely be styled by it:
 *
 *  - the drawer: below 1024px the sidebar is off-canvas, and the shell's own rules key on one attribute
 *    (`.shell[data-drawer="true"]`) rather than on a media query, so the same drawer serves a narrow window and
 *    fullscreen editing on a wide one. One attribute, one set of rules, and this hook is what sets it;
 *  - the sticky run bar (`routes/tools.$toolId.tsx`), which *replaces* the in-card button rather than decorating it —
 *    two `Run …` buttons in the accessibility tree would be two answers to one question.
 *
 * A JS width listener is the price of the first one, and it is a small one: `matchMedia` fires on crossings only, so a
 * drag across the whole desktop re-renders this app twice. The alternative was writing the drawer's rules out once for
 * the media query and once for fullscreen mode, which is two places for one behaviour to drift apart.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    // Read once on mount as well as on every change: the initial state was read during the first render, and a query
    // that changed between that render and this effect would otherwise be missed until the next crossing.
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
