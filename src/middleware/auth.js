const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user || !user.isActive) return res.status(401).json({ message: 'Unauthorized' });
    req.user = user;
    next();
  } catch (_) { return res.status(401).json({ message: 'Unauthorized' }); }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ message: 'Admin only' });
  next();
}
module.exports = { auth, adminOnly };
