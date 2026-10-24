// The active student auth provider. Each provider exports authenticate(body)
// returning the student record or null. Alternatives kept for reference:
//   localRecordProvider.js: four-field match (matric, email, name, department)
//   uniSsoProvider.js:      future university single sign-on
export * as studentAuthProvider from './passwordProvider.js';
