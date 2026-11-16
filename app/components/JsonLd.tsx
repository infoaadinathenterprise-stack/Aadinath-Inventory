// Site-wide structured data for the storefront home page. Powers Google's
// business/knowledge panel for "Jay Aadinath Enterprises" searches and tells
// search engines who/where the business is. Server component — rendered into
// static HTML at build.

import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, BUSINESS } from '@/lib/seo';

export default function HomeJsonLd() {
  const org = {
    '@context': 'https://schema.org',
    '@type': ['Organization', 'Store', 'AutoPartsStore'],
    '@id': `${SITE_URL}/#organization`,
    name: SITE_NAME,
    legalName: BUSINESS.legalName,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    telephone: BUSINESS.phone,
    email: BUSINESS.email,
    address: {
      '@type': 'PostalAddress',
      streetAddress: BUSINESS.streetAddress,
      postOfficeBoxNumber: BUSINESS.poBox,
      addressLocality: BUSINESS.locality,
      addressRegion: BUSINESS.region,
      postalCode: BUSINESS.postalCode,
      addressCountry: BUSINESS.country,
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: BUSINESS.latitude,
      longitude: BUSINESS.longitude,
    },
    areaServed: { '@type': 'Country', name: 'Kenya' },
  };

  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: SITE_URL,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    publisher: { '@id': `${SITE_URL}/#organization` },
  };

  const json = JSON.stringify([org, website]).replace(/</g, '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
