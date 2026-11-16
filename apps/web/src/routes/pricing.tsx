import { Link } from 'react-router';
import { Seo } from '../components/Seo';
import { Container, PageTitle } from '../components/layout';
import { Card } from '../components/ui';
import { pricingSeo } from '../lib/seo';

/**
 * The legacy `/pricing` URL (`main.tsx`).
 *
 * The app has no plans and no paywall, so a silent redirect to `/tools` would turn an externally linked URL into
 * a page that means something else — a backlink to a redirect that changes meaning leaks equity. This page keeps
 * the URL answering 200 with the one pricing fact there is: everything is free.
 */
export function PricingRoute() {
  return (
    <>
      <Seo meta={pricingSeo()} />
      <Container>
        <div className="page stack">
          <PageTitle title="Pricing" description="There isn't any — every tool is free." />
          <Card className="card-pad">
            <div className="stack-sm">
              <p className="strong" style={{ margin: 0 }}>
                Every tool is free, with no signup and no watermark.
              </p>
              <p className="small muted" style={{ margin: 0 }}>
                Signed-in users get unlimited jobs; anonymous use is 15 jobs a day. There are no plans to compare and no
                paywall to hit — pick a tool and run it.
              </p>
              <div className="row">
                <Link className="btn btn-primary btn-sm" to="/tools">
                  Browse all tools
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </Container>
    </>
  );
}
