import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { ErrorBoundary } from './app/error-boundary';
import { AppProvider } from './app/providers';
import { RootLayout } from './app/root-layout';
import { Seo } from './components/Seo';
import { Card, EmptyState, Skeleton } from './components/ui';
import { noIndexSeo } from './lib/seo';
import { watchForNewBuild } from './lib/stale-bundle';
import './styles/globals.css';

/**
 * Router + providers (`docs/0-FOLDER-STRUCTURE.md` §3).
 *
 * Every route below the shell is lazy: the tool page pulls in the option renderer, the job page pulls in the SSE
 * client, and neither is in the bundle for someone who only opens the catalog. A single route file per screen is
 * deliberate — a tool screen is driven by the catalog, so there is exactly one of them no matter how many tools
 * the registry grows to.
 */
const HomeRoute = lazy(() => import('./routes/home').then((module) => ({ default: module.HomeRoute })));
const ToolsIndexRoute = lazy(() =>
  import('./routes/tools.index').then((module) => ({ default: module.ToolsIndexRoute })),
);
const ToolRoute = lazy(() => import('./routes/tools.$toolId').then((module) => ({ default: module.ToolRoute })));
const JobsIndexRoute = lazy(() => import('./routes/jobs.index').then((module) => ({ default: module.JobsIndexRoute })));
const JobRoute = lazy(() => import('./routes/jobs.$jobId').then((module) => ({ default: module.JobRoute })));
const AccountRoute = lazy(() => import('./routes/account.index').then((module) => ({ default: module.AccountRoute })));
const DriveRoute = lazy(() => import('./routes/drive.index').then((module) => ({ default: module.DriveRoute })));
const SsoCallbackRoute = lazy(() =>
  import('./routes/sso.callback').then((module) => ({ default: module.SsoCallbackRoute })),
);
const AdminRoute = lazy(() => import('./routes/admin').then((module) => ({ default: module.AdminRoute })));
const PricingRoute = lazy(() => import('./routes/pricing').then((module) => ({ default: module.PricingRoute })));

function RouteFallback() {
  return (
    <div className="container page stack">
      <Skeleton width="30%" height={22} />
      <Card className="card-pad stack-sm">
        <Skeleton width="70%" />
        <Skeleton width="45%" />
      </Card>
    </div>
  );
}

function NotFound() {
  return (
    <>
      <Seo meta={noIndexSeo('/404', 'Page not found', 'The link may be from an older build.')} />
      <div className="container page">
        <Card>
          <EmptyState
            title="Page not found"
            description="The link may be from an older build. The catalog lists everything this build supports."
          />
        </Card>
      </div>
    </>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: 'tools', element: <ToolsIndexRoute /> },
      { path: 'tools/:toolId', element: <ToolRoute /> },
      { path: 'jobs', element: <JobsIndexRoute /> },
      { path: 'jobs/:jobId', element: <JobRoute /> },
      { path: 'account', element: <AccountRoute /> },
      { path: 'drive', element: <DriveRoute /> },
      // Pricing is a statement, not a redirect: the app is fully free, so the legacy URL answers 200 with the
      // one pricing fact there is rather than turning an externally linked URL into a page that means something
      // else (`routes/pricing.tsx`).
      { path: 'pricing', element: <PricingRoute /> },
      // Registered for everybody because the permission is not knowable at build time: the screen itself asks the API
      // (and the API asks the platform), which is the same check the header's Admin item renders from.
      { path: 'admin', element: <AdminRoute /> },
      // Both spellings land on the same route: `/auth/sso` is the URL the Auth Platform's My apps builds when it
      // opens an app (`<app url>/auth/sso?code=…`), and `/sso/callback` is what this app's own docs and clients
      // already used. One component, so the two can never drift into two behaviours.
      { path: 'auth/sso', element: <SsoCallbackRoute /> },
      { path: 'sso/callback', element: <SsoCallbackRoute /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

// Before the first render, not inside it: a tab that is running an older build should reload **instead of** drawing a
// screen the server no longer serves (`lib/build-id.ts`). This is a fetch against our own origin only when the tab is
// booted or looked at again, so it costs nothing while the tab sits in the background.
watchForNewBuild();

const container = document.getElementById('root');
if (!container) throw new Error('The #root element is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <Suspense fallback={<RouteFallback />}>
          <RouterProvider router={router} />
        </Suspense>
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
);
