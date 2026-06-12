import type { Metadata, Viewport } from 'next';
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import NavbarConditional from './components/NavbarConditional';

const inter   = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', weight: ['500', '600', '700', '800'] });

export const metadata: Metadata = {
  title: 'Jay Aadinath Enterprises LTD — Auto Parts & Consumables',
  description: 'Premium auto parts and consumables distributor. Oils, batteries, bearings and more.',
};

export const viewport: Viewport = {
  themeColor: '#0b1120',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable}`}>
      <body className="bg-navy text-slate-100 antialiased font-[var(--font-inter)]">
        <NavbarConditional />
        {children}
      </body>
    </html>
  );
}
