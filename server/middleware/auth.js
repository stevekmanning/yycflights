import { verifyToken } from '@clerk/backend';

export async function requireAuth(req, res, next) {
  // Dev mode: no Clerk keys configured
  if (!process.env.CLERK_SECRET_KEY) {
    req.userId = 'dev-user';
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Admin gate — protects expensive endpoints (explore sweep, mass email)
 * from casual users. Must be mounted AFTER requireAuth.
 *
 * Set ADMIN_USER_IDS in .env to a comma-separated list of Clerk user IDs.
 * In dev mode (no CLERK_SECRET_KEY) this always passes — assume the operator.
 */
export function requireAdmin(req, res, next) {
  if (!process.env.CLERK_SECRET_KEY) return next();
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.length) {
    // Fail closed when no admins are configured — don't let anyone sweep.
    return res.status(403).json({ error: 'Admin endpoint not configured (set ADMIN_USER_IDS)' });
  }
  if (!adminIds.includes(req.userId)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}
