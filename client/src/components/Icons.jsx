// Small inline icon set (stroke icons, 24px grid).
const base = (size) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true });

export const CheckCircle = ({ size = 22 }) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9.5" /><path d="M8 12.3l2.7 2.7L16.2 9.5" /></svg>
);
export const Check = ({ size = 18 }) => (
  <svg {...base(size)} strokeWidth={2.6}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const Lock = ({ size = 16 }) => (
  <svg {...base(size)}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
export const Bell = ({ size = 20 }) => (
  <svg {...base(size)}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);
export const Back = ({ size = 20 }) => (
  <svg {...base(size)}><path d="M15 5l-7 7 7 7" /></svg>
);
export const Camera = ({ size = 18 }) => (
  <svg {...base(size)}><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
export const Card = ({ size = 18 }) => (
  <svg {...base(size)}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h4" /></svg>
);
export const Alert = ({ size = 18 }) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9.5" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>
);
export const Warning = ({ size = 18 }) => (
  <svg {...base(size)}><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5M12 17.5v.01" /></svg>
);
export const FileIcon = ({ size = 26 }) => (
  <svg {...base(size)}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /><path d="M9.5 14h5M9.5 17h5" /></svg>
);
export const Download = ({ size = 18 }) => (
  <svg {...base(size)}><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" /></svg>
);
export const Mail = ({ size = 18 }) => (
  <svg {...base(size)}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></svg>
);
export const IdCard = ({ size = 18 }) => (
  <svg {...base(size)}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="11" r="2" /><path d="M5.5 16c.6-1.4 1.7-2 3-2s2.4.6 3 2M14 10h4M14 13.5h3" /></svg>
);
export const User = ({ size = 18 }) => (
  <svg {...base(size)}><circle cx="12" cy="8" r="4" /><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></svg>
);
export const Eye = ({ size = 18 }) => (
  <svg {...base(size)}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const EyeOff = ({ size = 18 }) => (
  <svg {...base(size)}><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
);
export const Shield = ({ size = 18 }) => (
  <svg {...base(size)}><path d="M12 3l8 3v6c0 4.6-3.4 8.2-8 9-4.6-.8-8-4.4-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>
);
export const Close = ({ size = 20 }) => (
  <svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const Menu = ({ size = 22 }) => (
  <svg {...base(size)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const UserPlus = ({ size = 18 }) => (
  <svg {...base(size)}><circle cx="10" cy="8" r="3.5" /><path d="M3.5 19.5a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></svg>
);
export const Key = ({ size = 16 }) => (
  <svg {...base(size)}><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2" /></svg>
);
