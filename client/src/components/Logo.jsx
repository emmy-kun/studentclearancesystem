import brand from '../brand.js';

/** The system logo: the image from brand.js, or a plain mortarboard mark if none is set. */
export default function Logo() {
  if (brand.logo) return <img src={brand.logo} alt="" />;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="logo-mark">
      <path d="M2.5 9.5L12 5l9.5 4.5L12 14z" fill="currentColor" fillOpacity=".15" />
      <path d="M6.5 11.6v4.2c0 1.3 2.5 2.7 5.5 2.7s5.5-1.4 5.5-2.7v-4.2" />
      <path d="M21.5 9.5v5" />
    </svg>
  );
}
