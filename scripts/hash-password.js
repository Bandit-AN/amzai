import { hashStudentPassword } from '../lib/platform.js';

const password = process.env.STUDENT_PASSWORD;
if (!password) {
  console.error('Set STUDENT_PASSWORD temporarily, then run this command again.');
  process.exit(1);
}
console.log(await hashStudentPassword(password));
