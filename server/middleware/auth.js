import { createClerkClient } from '@clerk/backend';

let _clerk;
function getClerk() {
  if (!_clerk) _clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  return _clerk;
}

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
    const payload = await getClerk().verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
