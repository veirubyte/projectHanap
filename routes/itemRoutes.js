const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const db = require('../config/db');
const { isAdmin, isStudent, isGuest } = require('../config/roles');
const { ANSWER_MATCH_THRESHOLD, calculateAnswerMatch } = require('../services/answerMatch');

const router = express.Router();

// Multer photo upload config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '..', 'public', 'uploads'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, and WebP image formats are supported.'));
        }
    }
});

// Middleware: Require Authenticated User
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.redirect(`/login?msg=${encodeURIComponent('Please sign in to access this feature.')}`);
    }
    next();
}

// Middleware: Require Admin
function requireAdmin(req, res, next) {
    if (!req.session.user || !isAdmin(req.session.user)) {
        return res.status(403).render('login', {
            category: 'institution',
            errorTitle: 'Access Denied',
            errorMessage: 'Administrator privileges are required to access this area.',
            errorType: 'unauthorized',
            msg: null
        });
    }
    next();
}

// Helper: Relative time ago
function timeAgo(d) {
    if (!d) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function removeUploadedFile(file) {
    if (!file) return;
    try {
        await fs.unlink(file.path);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Failed to remove invalid report upload:', err);
    }
}

// Auto-ensure schema columns exist in item_reports
(async () => {
    try {
        const [cols] = await db.execute(`SHOW COLUMNS FROM item_reports`);
        const colNames = cols.map(c => c.Field);
        if (!colNames.includes('secret_challenge')) {
            await db.execute(`ALTER TABLE item_reports ADD COLUMN secret_challenge VARCHAR(500) DEFAULT NULL`);
        }
        if (!colNames.includes('secret_answer')) {
            await db.execute(`ALTER TABLE item_reports ADD COLUMN secret_answer VARCHAR(500) DEFAULT NULL`);
        }
        if (!colNames.includes('custody_mode')) {
            await db.execute(`ALTER TABLE item_reports ADD COLUMN custody_mode ENUM('peer_meetup','security_desk') DEFAULT 'peer_meetup'`);
        }
    } catch (e) {
        console.error('item_reports schema sync:', e.message);
    }
})();

// Helper: Audit Logger
async function logAudit(adminId, actionDescription, ip) {
    try {
        await db.execute(
            `INSERT INTO audit_logs (admin_id, action_description, ip_address) VALUES (?, ?, ?)`,
            [adminId, actionDescription, ip || null]
        );
    } catch (e) {
        console.error('Audit log error:', e);
    }
}

// Standard Categories
const CATEGORIES = [
    'Electronics',
    'Keys & Lanyards',
    'IDs & Cards',
    'Bags & Wallets',
    'Tumblers & Bottles',
    'Books & Documents',
    'Clothing & Accessories',
    'Other'
];

/* ==========================================================================
   PUBLIC & USER FEED / CATALOG
   ========================================================================== */

router.get(['/dashboard', '/catalog'], async (req, res) => {
    const isCatalog = req.path === '/catalog';
    const user = req.session.user || null;

    if (!isCatalog && !user) {
        return res.redirect('/login');
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const typeFilter = ['lost', 'found'].includes(req.query.type) ? req.query.type : '';
    const catFilter = CATEGORIES.includes(req.query.category) ? req.query.category : '';
    const statusFilter = ['active', 'claimed', 'archived', 'pending_review'].includes(req.query.status)
        ? req.query.status
        : (isCatalog ? 'active' : 'active');

    try {
        // Stats
        const [statsRows] = await db.execute(`
            SELECT 
                SUM(CASE WHEN report_type = 'lost' AND status = 'active' THEN 1 ELSE 0 END) AS active_lost,
                SUM(CASE WHEN report_type = 'found' AND status = 'active' THEN 1 ELSE 0 END) AS active_found,
                SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS total_claimed,
                COUNT(*) AS total_reports
            FROM item_reports
        `);
        const stats = {
            active_lost: statsRows[0].active_lost || 0,
            active_found: statsRows[0].active_found || 0,
            total_claimed: statsRows[0].total_claimed || 0,
            total_reports: statsRows[0].total_reports || 0
        };

        // Build item reports query
        let querySql = `
            SELECT r.*, u.full_name AS reporter_name, u.role AS reporter_role
            FROM item_reports r
            JOIN users u ON u.id = r.user_id
            WHERE 1=1
        `;
        const params = [];

        if (statusFilter && statusFilter !== 'all') {
            querySql += ` AND r.status = ?`;
            params.push(statusFilter);
        } else if (isCatalog) {
            querySql += ` AND r.status = 'active'`;
        }

        if (typeFilter) {
            querySql += ` AND r.report_type = ?`;
            params.push(typeFilter);
        }

        if (catFilter) {
            querySql += ` AND r.category = ?`;
            params.push(catFilter);
        }

        if (q) {
            querySql += ` AND (r.item_name LIKE ? OR r.description LIKE ? OR r.location_found_lost LIKE ?)`;
            const wildcard = `%${q}%`;
            params.push(wildcard, wildcard, wildcard);
        }

        querySql += ` ORDER BY r.date_reported DESC LIMIT 100`;

        const [items] = await db.execute(querySql, params);

        // Smart Matches (if user is logged in)
        let smartMatches = [];
        let myReports = [];
        let recentClaim = null;

        if (user) {
            // Find user's active lost reports to check against found reports (or vice versa)
            const [myActiveReports] = await db.execute(
                `SELECT * FROM item_reports WHERE user_id = ? AND status = 'active'`,
                [user.id]
            );

            // Fetch user's recent reports for progress tracker
            const [userReportsList] = await db.execute(
                `SELECT * FROM item_reports WHERE user_id = ? ORDER BY date_reported DESC LIMIT 4`,
                [user.id]
            );
            myReports = userReportsList;

            // Fetch user's latest claim for the live claim widget
            const [latestClaims] = await db.execute(`
                SELECT c.*, r.item_name, r.image_path, claimant.full_name AS claimant_name, reporter.full_name AS reporter_name,
                       (SELECT message FROM claim_messages WHERE claim_id = c.id ORDER BY sent_at DESC LIMIT 1) AS last_message,
                       (SELECT sent_at FROM claim_messages WHERE claim_id = c.id ORDER BY sent_at DESC LIMIT 1) AS last_message_at
                FROM claims c
                JOIN item_reports r ON r.id = c.item_id
                JOIN users claimant ON claimant.id = c.claimant_id
                JOIN users reporter ON reporter.id = r.user_id
                WHERE c.claimant_id = ? OR r.user_id = ?
                ORDER BY c.created_at DESC LIMIT 1
            `, [user.id, user.id]);
            if (latestClaims.length > 0) {
                recentClaim = latestClaims[0];
            }

            if (myActiveReports.length > 0) {
                const oppositeType = myActiveReports[0].report_type === 'lost' ? 'found' : 'lost';
                const userCategories = [...new Set(myActiveReports.map((r) => r.category))];
                const placeholders = userCategories.map(() => '?').join(',');

                if (userCategories.length > 0) {
                    const [matches] = await db.execute(
                        `SELECT r.*, u.full_name AS reporter_name 
                         FROM item_reports r 
                         JOIN users u ON u.id = r.user_id
                         WHERE r.user_id != ? 
                           AND r.report_type = ? 
                           AND r.status = 'active' 
                           AND r.category IN (${placeholders})
                         ORDER BY r.date_reported DESC LIMIT 4`,
                        [user.id, oppositeType, ...userCategories]
                    );
                    smartMatches = matches;
                }
            }
        }

        res.render('dashboard', {
            isCatalog,
            user,
            stats,
            items,
            categories: CATEGORIES,
            filters: { q, type: typeFilter, category: catFilter, status: statusFilter },
            smartMatches,
            myReports,
            recentClaim,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error fetching dashboard:', err);
        res.status(500).send('Unable to load dashboard. Please try again.');
    }
});

/* ==========================================================================
   REPORT ITEM (LOST OR FOUND)
   ========================================================================== */

// Dedicated full-page Report Item form
router.get('/items/new', requireAuth, (req, res) => {
    let initialType = req.query.type === 'found' ? 'found' : 'lost';
    
    // Guests are not allowed to report found items
    if (isGuest(req.session.user) && initialType === 'found') {
        return res.redirect(`/items/new?type=lost&error=${encodeURIComponent('Guests are not authorized to report found items. Please surrender found belongings directly to Campus Security.')}`);
    }

    res.render('reportItem', {
        user: req.session.user,
        initialType,
        categories: CATEGORIES,
        csrfToken: res.locals.csrfToken || '',
        error: req.query.error || null
    });
});

router.post('/items/report', requireAuth, upload.single('photo'), async (req, res) => {
    const reportType = req.body.report_type === 'lost' ? 'lost' : 'found';

    // Strict guest security guard: guests cannot report found items
    if (reportType === 'found' && isGuest(req.session.user)) {
        return res.redirect(`/dashboard?error=${encodeURIComponent('Guests are not authorized to report found items. Please surrender found belongings directly to Campus Security.')}`);
    }

    const itemName = typeof req.body.item_name === 'string' ? req.body.item_name.trim() : '';
    const category = typeof req.body.category === 'string' ? req.body.category.trim() : 'Other';
    const location = typeof req.body.location_found_lost === 'string' ? req.body.location_found_lost.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    const secretChallenge = typeof req.body.secret_challenge === 'string' ? req.body.secret_challenge.trim() || null : null;
    const secretAnswer = typeof req.body.secret_answer === 'string' ? req.body.secret_answer.trim() || null : null;
    const custodyMode = req.body.custody_mode === 'security_desk' ? 'security_desk' : 'peer_meetup';

    if (!itemName || !location || !description) {
        return res.redirect(`/dashboard?error=${encodeURIComponent('Please fill in all required fields.')}`);
    }
    const invalidVerificationInput = ['secret_challenge', 'secret_answer'].some((field) => (
        req.body[field] !== undefined && typeof req.body[field] !== 'string'
    ));
    if (invalidVerificationInput) {
        await removeUploadedFile(req.file);
        return res.redirect(`/items/new?type=${reportType}&error=${encodeURIComponent('The ownership question and answer must be plain text.')}`);
    }
    if (Boolean(secretChallenge) !== Boolean(secretAnswer)) {
        await removeUploadedFile(req.file);
        return res.redirect(`/items/new?type=${reportType}&error=${encodeURIComponent('Enter both the ownership question and its private correct answer, or leave both blank.')}`);
    }
    if ((secretChallenge && secretChallenge.length > 500) || (secretAnswer && secretAnswer.length > 500)) {
        await removeUploadedFile(req.file);
        return res.redirect(`/items/new?type=${reportType}&error=${encodeURIComponent('The ownership question and answer must each be 500 characters or fewer.')}`);
    }

    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        await db.execute(
            `INSERT INTO item_reports (user_id, report_type, item_name, category, description, location_found_lost, image_path, secret_challenge, secret_answer, custody_mode, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [req.session.user.id, reportType, itemName, category, description, location, imagePath, secretChallenge, secretAnswer, custodyMode]
        );

        return res.redirect(`/dashboard?msg=${encodeURIComponent(`Successfully reported ${reportType} item: "${itemName}"`)}`);
    } catch (err) {
        console.error('Failed to report item:', err);
        return res.redirect(`/dashboard?error=${encodeURIComponent('Failed to save report. Please try again.')}`);
    }
});

// Guest route to security desk protocol
router.get('/claims/guest-claim', (req, res) => {
    const caseId = req.query.case || '';
    res.render('guestClaim', {
        caseId,
        user: req.session.user || null
    });
});

/* ==========================================================================
   ITEM DETAILS & CLAIM SUBMISSION
   ========================================================================== */

router.get('/items/:id', async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    if (!itemId) return res.redirect('/dashboard');

    const user = req.session.user || null;

    try {
        const [rows] = await db.execute(
            `SELECT r.*, u.full_name AS reporter_name, u.email AS reporter_email, u.role AS reporter_role
             FROM item_reports r
             JOIN users u ON u.id = r.user_id
             WHERE r.id = ?`,
            [itemId]
        );

        if (rows.length === 0) {
            return res.redirect('/dashboard?error=Item report not found.');
        }

        const item = rows[0];
        const storedMatchResult = req.session.answerMatchResult;
        const answerMatchScore = storedMatchResult && storedMatchResult.itemId === itemId
            ? storedMatchResult.score
            : null;
        delete req.session.answerMatchResult;

        // Check if current user already has a pending claim on this item
        let existingClaim = null;
        if (user) {
            const [claims] = await db.execute(
                `SELECT * FROM claims WHERE item_id = ? AND claimant_id = ? ORDER BY id DESC LIMIT 1`,
                [itemId, user.id]
            );
            if (claims.length > 0) {
                existingClaim = claims[0];
            }
        }

        // Suggestions/Similar items
        const [similar] = await db.execute(
            `SELECT * FROM item_reports 
             WHERE category = ? AND id != ? AND status = 'active'
             ORDER BY date_reported DESC LIMIT 3`,
            [item.category, item.id]
        );

        res.render('postDetail', {
            item,
            user,
            existingClaim,
            hasConfiguredChallenge: typeof item.secret_challenge === 'string' &&
                Boolean(item.secret_challenge.trim()) &&
                typeof item.secret_answer === 'string' &&
                Boolean(item.secret_answer.trim()),
            answerMatchScore,
            answerMatchThreshold: ANSWER_MATCH_THRESHOLD,
            similar,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error fetching item details:', err);
        res.redirect('/dashboard?error=Error fetching item.');
    }
});

router.post('/items/:id/claim', requireAuth, async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    const proofDetails = typeof req.body.proof_details === 'string' ? req.body.proof_details.trim() : '';

    if (!proofDetails) {
        return res.redirect(`/items/${itemId}?error=${encodeURIComponent('Proof of ownership details are required.')}`);
    }
    if (proofDetails.length > 500) {
        return res.redirect(`/items/${itemId}?error=${encodeURIComponent('Your answer must be 500 characters or fewer.')}`);
    }

    try {
        // Verify item exists and is active found
        const [itemRows] = await db.execute('SELECT * FROM item_reports WHERE id = ?', [itemId]);
        if (itemRows.length === 0) {
            return res.redirect('/dashboard?error=Item not found.');
        }
        const item = itemRows[0];

        if (item.report_type !== 'found' || item.status !== 'active') {
            return res.redirect(`/items/${itemId}?error=${encodeURIComponent('Only active found-item reports can receive claims.')}`);
        }

        if (item.user_id === req.session.user.id) {
            return res.redirect(`/items/${itemId}?error=${encodeURIComponent('You cannot submit a claim on your own report.')}`);
        }

        // Check if claim already exists
        const [existing] = await db.execute(
            'SELECT id FROM claims WHERE item_id = ? AND claimant_id = ? AND status = "pending"',
            [itemId, req.session.user.id]
        );
        if (existing.length > 0) {
            return res.redirect(`/claims/${existing[0].id}`);
        }

        const answerMatchScore = calculateAnswerMatch(proofDetails, item.secret_answer);
        if (answerMatchScore !== null && answerMatchScore < ANSWER_MATCH_THRESHOLD) {
            req.session.answerMatchResult = { itemId, score: answerMatchScore };
            return res.redirect(`/items/${itemId}?error=${encodeURIComponent(`Your answer scored ${answerMatchScore}%. A match of at least ${ANSWER_MATCH_THRESHOLD}% is required to file this claim.`)}`);
        }

        // Insert into claims
        const [claimResult] = await db.execute(
            `INSERT INTO claims (item_id, claimant_id, proof_details, status) VALUES (?, ?, ?, 'pending')`,
            [itemId, req.session.user.id, proofDetails]
        );
        const claimId = claimResult.insertId;

        // Automatically start the communication thread in claim_messages
        await db.execute(
            `INSERT INTO claim_messages (claim_id, sender_id, message) VALUES (?, ?, ?)`,
            [claimId, req.session.user.id, `Ownership Claim Filed:\n"${proofDetails}"`]
        );

        req.session.answerMatchResult = { itemId, score: answerMatchScore };
        return res.redirect(`/items/${itemId}?msg=${encodeURIComponent('Claim submitted. You can now communicate with the finder.')}`);
    } catch (err) {
        console.error('Claim submission error:', err);
        return res.redirect(`/items/${itemId}?error=Failed to submit claim.`);
    }
});

/* ==========================================================================
   CLAIMS HUB & CHAT
   ========================================================================== */

router.get('/claims', requireAuth, async (req, res) => {
    const user = req.session.user;

    try {
        // Claims filed by current user
        const [madeClaims] = await db.execute(
            `SELECT c.*, r.item_name, r.report_type, r.image_path, r.location_found_lost, r.status AS item_status, u.full_name AS reporter_name
             FROM claims c
             JOIN item_reports r ON r.id = c.item_id
             JOIN users u ON u.id = r.user_id
             WHERE c.claimant_id = ?
             ORDER BY c.created_at DESC`,
            [user.id]
        );

        // Claims received on items reported by current user
        const [receivedClaims] = await db.execute(
            `SELECT c.*, r.item_name, r.report_type, r.image_path, r.location_found_lost, r.status AS item_status, u.full_name AS claimant_name
             FROM claims c
             JOIN item_reports r ON r.id = c.item_id
             JOIN users u ON u.id = c.claimant_id
             WHERE r.user_id = ?
             ORDER BY c.created_at DESC`,
            [user.id]
        );

        res.render('claims', {
            user,
            madeClaims,
            receivedClaims,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error fetching claims:', err);
        res.status(500).send('Error loading claims.');
    }
});

// Single Claim Chat
router.get('/claims/:id', requireAuth, async (req, res) => {
    const claimId = parseInt(req.params.id, 10);
    const user = req.session.user;

    try {
        const [claimRows] = await db.execute(
            `SELECT c.*, 
                    r.item_name, r.category, r.description AS item_description, r.location_found_lost, r.image_path, r.status AS item_status, r.user_id AS reporter_id,
                    claimant.full_name AS claimant_name, claimant.email AS claimant_email, claimant.role AS claimant_role,
                    reporter.full_name AS reporter_name, reporter.email AS reporter_email, reporter.role AS reporter_role
             FROM claims c
             JOIN item_reports r ON r.id = c.item_id
             JOIN users claimant ON claimant.id = c.claimant_id
             JOIN users reporter ON reporter.id = r.user_id
             WHERE c.id = ?`,
            [claimId]
        );

        if (claimRows.length === 0) {
            return res.redirect('/claims?error=Claim not found.');
        }

        const claim = claimRows[0];

        // Access check: User must be claimant, reporter, or admin
        const userIsAdmin = isAdmin(user);
        const userIsClaimant = claim.claimant_id === user.id;
        const userIsReporter = claim.reporter_id === user.id;

        if (!userIsAdmin && !userIsClaimant && !userIsReporter) {
            return res.redirect('/claims?error=Unauthorized to view this claim.');
        }

        // Fetch messages from claim_messages
        const [messages] = await db.execute(
            `SELECT m.*, u.full_name AS sender_name, u.role AS sender_role
             FROM claim_messages m
             JOIN users u ON u.id = m.sender_id
             WHERE m.claim_id = ?
             ORDER BY m.sent_at ASC`,
            [claimId]
        );

        res.render('chat', {
            claim,
            messages,
            user,
            userIsAdmin,
            userIsClaimant,
            userIsReporter,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error loading claim chat:', err);
        res.redirect('/claims?error=Unable to load claim chat.');
    }
});

// Post message in claim chat
router.post('/claims/:id/messages', requireAuth, async (req, res) => {
    const claimId = parseInt(req.params.id, 10);
    const text = typeof req.body.message === 'string' ? req.body.message.trim() : '';

    if (!text) {
        return res.redirect(`/claims/${claimId}`);
    }

    try {
        const [claimRows] = await db.execute(
            `SELECT c.*, r.user_id AS reporter_id 
             FROM claims c 
             JOIN item_reports r ON r.id = c.item_id 
             WHERE c.id = ?`,
            [claimId]
        );
        if (claimRows.length === 0) return res.redirect('/claims');
        const claim = claimRows[0];

        const user = req.session.user;
        const allowed = isAdmin(user) || claim.claimant_id === user.id || claim.reporter_id === user.id;
        if (!allowed) {
            return res.status(403).send('Unauthorized');
        }

        await db.execute(
            `INSERT INTO claim_messages (claim_id, sender_id, message) VALUES (?, ?, ?)`,
            [claimId, user.id, text]
        );

        return res.redirect(`/claims/${claimId}`);
    } catch (err) {
        console.error('Error sending message:', err);
        return res.redirect(`/claims/${claimId}?error=Failed to send message.`);
    }
});

// Update Claim Status (Approve or Reject)
router.post('/claims/:id/status', requireAuth, async (req, res) => {
    const claimId = parseInt(req.params.id, 10);
    const action = req.body.action; // 'approved' or 'rejected'

    if (!['approved', 'rejected'].includes(action)) {
        return res.redirect(`/claims/${claimId}`);
    }

    try {
        const [claimRows] = await db.execute(
            `SELECT c.*, r.user_id AS reporter_id, r.item_name
             FROM claims c 
             JOIN item_reports r ON r.id = c.item_id 
             WHERE c.id = ?`,
            [claimId]
        );
        if (claimRows.length === 0) return res.redirect('/claims');
        const claim = claimRows[0];

        const user = req.session.user;
        const userIsAdmin = isAdmin(user);
        const userIsReporter = claim.reporter_id === user.id;

        if (!userIsAdmin && !userIsReporter) {
            return res.redirect(`/claims/${claimId}?error=Only the finder or an admin can resolve this claim.`);
        }

        await db.execute('UPDATE claims SET status = ? WHERE id = ?', [action, claimId]);

        if (action === 'approved') {
            await db.execute('UPDATE item_reports SET status = "claimed" WHERE id = ?', [claim.item_id]);
            await db.execute(
                `INSERT INTO claim_messages (claim_id, sender_id, message) 
                 VALUES (?, ?, ?)`,
                [claimId, user.id, `[SYSTEM] Claim marked as APPROVED. The item "${claim.item_name}" has been marked as claimed/reunited.`]
            );
        } else {
            await db.execute(
                `INSERT INTO claim_messages (claim_id, sender_id, message) 
                 VALUES (?, ?, ?)`,
                [claimId, user.id, `[SYSTEM] Claim marked as REJECTED.`]
            );
        }

        if (userIsAdmin) {
            await logAudit(
                user.id,
                `Admin ${action} claim #${claimId} for item "${claim.item_name}"`,
                req.ip
            );
        }

        return res.redirect(`/claims/${claimId}?msg=${encodeURIComponent(`Claim has been ${action}.`)}`);
    } catch (err) {
        console.error('Error updating claim status:', err);
        return res.redirect(`/claims/${claimId}?error=Failed to update status.`);
    }
});

/* ==========================================================================
   MY REPORTS MANAGEMENT
   ========================================================================== */

router.get('/my-reports', requireAuth, async (req, res) => {
    const user = req.session.user;
    try {
        const [reports] = await db.execute(
            `SELECT * FROM item_reports WHERE user_id = ? ORDER BY date_reported DESC`,
            [user.id]
        );

        res.render('myReports', {
            user,
            reports,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error fetching my reports:', err);
        res.status(500).send('Error loading reports.');
    }
});

// Update item status (e.g., mark claimed or archived)
router.post('/items/:id/status', requireAuth, async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    const newStatus = req.body.status;

    if (!['active', 'claimed', 'archived'].includes(newStatus)) {
        return res.redirect('/my-reports');
    }

    try {
        const [itemRows] = await db.execute('SELECT * FROM item_reports WHERE id = ?', [itemId]);
        if (itemRows.length === 0) return res.redirect('/my-reports');
        const item = itemRows[0];

        const user = req.session.user;
        if (!isAdmin(user) && item.user_id !== user.id) {
            return res.redirect('/my-reports?error=Unauthorized.');
        }

        await db.execute('UPDATE item_reports SET status = ? WHERE id = ?', [newStatus, itemId]);

        if (isAdmin(user)) {
            await logAudit(user.id, `Admin changed item #${itemId} status to ${newStatus}`, req.ip);
        }

        return res.redirect(`/my-reports?msg=${encodeURIComponent(`Item marked as ${newStatus}.`)}`);
    } catch (err) {
        console.error('Error changing item status:', err);
        return res.redirect('/my-reports?error=Error updating status.');
    }
});

// Delete item report
router.post('/items/:id/delete', requireAuth, async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    try {
        const [itemRows] = await db.execute('SELECT * FROM item_reports WHERE id = ?', [itemId]);
        if (itemRows.length === 0) return res.redirect('/my-reports');
        const item = itemRows[0];

        const user = req.session.user;
        if (!isAdmin(user) && item.user_id !== user.id) {
            return res.redirect('/my-reports?error=Unauthorized.');
        }

        await db.execute('DELETE FROM item_reports WHERE id = ?', [itemId]);

        if (isAdmin(user)) {
            await logAudit(user.id, `Admin deleted item report #${itemId} ("${item.item_name}")`, req.ip);
        }

        return res.redirect(`/my-reports?msg=${encodeURIComponent('Report deleted successfully.')}`);
    } catch (err) {
        console.error('Error deleting report:', err);
        return res.redirect('/my-reports?error=Failed to delete report.');
    }
});

/* ==========================================================================
   ADMINISTRATOR PLATFORM FUNCTIONALITY
   ========================================================================== */

router.get('/admin/dashboard', requireAdmin, async (req, res) => {
    const user = req.session.user;
    try {
        // Aggregate statistics
        const [userCount] = await db.execute('SELECT COUNT(*) AS cnt FROM users');
        const [reportCount] = await db.execute(`
            SELECT 
                COUNT(*) AS total,
                SUM(CASE WHEN report_type = 'lost' THEN 1 ELSE 0 END) AS lost,
                SUM(CASE WHEN report_type = 'found' THEN 1 ELSE 0 END) AS found,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
                SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review
            FROM item_reports
        `);
        const [claimCount] = await db.execute(`
            SELECT 
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
            FROM claims
        `);

        // Recent Reports
        const [recentReports] = await db.execute(`
            SELECT r.*, u.full_name AS reporter_name 
            FROM item_reports r 
            JOIN users u ON u.id = r.user_id 
            ORDER BY r.date_reported DESC LIMIT 6
        `);

        // Recent Audit Logs
        const [recentAudits] = await db.execute(`
            SELECT a.*, u.full_name AS admin_name 
            FROM audit_logs a 
            JOIN users u ON u.id = a.admin_id 
            ORDER BY a.timestamp DESC LIMIT 8
        `);

        // Categories breakdown
        const [catStats] = await db.execute(`
            SELECT category, COUNT(*) as cnt 
            FROM item_reports 
            GROUP BY category 
            ORDER BY cnt DESC
        `);

        res.render('adminDashboard', {
            user,
            stats: {
                users: userCount[0].cnt,
                reports: reportCount[0],
                claims: claimCount[0]
            },
            recentReports,
            recentAudits,
            catStats,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error loading admin dashboard:', err);
        res.status(500).send('Error loading admin portal.');
    }
});

// Admin All Reports Management
router.get('/admin/reports', requireAdmin, async (req, res) => {
    const user = req.session.user;
    try {
        const [reports] = await db.execute(`
            SELECT r.*, u.full_name AS reporter_name, u.email AS reporter_email, u.role AS reporter_role
            FROM item_reports r
            JOIN users u ON u.id = r.user_id
            ORDER BY r.date_reported DESC
        `);

        res.render('adminReports', {
            user,
            reports,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error fetching admin reports:', err);
        res.status(500).send('Error loading reports.');
    }
});

// Admin Audit Logs Viewer
router.get('/admin/audit-logs', requireAdmin, async (req, res) => {
    const user = req.session.user;
    try {
        const [logs] = await db.execute(`
            SELECT a.*, u.full_name AS admin_name, u.email AS admin_email
            FROM audit_logs a
            JOIN users u ON u.id = a.admin_id
            ORDER BY a.timestamp DESC
        `);

        res.render('adminAuditLogs', {
            user,
            logs,
            timeAgo,
            msg: req.query.msg || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('Error loading audit logs:', err);
        res.status(500).send('Error loading audit logs.');
    }
});

// Admin Office Turn-in Log Form Submission
router.post('/admin/items/log', requireAdmin, upload.single('photo'), async (req, res) => {
    const user = req.session.user;
    const itemName = typeof req.body.item_name === 'string' ? req.body.item_name.trim() : '';
    const category = typeof req.body.category === 'string' ? req.body.category.trim() : 'Other';
    const location = typeof req.body.location_found_lost === 'string' ? req.body.location_found_lost.trim() : 'Lost & Found Office';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    if (!itemName || !description) {
        return res.redirect('/admin/dashboard?error=Please specify item name and description.');
    }

    try {
        const [result] = await db.execute(
            `INSERT INTO item_reports (user_id, report_type, item_name, category, description, location_found_lost, image_path, status)
             VALUES (?, 'found', ?, ?, ?, ?, ?, 'active')`,
            [user.id, itemName, category, description, location, imagePath]
        );

        await logAudit(
            user.id,
            `Admin logged office turned-in item #${result.insertId} ("${itemName}")`,
            req.ip
        );

        return res.redirect('/admin/dashboard?msg=Office item logged and broadcasted to campus.');
    } catch (err) {
        console.error('Error logging office item:', err);
        return res.redirect('/admin/dashboard?error=Failed to log office item.');
    }
});

module.exports = router;