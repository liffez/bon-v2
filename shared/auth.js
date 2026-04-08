// Bruges som: router.get('/beskyttet', requireAuth(), handler)
// Eller:      router.get('/admin', requireAuth('admin'), handler)
// Eller:      router.get('/mixed', requireAuth('office', 'kitchen'), handler)

function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Ikke logget ind' });
    }
    if (roles.length === 0) return next();
    const userRole = req.session.userRole;
    if (userRole === 'admin') return next();
    if (!roles.includes(userRole)) {
      return res.status(403).json({ error: 'Ingen adgang' });
    }
    next();
  };
}

module.exports = { requireAuth };
