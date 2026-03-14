// Bruges som: router.get('/beskyttet', requireAuth(), handler)
// Eller:      router.get('/admin', requireAuth('admin'), handler)

function requireAuth(role = null) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Ikke logget ind' });
    }
    if (role && req.session.userRole !== role && req.session.userRole !== 'admin') {
      return res.status(403).json({ error: 'Ingen adgang' });
    }
    next();
  };
}

module.exports = { requireAuth };
