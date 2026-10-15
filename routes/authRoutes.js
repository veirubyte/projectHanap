const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/db');
const {
    CSPC_INSTITUTIONAL_DOMAINS,
    isValidEmailSyntax,
    isInstitutionalEmail,
    validatePasswordStrength,
    isAdmin,
    isStudent,
    isGuest
} = require('../config/roles');

const router = express.Router();

/**
 * Helper to render the login view with consistent alert state.
 */
function renderLogin(res, options = {}) {
    return res.status(options.status || 200).render('login', {
        category: options.category || 'institution',
        errorTitle: options.errorTitle || null,
        errorMessage: options.errorMessage || null,
        errorType: options.errorType || null,
        action: options.action || null,
        invalidFields: options.invalidFields || [],
        email: options.email || '',
        msg: options.msg || null
    });
}

/**
 * Helper to render the register view with consistent alert state.
 */
function renderRegister(res, options = {}) {
    return res.status(options.status || 200).render('register', {
        category: options.category || 'institution',
        errorTitle: options.errorTitle || null,
        errorMessage: options.errorMessage || null,
        errorType: options.errorType || null,
        action: options.action || null,
        invalidFields: options.invalidFields || [],
        values: options.values || {},
        success: options.success || null
    });
}

// GET /login
router.get('/login', (req, res) => {
    // If already authenticated, redirect immediately based on authoritative database role
    if (req.session.user) {
        if (isAdmin(req.session.user)) {
            return res.redirect('/admin/dashboard');
        }
        return res.redirect('/dashboard');
    }

    const category = req.query.category === 'guest' ? 'guest' : 'institution';
    const email = typeof req.query.registered_email === 'string' ? req.query.registered_email : (req.query.email || '');
    const msg = typeof req.query.msg === 'string' ? req.query.msg : null;

    return renderLogin(res, {
        category,
        email,
        msg,
        status: 200
    });
});

