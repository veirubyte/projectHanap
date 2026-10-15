const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');

require('dotenv').config({ path: path.join(__dirname, '.env') });

if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set in the environment or .env file.');
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}

const { rateLimiter, csrfTokenInjector, csrfProtection } = require('./config/security');

const app = express();

// Security headers with CSP tailored for Tailwind CDN and Google Fonts
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            connectSrc: ["'self'"]
        }
    }
}));

// Body parsers and static files
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

// Make user and CSRF token available across all views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// CSRF token injector
app.use(csrfTokenInjector);

// Global CSRF check with auth exemptions
const CSRF_EXEMPT = new Set(['/login', '/register', '/logout']);
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (CSRF_EXEMPT.has(req.path)) return next();
    return csrfProtection(req, res, next);
});

// Rate limiters on auth endpoints
const loginLimiter = rateLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
const registerLimiter = rateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
app.post('/login', loginLimiter);
app.post('/register', registerLimiter);

// Landing page route
app.get('/', (req, res) => {
    res.render('landing', { user: req.session.user || null });
});

// Auth & Item routes
app.use('/', require('./routes/authRoutes'));
app.use('/', require('./routes/itemRoutes'));

if (require.main === module) {
    app.listen(port, () => {
        console.log(`HANAP Server running on http://localhost:${port}`);
    });

    // Daily background job: archives item reports active for more than 60 days
    const { flagStaleItems } = require('./services/lifecycle');
    setInterval(() => {
        flagStaleItems().catch((e) => console.error('Lifecycle job error:', e));
    }, 24 * 60 * 60 * 1000);
}

module.exports = app;