// Every /admin page (login, staff and admin screens) renders inside the
// light "white background" theme. See `.theme-light` in globals.css.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="theme-light min-h-screen text-slate-100">{children}</div>;
}