// POST /login
router.post('/login', async (req, res) => {
    const rawCategory = typeof req.body.category === 'string' ? req.body.category.trim().toLowerCase() : 'institution';
    const category = rawCategory === 'guest' ? 'guest' : 'institution';
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const cleanEmail = email.toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    const invalidFields = [];
    const missingErrors = [];

    // 1. Strict required fields validation
    if (!email) {
        invalidFields.push('email');
        missingErrors.push('Please enter your email address.');
    }
    if (!password) {
        invalidFields.push('password');
        missingErrors.push('Please enter your password.');
    }

    if (missingErrors.length > 0) {
        return renderLogin(res, {
            category,
            email,
            invalidFields,
            errorTitle: 'Complete the required information',
            errorMessage: missingErrors.join('\n'),
            errorType: 'missing_fields',
            status: 400
        });
    }

    // 2. Strict email format validation
    if (!isValidEmailSyntax(cleanEmail)) {
        return renderLogin(res, {
            category,
            email,
            invalidFields: ['email'],
            errorTitle: 'Invalid email format',
            errorMessage: 'Please enter a valid email address.',
            errorType: 'invalid_format',
            status: 400
        });
    }

    // 3. Category-specific domain validation
    if (category === 'institution') {
        if (!isInstitutionalEmail(cleanEmail)) {
            return renderLogin(res, {
                category: 'institution',
                email,
                invalidFields: ['email'],
                errorTitle: 'Institutional account required',
                errorMessage: 'The email you entered is not a recognized CSPC institutional email.\nIf you are a parent, guardian, or external guest, please select "Guest" to continue.',
                errorType: 'institutional_domain_required',
                action: 'switch_to_guest',
                status: 400
            });
        }
    }

    try {
        // 4. Query user from database
        const [rows] = await db.execute(
            `SELECT id, full_name, email, password_hash, role 
             FROM users 
             WHERE email = ?`,
            [cleanEmail]
        );

        // Account does not exist
        if (rows.length === 0) {
            if (category === 'institution') {
                return renderLogin(res, {
                    category: 'institution',
                    email,
                    invalidFields: ['email'],
                    errorTitle: 'Account not found',
                    errorMessage: 'This CSPC institutional email is valid, but no registered HANAP account was found.\nPlease register first or contact the appropriate administrator.',
                    errorType: 'account_not_found',
                    action: 'register',
                    status: 404
                });
            } else {
                return renderLogin(res, {
                    category: 'guest',
                    email,
                    invalidFields: ['email', 'password'],
                    errorTitle: 'Unable to sign in',
                    errorMessage: 'The email or password is incorrect.\nPlease check your credentials and try again.',
                    errorType: 'invalid_credentials',
                    status: 401
                });
            }
        }

        const userRecord = rows[0];

        // 5. Verify password hash using bcrypt
        const passwordMatches = await bcrypt.compare(password, userRecord.password_hash);
        if (!passwordMatches) {
            return renderLogin(res, {
                category,
                email,
                invalidFields: ['password'],
                errorTitle: 'Unable to sign in',
                errorMessage: 'The email or password is incorrect.\nPlease check your credentials and try again.',
                errorType: 'invalid_credentials',
                status: 401
            });
        }

        // 6. Cross-category validation against database role
        // Case A: User selected Guest, but account has institutional role ('student/staff' or 'admin')
        if (category === 'guest' && (userRecord.role === 'student/staff' || userRecord.role === 'admin')) {
            return renderLogin(res, {
                category: 'guest',
                email,
                invalidFields: ['email'],
                errorTitle: 'Institution account detected',
                errorMessage: 'This account belongs to the CSPC institutional community.\nPlease select "Institution" to sign in.',
                errorType: 'institution_account_detected',
                action: 'switch_to_institution',
                status: 403
            });
        }

        // Case B: User selected Institution, but account is a guest ('parent/guest')
        if (category === 'institution' && userRecord.role === 'parent/guest') {
            return renderLogin(res, {
                category: 'institution',
                email,
                invalidFields: ['email'],
                errorTitle: 'Institutional account required',
                errorMessage: 'Your email is not a recognized CSPC institutional email. If you are a parent, guardian, or guest, please select Guest.',
                errorType: 'guest_account_detected',
                action: 'switch_to_guest',
                status: 403
            });
        }

        // 7. Session generation and assignment
        const sessionUser = {
            id: userRecord.id,
            email: userRecord.email,
            full_name: userRecord.full_name,
            role: userRecord.role
        };

        await new Promise((resolve, reject) => {
            req.session.regenerate((err) => (err ? reject(err) : resolve()));
        });

        req.session.user = sessionUser;

        await new Promise((resolve, reject) => {
            req.session.save((err) => (err ? reject(err) : resolve()));
        });

        // 8. Authoritative role-based redirection from database
        if (isAdmin(sessionUser)) {
            return res.redirect('/admin/dashboard');
        }
        return res.redirect('/dashboard');
    } catch (error) {
        console.error('Login system error:', error);
        return renderLogin(res, {
            category,
            email,
            errorTitle: 'System error',
            errorMessage: 'Unable to process your sign in at this time. Please try again later.',
            status: 500
        });
    }
});

// GET /register
router.get('/register', (req, res) => {
    if (req.session.user) {
        if (isAdmin(req.session.user)) {
            return res.redirect('/admin/dashboard');
        }
        return res.redirect('/dashboard');
    }

    const category = req.query.category === 'guest' ? 'guest' : 'institution';
    return renderRegister(res, { category });
});

