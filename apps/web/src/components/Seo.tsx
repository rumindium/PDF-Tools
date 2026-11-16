import { useEffect } from 'react';
import {
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SITE_LOCALE,
  SITE_NAME,
  type SeoMeta,
  TWITTER_CARD,
} from '../lib/seo';

/**
 * Applies one page's head tags at runtime (the SPA has a single
 * `index.html`, so crawlers that execute JS and every user navigation
 * both need the tags updated per route).
 *
 * Idempotent: tags are created once and updated in place, JSON-LD blocks
 * are replaced per page so stale tool schemas never linger.
 */
export function Seo({ meta }: { meta: SeoMeta }) {
  useEffect(() => {
    document.title = meta.title;
    setMeta('name', 'description', meta.description);
    setMeta('name', 'robots', meta.robots);
    if (meta.keywords) setMeta('name', 'keywords', meta.keywords);
    setLink('canonical', meta.canonical);

    setMeta('property', 'og:type', meta.ogType);
    setMeta('property', 'og:site_name', SITE_NAME);
    setMeta('property', 'og:locale', SITE_LOCALE);
    setMeta('property', 'og:title', meta.title);
    setMeta('property', 'og:description', meta.description);
    setMeta('property', 'og:url', meta.canonical);
    setMeta('property', 'og:image', meta.ogImage);
    setMeta('property', 'og:image:width', OG_IMAGE_WIDTH);
    setMeta('property', 'og:image:height', OG_IMAGE_HEIGHT);
    setMeta('property', 'og:image:alt', OG_IMAGE_ALT);
    setMeta('name', 'twitter:card', TWITTER_CARD);
    setMeta('name', 'twitter:image:alt', OG_IMAGE_ALT);
    setMeta('name', 'twitter:title', meta.title);
    setMeta('name', 'twitter:description', meta.description);
    setMeta('name', 'twitter:image', meta.ogImage);

    applyJsonLd(meta.jsonLd ?? []);
  }, [meta]);

  return null;
}

function setMeta(attr: 'name' | 'property', key: string, content: string): void {
  const selector = `meta[${attr}="${key}"]`;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

function applyJsonLd(blocks: Record<string, unknown>[]): void {
  for (const el of Array.from(document.head.querySelectorAll('script[data-seo-jsonld]'))) {
    el.remove();
  }
  for (const block of blocks) {
    const el = document.createElement('script');
    el.setAttribute('type', 'application/ld+json');
    el.setAttribute('data-seo-jsonld', '1');
    el.textContent = JSON.stringify(block);
    document.head.appendChild(el);
  }
}
