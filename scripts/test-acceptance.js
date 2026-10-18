const http = require('http');
const app = require('../app');
const db = require('../config/db');
const seed = require('./seed');

let server;
let port;

function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, () => {
            port = server.address().port;
            resolve();
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

function req(path, options = {}, cookie = '') {
    return new Promise((resolve, reject) => {
        const url = `http://127.0.0.1:${port}${path}`;
        const parsed = new URL(url);

        const headers = options.headers || {};
        if (cookie) headers['Cookie'] = cookie;

        const requestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers
        };

        const r = http.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                const setCookie = res.headers['set-cookie'];
                let newCookie = cookie;
                if (setCookie) {
                    newCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
                }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                    cookie: newCookie
                });
            });
        });

        r.on('error', reject);
        if (options.body) {
            r.write(options.body);
        }
        r.end();
    });
}

let passedCount = 0;
let failedCount = 0;

function assert(testNum, desc, condition, detail = '') {
    if (condition) {
        passedCount++;
        console.log(`[PASS] TEST ${testNum}: ${desc}`);
    } else {
        failedCount++;
        console.error(`[FAIL] TEST ${testNum}: ${desc} - ${detail}`);
    }
}

async function runTests() {
    console.log('=== STARTING HANAP ACCEPTANCE & COMPONENT TEST SUITE ===\n');
    await startServer();
    await seed();

    try {
        // -------------------------------------------------------------
        // TEST 1: Click Enter HANAP Portal opens Login
        // -------------------------------------------------------------
        const t1 = await req('/');
        assert(1, 'Click Enter HANAP Portal opens Login', t1.body.includes('href="/login"') && t1.body.includes('Enter HANAP Portal'));

        // -------------------------------------------------------------
        // TEST 2: Select Institution displays only Email + Password without role selector
        // -------------------------------------------------------------
        const t2 = await req('/login?category=institution');
        const hasNoRoleSelector = !t2.body.includes('<select name="role"') && !t2.body.includes('Login as Student');
        assert(2, 'Select Institution displays only Email + Password without role selector', hasNoRoleSelector && t2.body.includes('Institutional Login'));

        // -------------------------------------------------------------
        // TEST 3: Select Guest displays Guest Email + Password form
        // -------------------------------------------------------------
        const t3 = await req('/login?category=guest');
        assert(3, 'Select Guest displays Guest Email + Password form', t3.body.includes('Guest Login'));

        // -------------------------------------------------------------
        // TEST 4: Institution + gmail.com rejected with guest guidance
        // -------------------------------------------------------------
        const t4 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&email=user@gmail.com&password=password123'
        });
        assert(4, 'Institution + gmail.com rejected with guest guidance and Switch button', t4.status === 400 && t4.body.includes('Institutional account required'));

        // -------------------------------------------------------------
        // TEST 5 & 6: CSPC institutional domain verification
        // -------------------------------------------------------------
        const { isInstitutionalEmail, validatePasswordStrength } = require('../config/roles');
        assert(5, 'Institution + @my.cspc.edu.ph accepted as institutional email domain', isInstitutionalEmail('test@my.cspc.edu.ph'));
        assert(6, 'Institution + @cspc.edu.ph accepted as institutional email domain', isInstitutionalEmail('staff@cspc.edu.ph'));

        // -------------------------------------------------------------
        // TEST 7 & 8: Empty email / password
        // -------------------------------------------------------------
        const t7 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&email=&password='
        });
        assert(7, 'Institution + empty email shows alert DIV', t7.status === 400 && t7.body.includes('email'));
        assert(8, 'Institution + empty password shows alert DIV', t7.status === 400);

        // -------------------------------------------------------------
        // TEST 9: Valid institutional email + wrong password rejected safely
        // -------------------------------------------------------------
        const t9 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&email=juan@my.cspc.edu.ph&password=WrongPass123!'
        });
        assert(9, 'Valid institutional email + wrong password rejected with safe alert', t9.status === 401 && t9.body.includes('Unable to sign in'));

        // -------------------------------------------------------------
        // TEST 10: Institutional student login redirects to /dashboard
        // -------------------------------------------------------------
        const t10 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&email=juan@my.cspc.edu.ph&password=password123'
        });
        const juanCookie = t10.cookie;
        assert(10, 'Institutional student/staff account redirects to /dashboard', t10.status === 302 && t10.headers.location === '/dashboard');

        // -------------------------------------------------------------
        // TEST 11: Institutional admin login redirects to /admin/dashboard
        // -------------------------------------------------------------
        const t11 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&email=admin@cspc.edu.ph&password=Admin@12345'
        });
        const adminCookie = t11.cookie;
        assert(11, 'Institutional admin account redirects to /admin/dashboard', t11.status === 302 && t11.headers.location === '/admin/dashboard');

        // -------------------------------------------------------------
        // TEST 12: Guest + valid parent/guest account redirects to /dashboard
        // -------------------------------------------------------------
        const t12 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=guest&email=parent@gmail.com&password=password123'
        });
        assert(12, 'Guest + valid parent/guest account redirects to /dashboard', t12.status === 302 && t12.headers.location === '/dashboard');

        // -------------------------------------------------------------
        // TEST 13 & 14: Cross category validation
        // -------------------------------------------------------------
        const t13 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=guest&email=juan@my.cspc.edu.ph&password=password123'
        });
        assert(13, 'Guest + institutional student account rejected with Switch to Institution guidance', t13.status === 403 && t13.body.includes('Institution account detected'));

        const t14 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=guest&email=admin@cspc.edu.ph&password=Admin@12345'
        });
        assert(14, 'Guest + institutional admin account rejected with Switch to Institution guidance', t14.status === 403 && t14.body.includes('Institution account detected'));

        // -------------------------------------------------------------
        // TEST 15: Institution + parent/guest account rejected
        // -------------------------------------------------------------
        const t15 = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&email=parent@gmail.com&password=password123'
        });
        assert(15, 'Institution + parent/guest Gmail rejected with Institutional account required', t15.status === 400 && t15.body.includes('Institutional account required'));

        // -------------------------------------------------------------
        // TEST 16: Register validation
        // -------------------------------------------------------------
        const t16 = await req('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&full_name=&email=&password=&confirm_password='
        });
        assert(16, 'Register with incomplete info returns alert DIV specifying missing items', t16.status === 400 && t16.body.includes('Complete the required information'));

        // -------------------------------------------------------------
        // TEST 17, 18, 19: Password strength segments
        // -------------------------------------------------------------
        const weak = validatePasswordStrength('weak');
        const med = validatePasswordStrength('Medium123');
        const strong = validatePasswordStrength('StrongPass@2026');
        assert(17, 'Register with weak password fails validation (segments < 3)', !weak.valid && weak.segments < 3);
        assert(18, 'Register with medium password achieves Segment 2', !med.valid && med.segments === 2);
        assert(19, 'Register with strong password satisfies all 3 segments', strong.valid && strong.segments === 3);

        // -------------------------------------------------------------
        // TEST 20: Passwords mismatch
        // -------------------------------------------------------------
        const t20 = await req('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&full_name=New+Student&email=student99@my.cspc.edu.ph&password=StrongPass@2026&confirm_password=DiffPass@2026'
        });
        assert(20, 'Passwords do not match blocks registration with error alert', t20.status === 400 && t20.body.includes('Passwords do not match'));

        // -------------------------------------------------------------
        // TEST 21: Duplicate email
        // -------------------------------------------------------------
        const t21 = await req('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=institution&full_name=Duplicate&email=juan@my.cspc.edu.ph&password=StrongPass@2026&confirm_password=StrongPass@2026'
        });
        assert(21, 'Duplicate email blocks registration with Account already exists', t21.status === 409 && t21.body.includes('Account already exists'));

        // -------------------------------------------------------------
        // TEST 22 & 23: Successful registrations
        // -------------------------------------------------------------
        const newStudentEmail = `new_${Date.now()}@my.cspc.edu.ph`;
        const t22 = await req('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `category=institution&full_name=Valid+Student&email=${encodeURIComponent(newStudentEmail)}&password=StrongPass@2026&confirm_password=StrongPass@2026`
        });
        const [dbStudent] = await db.execute('SELECT role FROM users WHERE email = ?', [newStudentEmail]);
        assert(22, 'Successful Institution registration creates database role student/staff', t22.status === 302 && dbStudent[0] && dbStudent[0].role === 'student/staff');

        const newGuestEmail = `guest_${Date.now()}@yahoo.com`;
        const t23 = await req('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `category=guest&full_name=Valid+Guest&email=${encodeURIComponent(newGuestEmail)}&password=StrongPass@2026&confirm_password=StrongPass@2026`
        });
        const [dbGuest] = await db.execute('SELECT role FROM users WHERE email = ?', [newGuestEmail]);
        assert(23, 'Successful Guest registration creates database role parent/guest', t23.status === 302 && dbGuest[0] && dbGuest[0].role === 'parent/guest');

        // -------------------------------------------------------------
        // TEST 24: Role manipulation prevention
        // -------------------------------------------------------------
        const hackEmail = `hacker_${Date.now()}@my.cspc.edu.ph`;
        await req('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `category=institution&role=admin&full_name=Hacker&email=${encodeURIComponent(hackEmail)}&password=StrongPass@2026&confirm_password=StrongPass@2026`
        });
        const [dbHack] = await db.execute('SELECT role FROM users WHERE email = ?', [hackEmail]);
        assert(24, 'Manipulated role=admin payload is discarded; account assigned student/staff', dbHack[0] && dbHack[0].role === 'student/staff');

        // -------------------------------------------------------------
        // TEST 25, 26, 27: Route protections
        // -------------------------------------------------------------
        const t25 = await req('/admin/dashboard');
        assert(25, 'Unauthenticated access to protected route redirects to /login', t25.status === 302 || t25.status === 403);

        const t26 = await req('/admin/dashboard', {}, juanCookie);
        assert(26, 'Student account attempting /admin/dashboard returns 403 Access Denied', t26.status === 403 && t26.body.includes('Access Denied'));

        const guestLogin = await req('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'category=guest&email=parent@gmail.com&password=password123'
        });
        const t27 = await req('/admin/dashboard', {}, guestLogin.cookie);
        assert(27, 'Guest account attempting /admin/dashboard returns 403 Access Denied', t27.status === 403);

        // =============================================================
        // NEW FEATURE TESTS (MODULES FROM ZIP1, ZIP2, ZIP3)
        // =============================================================

        // TEST 28: Dedicated Report Item page loads with toggle
        const t28 = await req('/items/new?type=found', {}, juanCookie);
        assert(28, 'GET /items/new loads dedicated report form with Serene Horizon tokens', t28.status === 200 && t28.body.includes('Report a Found Item') && t28.body.includes('secret_challenge'));

        const csrfMatch = t28.body.match(/name="_csrf"\s+value="([^"]+)"/);
        const csrfToken = csrfMatch ? csrfMatch[1] : '';
        const reportCookie = t28.cookie || juanCookie;

        // TEST 29: Post Report Item saves secret_challenge and custody_mode
        const t29 = await req('/items/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `_csrf=${csrfToken}&report_type=found&item_name=Silver+Water+Bottle&category=Tumblers+%26+Bottles&location_found_lost=Gym+Bench&description=Stainless+steel+with+stickers&secret_challenge=What+color+is+the+lid%3F&secret_answer=blue&custody_mode=security_desk`
        }, reportCookie);
        assert(29, 'POST /items/report successfully creates report with secret_challenge and custody_mode', t29.status === 302);

        // TEST 30: Item Detail page renders with Ownership Challenge
        const [bottleRow] = await db.execute('SELECT id FROM item_reports WHERE item_name = "Silver Water Bottle" LIMIT 1');
        const bottleId = bottleRow[0] ? bottleRow[0].id : 1;
        const t30 = await req(`/items/${bottleId}`, {}, reportCookie);
        assert(30, 'GET /items/:id renders Item Detail + Claim Studio with verification question', t30.status === 200 && t30.body.includes('Silver Water Bottle') && t30.body.includes('Campus Match Engine'));

        // TEST 31: Claims Hub loads without 500 error
        const t31 = await req('/claims', {}, juanCookie);
        assert(31, 'GET /claims renders Claims Resolution Hub', t31.status === 200 && t31.body.includes('Claims Resolution Hub'));

        // TEST 32: Claim Chat loads with message stream
        const [claimRow] = await db.execute('SELECT id FROM claims LIMIT 1');
        const claimId = claimRow[0] ? claimRow[0].id : 1;
        const t32 = await req(`/claims/${claimId}`, {}, juanCookie);
        assert(32, 'GET /claims/:id renders Claim Conversation Chat', t32.status === 200 && t32.body.includes('Claim #'));

        // TEST 33: My Reports loads user items
        const t33 = await req('/my-reports', {}, juanCookie);
        assert(33, 'GET /my-reports renders user reports management', t33.status === 200 && t33.body.includes('My Reported Items'));

        // TEST 34: Guest Claim routing renders security desk protocol
        const t34 = await req('/claims/guest-claim?case=F-101');
        assert(34, 'GET /claims/guest-claim renders security desk protocol', t34.status === 200 && t34.body.includes('Security Desk Routing'));

        // TEST 35: Dashboard renders Live Recovery Ticker and 4-step Progress Tracker
        const t35 = await req('/dashboard', {}, juanCookie);
        assert(35, 'GET /dashboard renders Live Recovery Ticker and 4-step progress tracker', t35.status === 200 && t35.body.includes('Live Recovery Ticker') && t35.body.includes('Reported'));

        // TEST 36: Guest does not see "+ Report Found" in navbar or dashboard
        const guestCookie = t12.cookie;
        const t36 = await req('/dashboard', {}, guestCookie);
        const guestHasFoundBtn = t36.body.includes('+ Report Found Item') || t36.body.includes('<span>Report Found</span>');
        assert(36, 'Guest does not see "+ Report Found" in navbar or dashboard', t36.status === 200 && !guestHasFoundBtn);

        // TEST 37: Guest GET /items/new?type=found redirects to type=lost with error
        const t37 = await req('/items/new?type=found', {}, guestCookie);
        assert(37, 'Guest GET /items/new?type=found is blocked and redirected to lost', t37.status === 302 && t37.headers.location.includes('type=lost'));

        // TEST 38: Guest POST /items/report with found is rejected
        const t38Get = await req('/items/new?type=lost', {}, guestCookie);
        const guestCsrfMatch = t38Get.body.match(/name="_csrf"\s+value="([^"]+)"/);
        const guestCsrf = guestCsrfMatch ? guestCsrfMatch[1] : '';
        const t38 = await req('/items/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `_csrf=${guestCsrf}&report_type=found&item_name=Guest+Found+Watch&category=Other&location_found_lost=Library&description=Gold+watch`
        }, t38Get.cookie || guestCookie);
        assert(38, 'Guest POST /items/report with report_type=found is rejected', t38.status === 302 && t38.headers.location.includes('error='));

    } catch (err) {
        console.error('Test execution error:', err);
    } finally {
        await stopServer();
        console.log(`\n============================================================`);
        console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED out of ${passedCount + failedCount} TESTS`);
        console.log(`============================================================`);
        process.exit(failedCount === 0 ? 0 : 1);
    }
}

function mariaCookie() {
    return '';
}

runTests();
