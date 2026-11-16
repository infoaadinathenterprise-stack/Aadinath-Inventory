import type { Metadata, Viewport } from 'next';
import { Inter, Plus_Jakarta_Sans, Manrope } from 'next/font/google';
import './globals.css';
import NavbarConditional from './components/NavbarConditional';
import PreconnectSupabase from './components/PreconnectSupabase';
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from '@/lib/seo';

const inter   = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', weight: ['500', '600', '700', '800'] });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', weight: ['400', '500', '600', '700', '800'] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — Diesel Engines, Posho Mills, Generators & Power Tools, Kakamega`,
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'Jay Aadinath Enterprises', 'Jay Aadinath Enterprises Ltd', 'posho mill Kenya',
    'diesel engine Kakamega', 'generators Kenya', 'water pumps Kenya', 'submersible pumps',
    'power tools Kenya', 'maize sheller', 'solar panels Kenya', 'inverter', 'bearings',
    'V-belts', 'Honda engine', 'Kakamega wholesale machinery',
  ],
  alternates: { canonical: '/' },
  robots: {
    index: true, follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — Diesel Engines, Posho Mills, Generators & Power Tools`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_KE',
  },
  twitter: {
    card: 'summary',
    title: `${SITE_NAME} — Diesel Engines, Posho Mills & Power Equipment, Kakamega`,
    description: SITE_DESCRIPTION,
  },
  // Paste the token from Google Search Console (or set NEXT_PUBLIC_GSC_VERIFICATION).
  verification: process.env.NEXT_PUBLIC_GSC_VERIFICATION
    ? { google: process.env.NEXT_PUBLIC_GSC_VERIFICATION }
    : undefined,
};

export const viewport: Viewport = {
  themeColor: '#0b1120',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable} ${manrope.variable}`}>
      <body className="antialiased font-[var(--font-manrope)]">
        <div className="theme-light min-h-screen bg-navy text-slate-100">
          <PreconnectSupabase />
          <NavbarConditional />
          {children}
        </div>
      </body>
    </html>
  );
}
