const CSPC_INSTITUTIONAL_DOMAINS = ['my.cspc.edu.ph', 'cspc.edu.ph'];

/**
 * Validates basic email syntax.
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmailSyntax(email) {
    if (typeof email !== 'string') return false;
    const trimmed = email.trim();
    if (!trimmed || trimmed.length > 150) return false;
    // Standard RFC-compliant email syntax regex
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    return emailRegex.test(trimmed);
}

/**
 * Checks whether an email belongs to an authorized CSPC institutional domain (@my.cspc.edu.ph or @cspc.edu.ph).
 * @param {string} email
 * @returns {boolean}
 */
function isInstitutionalEmail(email) {
    if (!isValidEmailSyntax(email)) return false;
    const trimmed = email.trim().toLowerCase();
    const lastAt = trimmed.lastIndexOf('@');
    if (lastAt === -1) return false;
    const domain = trimmed.slice(lastAt + 1);
    return CSPC_INSTITUTIONAL_DOMAINS.includes(domain);
}

/**
 * Validates password strength according to master architectural requirements:
 * Segment 1: Minimum 8 characters
 * Segment 2: Uppercase + lowercase + number satisfied
 * Segment 3: Special character satisfied
 * All 3 segments must be satisfied for a valid strong password.
 * @param {string} password
 * @returns {{ valid: boolean, segments: number, errors: string[] }}
 */
function validatePasswordStrength(password) {
    const pw = typeof password === 'string' ? password : '';
    const errors = [];
    let segments = 0;

    const hasLength = pw.length >= 8;
    const hasUpper = /[A-Z]/.test(pw);
    const hasLower = /[a-z]/.test(pw);
    const hasNumber = /[0-9]/.test(pw);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/`~]/.test(pw);

    if (hasLength) {
        segments = 1;
    } else {
        errors.push('Minimum 8 characters');
    }

    if (hasLength && hasUpper && hasLower && hasNumber) {
        segments = 2;
    } else {
        if (!hasUpper) errors.push('At least one uppercase letter');
        if (!hasLower) errors.push('At least one lowercase letter');
        if (!hasNumber) errors.push('At least one number');
    }

    if (hasLength && hasUpper && hasLower && hasNumber && hasSpecial) {
        segments = 3;
    } else if (hasLength && hasUpper && hasLower && hasNumber && !hasSpecial) {
        errors.push('At least one special character');
    }

    return {
        valid: segments === 3,
        segments,
        errors
    };
}

/**
 * Role checkers against authoritative database roles:
 * 'student/staff', 'admin', 'parent/guest'
 */
function isAdmin(user) {
    if (!user) return false;
    const r = String(user.role || '').trim().toLowerCase();
    return r === 'admin' || r === 'administrator';
}

function isStudent(user) {
    if (!user) return false;
    const r = String(user.role || '').trim().toLowerCase();
    return r === 'student/staff' || r === 'student' || r === 'staff';
}

function isGuest(user) {
    if (!user) return false;
    const r = String(user.role || '').trim().toLowerCase();
    return r === 'parent/guest' || r === 'guest' || r === 'parent';
}

module.exports = {
    CSPC_INSTITUTIONAL_DOMAINS,
    isValidEmailSyntax,
    isInstitutionalEmail,
    validatePasswordStrength,
    isAdmin,
    isStudent,
    isGuest
};
