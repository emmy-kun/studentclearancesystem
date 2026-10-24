// Name and logo printed on certificates, slips, letters, reports and emails.
// The logo is optional: put a PNG at server/assets/logo.png and it is used automatically.
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_DIR } from './env.js';

const logoPath = path.join(SERVER_DIR, 'assets', 'logo.png');

export default {
  name: 'Automated Student Clearance System',
  shortName: 'Student Clearance System',
  // Optional institution name for addresses on letters (INSTITUTION_NAME in .env); left out when blank.
  institution: (process.env.INSTITUTION_NAME || '').trim(),
  logo: () => (fs.existsSync(logoPath) ? logoPath : null),
};
