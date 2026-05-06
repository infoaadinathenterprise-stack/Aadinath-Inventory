import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import NavbarConditional from './components/NavbarConditional';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Aadinath Enterprises — Auto Parts & Consumables',
  description: 'Premium auto parts and consumables distributor. Oils, batteries, bearings and more.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-navy text-slate-100 antialiased font-[var(--font-inter)]">
        <NavbarConditional />
        {children}
      </body>
    </html>
  );
}
