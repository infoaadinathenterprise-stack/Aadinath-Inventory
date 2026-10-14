'use client';

import ReactDOM from 'react-dom';

// Opens the connection to Supabase (DNS + TCP + TLS to the project's region)
// while the page's code is still downloading, instead of when the first
// query runs. A fresh connection costs ~1.5 s from Kenya, which every page
// otherwise pays before its data can arrive. crossOrigin matches the
// credential-less fetches supabase-js makes, so the browser reuses it.
export default function PreconnectSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (url) {
    ReactDOM.preconnect(url, { crossOrigin: 'anonymous' });
    ReactDOM.prefetchDNS(url);
  }
  return null;
}
