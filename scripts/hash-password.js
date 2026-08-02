import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

const password = process.env.STUDENT_PASSWORD;
if (!password) {
  console.error('Set STUDENT_PASSWORD temporarily, then run this command again.');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Student passwords must be at least 10 characters.');
  process.exit(1);
}
const iterations = 210000;
const salt = randomBytes(16).toString('hex');
const derived = await pbkdf2Async(password, salt, iterations, 32, 'sha256');
console.log(`pbkdf2$${iterations}$${salt}$${derived.toString('hex')}`);
