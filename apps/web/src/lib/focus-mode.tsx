import { type ReactNode, createContext, useContext } from 'react';

/**
 * Full-screen editing: one boolean, owned by the shell and switched by the canvas.
 *
 * A canvas that is asked to be full screen is asking the *shell* for something — hide the navigation, and put its own
 * handle back into the header — and the shell is two components above it in the tree. The two alternatives were both
 * worse: a route parameter would make the mode part of the URL (a link somebody could send that lands on a page with no
 * navigation), and lifting the canvas's own state into the page would mean the tool page knowing which of its option
 * fields is a placement canvas. One context, read at both ends, is the smallest thing that says what it means.
 *
 * The shell also reads the same state directly, because it is where the state lives (`RootLayout`); this exists for the
 * **routes**, which are the callers that cannot see it. The provider therefore wraps `<Outlet />` alone, and the value's
 * identity changes only when the boolean does.
 */
export interface FocusMode {
  /** Whether the canvas has taken the screen: the sidebar is a drawer and the header carries its handle. */
  fullscreen: boolean;
  setFullscreen: (next: boolean) => void;
  /** Whether the sidebar is auto-hidden (e.g. during placement canvas render). */
  sidebarHidden: boolean;
  setSidebarHidden: (next: boolean) => void;
}

/** Closed, and the setter does nothing: a canvas rendered outside the shell (a unit test) is not full screen. */
const FocusModeContext = createContext<FocusMode>({
  fullscreen: false,
  setFullscreen: () => {},
  sidebarHidden: false,
  setSidebarHidden: () => {},
});

export function FocusModeProvider({ value, children }: { value: FocusMode; children: ReactNode }) {
  return <FocusModeContext.Provider value={value}>{children}</FocusModeContext.Provider>;
}

export function useFocusMode(): FocusMode {
  return useContext(FocusModeContext);
}