// POST /register
router.post('/register', async (req, res) => {
    const rawCategory = typeof req.body.category === 'string' ? req.body.category.trim().toLowerCase() : 'institution';
    const category = rawCategory === 'guest' ? 'guest' : 'institution';
    const rawFullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
    const rawEmail = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const cleanEmail = rawEmail.toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmPassword = typeof req.body.confirm_password === 'string' ? req.body.confirm_password : '';

    const values = {
        full_name: rawFullName,
        email: rawEmail
    };

    const invalidFields = [];
    const missingErrors = [];

    // 1. Required fields check
    if (!rawFullName) {
        invalidFields.push('full_name');
        missingErrors.push('Please enter your full name.');
    }
    if (!cleanEmail) {
        invalidFields.push('email');
        missingErrors.push('Please enter your email.');
    }
    if (!password) {
        invalidFields.push('password');
        missingErrors.push('Please create a strong password.');
    }
    if (!confirmPassword) {
        invalidFields.push('confirm_password');
        missingErrors.push('Please confirm your password.');
    }

    if (missingErrors.length > 0) {
        return renderRegister(res, {
            category,
            values,
            invalidFields,
            errorTitle: 'Complete the required information',
            errorMessage: missingErrors.map((e) => `• ${e}`).join('\n'),
            errorType: 'missing_fields',
            status: 400
        });
    }

    // 2. Full Name length validation
    if (rawFullName.length > 150) {
        return renderRegister(res, {
            category,
            values,
            invalidFields: ['full_name'],
            errorTitle: 'Name too long',
            errorMessage: 'Full name must not exceed 150 characters.',
            status: 400
        });
    }

    // 3. Email syntax validation
    if (!isValidEmailSyntax(cleanEmail)) {
        return renderRegister(res, {
            category,
            values,
            invalidFields: ['email'],
            errorTitle: 'Invalid email format',
            errorMessage: 'Please enter a valid email address.',
            status: 400
        });
    }

    // 4. Institutional domain validation if category is Institution
    if (category === 'institution') {
        if (!isInstitutionalEmail(cleanEmail)) {
            return renderRegister(res, {
                category: 'institution',
                values,
                invalidFields: ['email'],
                errorTitle: 'Institutional email required',
                errorMessage: 'Institution registration requires an official @my.cspc.edu.ph or @cspc.edu.ph email address.\nIf you are a parent or guest, please switch to the Guest registration tab.',
                errorType: 'institutional_domain_required',
                action: 'switch_to_guest',
                status: 400
            });
        }
    }

    // 5. Password strength validation (all 3 segments required)
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
        return renderRegister(res, {
            category,
            values,
            invalidFields: ['password'],
            errorTitle: 'Password does not meet requirements',
            errorMessage: 'Please create a strong password containing:\n• Minimum 8 characters\n• At least one uppercase letter\n• At least one lowercase letter\n• At least one number\n• At least one special character',
            errorType: 'weak_password',
            status: 400
        });
    }

    // 6. Password match validation
    if (password !== confirmPassword) {
        return renderRegister(res, {
            category,
            values,
            invalidFields: ['confirm_password'],
            errorTitle: 'Passwords do not match',
            errorMessage: 'Please enter the same password in both fields.',
            errorType: 'mismatched_password',
            status: 400
        });
    }

    // 7. Duplicate email verification
    try {
        const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [cleanEmail]);
        if (existing.length > 0) {
            return renderRegister(res, {
                category,
                values,
                invalidFields: ['email'],
                errorTitle: 'Account already exists',
                errorMessage: 'An account with this email already exists. Please sign in instead.',
                errorType: 'duplicate_email',
                action: 'sign_in',
                status: 409
            });
        }

        // 8. Server-side role assignment
        // Normal institutional registration -> 'student/staff'
        // Guest registration -> 'parent/guest'
        // Admin role is NEVER self-assignable through public registration
        const assignedRole = category === 'institution' ? 'student/staff' : 'parent/guest';

        const passwordHash = await bcrypt.hash(password, 10);
        await db.execute(
            `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
            [rawFullName, cleanEmail, passwordHash, assignedRole]
        );

        // 9. Redirect to login with explicit success parameters
        const successMsg = 'Your HANAP account has been created. You can now sign in using your registered credentials.';
        return res.redirect(`/login?msg=${encodeURIComponent(successMsg)}&registered_email=${encodeURIComponent(cleanEmail)}&category=${category}`);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return renderRegister(res, {
                category,
                values,
                invalidFields: ['email'],
                errorTitle: 'Account already exists',
                errorMessage: 'An account with this email already exists. Please sign in instead.',
                errorType: 'duplicate_email',
                action: 'sign_in',
                status: 409
            });
        }
        console.error('Registration database error:', error);
        return renderRegister(res, {
            category,
            values,
            errorTitle: 'Registration error',
            errorMessage: 'Unable to complete registration at this time. Please try again.',
            status: 500
        });
    }
});

// GET /logout
router.get('/logout', (req, res, next) => {
    req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie('connect.sid');
        return res.redirect('/login');
    });
});

module.exports = router;
