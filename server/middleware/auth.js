const jwt = require('jsonwebtoken');

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

const authMiddleware = (req, res, next) => {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      console.error('JWT_SECRET is missing or too weak');
      return res.status(500).json({ error: 'Authentication is not configured securely' });
    }

    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    req.user = jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (!req.user || !['admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

// Camera/ALPR services use a separate secret so a camera does not need a user JWT.
const alprAuthMiddleware = (req, res, next) => {
  const serviceToken = process.env.ALPR_INTERNAL_TOKEN;
  const supplied = req.headers['x-alpr-token'];

  if (serviceToken && supplied && supplied === serviceToken) {
    req.isInternalAlpr = true;
    return next();
  }

  return authMiddleware(req, res, next);
};

module.exports = { authMiddleware, adminMiddleware, alprAuthMiddleware };
