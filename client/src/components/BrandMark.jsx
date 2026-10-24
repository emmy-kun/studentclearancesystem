import Logo from './Logo.jsx';

/** The logo in a small white badge, used beside "Student Clearance" in the green headers. */
export default function BrandMark() {
  return (
    <span className="brand-logo" aria-hidden="true">
      <Logo />
    </span>
  );
}
