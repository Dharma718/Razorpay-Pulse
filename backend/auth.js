/**
 * Lightweight authentication — deliberately minimal, per the project's own
 * design philosophy: the login is a "front door," not a feature in itself.
 *
 * - Password hashing uses Node's built-in crypto.scrypt (salted, timing-safe
 *   comparison) rather than pulling in bcrypt — one fewer dependency for
 *   something Node already does well.
 * - Sessions are JWTs in an httpOnly cookie. No database — just a small
 *   owner-credentials.json file (gitignored) created once via first-run setup.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const CREDENTIALS_FILE = path.join(__dirname, 'owner-credentials.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set in .env — using a random secret for this run. Sessions will not survive a server restart. Set SESSION_SECRET in .env for persistent sessions.');
}

const OWNER_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEMO_SESSION_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours — demo sessions are intentionally short-lived

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isOwnerConfigured() {
  return fs.existsSync(CREDENTIALS_FILE);
}

function loadOwnerCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
}

function saveOwnerCredentials(name, email, password) {
  const data = { name, email, passwordHash: hashPassword(password), createdAt: Date.now() };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2));
  return data;
}

function issueSessionCookie(res, { email, name, role }) {
  const maxAge = role === 'demo' ? DEMO_SESSION_MAX_AGE : OWNER_SESSION_MAX_AGE;
  const token = jwt.sign({ email, name, role }, SESSION_SECRET, { expiresIn: Math.floor(maxAge / 1000) });
  res.cookie('pulse_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge,
    // secure:true would require HTTPS — fine to add once deployed behind TLS (e.g. Render sets this up for you)
  });
}

function clearSessionCookie(res) {
  res.clearCookie('pulse_session');
}

/** Express middleware: rejects unauthenticated API requests with 401 JSON. */
function requireAuth(req, res, next) {
  const token = req.cookies?.pulse_session;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

module.exports = {
  hashPassword, verifyPassword, isOwnerConfigured, loadOwnerCredentials, saveOwnerCredentials,
  issueSessionCookie, clearSessionCookie, requireAuth,
};
