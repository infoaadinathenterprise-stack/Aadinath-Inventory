import { COMPANY } from '@/lib/company';

// Company letterhead for printed pages. Inline styles so it prints the
// same regardless of the app's dark theme.
export default function CompanyLetterhead() {
  return (
    <div style={{ textAlign: 'center', fontFamily: 'Arial, sans-serif', color: '#111', borderBottom: '2px solid #111', paddingBottom: '8px', marginBottom: '12px' }}>
      <p style={{ fontSize: '18px', fontWeight: 'bold', margin: 0, letterSpacing: '0.5px' }}>{COMPANY.name}</p>
      <p style={{ fontSize: '11px', margin: '3px 0 0' }}>{COMPANY.address}</p>
      <p style={{ fontSize: '11px', margin: '2px 0 0' }}>{COMPANY.contact}</p>
      <p style={{ fontSize: '10px', fontStyle: 'italic', color: '#333', margin: '4px 0 0', lineHeight: 1.35 }}>{COMPANY.dealers}</p>
    </div>
  );
}
