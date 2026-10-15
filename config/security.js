const crypto = require('crypto');

function rateLimiter(options = {}) {
    const max = options.max || 15;
    const windowMs = options.windowMs || 15 * 60 * 1000;
    const hits = new Map();

    const interval = setInterval(() => {
        const now = Date.now();
        for (const [ip, data] of hits.entries()) {
            if (now > data.resetTime) {
                hits.delete(ip);
            }
        }
    }, 5 * 60 * 1000);
    interval.unref();

    return (req, res, next) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let data = hits.get(ip);
        if (!data || now > data.resetTime) {
            data = { count: 1, resetTime: now + windowMs };
            hits.set(ip, data);
            return next();
        }

        data.count += 1;
        if (data.count > max) {
            const retrySecs = Math.ceil((data.resetTime - now) / 1000);
            res.set('Retry-After', String(retrySecs));
            if ((req.headers.accept || '').includes('application/json')) {
                return res.status(429).json({ error: 'Too many requests. Please try again later.' });
            }
            return res.status(429).send('Too many requests. Please try again later.');
        }

        return next();
    };
}

function csrfTokenInjector(req, res, next) {
    if (!req.session) return next();
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
    next();
}

function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    const sessionToken = req.session ? req.session.csrfToken : null;
    if (!sessionToken) {
        if ((req.headers.accept || '').includes('application/json')) {
            return res.status(403).json({ error: 'CSRF token missing from session.' });
        }
        return res.status(403).send('CSRF token missing from session.');
    }

    const providedToken = (req.body && req.body._csrf) ||
                          req.headers['x-csrf-token'] ||
                          req.headers['csrf-token'];

    if (!providedToken || providedToken !== sessionToken) {
        if ((req.headers.accept || '').includes('application/json')) {
            return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
        }
        return res.status(403).send('Invalid or missing CSRF token.');
    }

    return next();
}

module.exports = {
    rateLimiter,
    csrfTokenInjector,
    csrfProtection
};

