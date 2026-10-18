const bcrypt = require('bcrypt');
const db = require('../config/db');

async function seed() {
    try {
        console.log('Seeding baseline database...');

        // 1. Clean existing test data safely
        await db.execute('SET FOREIGN_KEY_CHECKS = 0');
        await db.execute('TRUNCATE TABLE claim_messages');
        await db.execute('TRUNCATE TABLE claims');
        await db.execute('TRUNCATE TABLE item_reports');
        await db.execute('TRUNCATE TABLE audit_logs');
        await db.execute('TRUNCATE TABLE users');
        await db.execute('SET FOREIGN_KEY_CHECKS = 1');

        // 2. Hash passwords
        const adminHash = await bcrypt.hash('Admin@12345', 10);
        const userHash = await bcrypt.hash('password123', 10);

        // 3. Insert baseline users
        const [adminRes] = await db.execute(
            `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
            ['Admin User', 'admin@cspc.edu.ph', adminHash, 'admin']
        );
        const adminId = adminRes.insertId;

        const [juanRes] = await db.execute(
            `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
            ['Juan Dela Cruz', 'juan@my.cspc.edu.ph', userHash, 'student/staff']
        );
        const juanId = juanRes.insertId;

        const [mariaRes] = await db.execute(
            `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
            ['Maria Santos', 'maria@my.cspc.edu.ph', userHash, 'student/staff']
        );
        const mariaId = mariaRes.insertId;

        const [parentRes] = await db.execute(
            `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
            ['Parent Guest', 'parent@gmail.com', userHash, 'parent/guest']
        );
        const parentId = parentRes.insertId;

        // 4. Insert baseline item reports
        const [rep1] = await db.execute(
            `INSERT INTO item_reports (user_id, report_type, item_name, category, description, location_found_lost, status, secret_challenge, secret_answer, custody_mode) 
             VALUES (?, 'found', 'Blue CSPC CCS Department ID Lanyard', 'Keys & Lanyards', 'Official CSPC CCS department lanyard with transparent badge holder.', 'Main Library', 'active', 'What pin is attached to the clip?', 'small red flower pin', 'peer_meetup')`,
            [juanId]
        );

        const [rep2] = await db.execute(
            `INSERT INTO item_reports (user_id, report_type, item_name, category, description, location_found_lost, status, secret_challenge, custody_mode) 
             VALUES (?, 'lost', 'Black SanDisk 32GB Flash Drive', 'Electronics', 'Contains IT capstone files and research drafts.', 'ComLab 2', 'active', NULL, 'peer_meetup')`,
            [mariaId]
        );

        const [rep3] = await db.execute(
            `INSERT INTO item_reports (user_id, report_type, item_name, category, description, location_found_lost, status) 
             VALUES (?, 'found', 'Casio fx-991EX Calculator', 'Electronics', 'Silver scientific calculator with initials inscribed.', 'Engineering Rm 304', 'claimed')`,
            [adminId]
        );

        // 5. Insert sample claim & claim message
        const [claim1] = await db.execute(
            `INSERT INTO claims (item_id, claimant_id, proof_details, status) VALUES (?, ?, ?, 'pending')`,
            [rep1.insertId, mariaId, 'A small red flower pin is attached to the clip. My student ID is inside.']
        );

        await db.execute(
            `INSERT INTO claim_messages (claim_id, sender_id, message) VALUES (?, ?, ?)`,
            [claim1.insertId, mariaId, 'Hi! I lost this lanyard yesterday in the library. My ID card is inside.']
        );

        console.log('✅ Baseline seed completed successfully.');
        return true;
    } catch (err) {
        console.error('Seeding failed:', err);
        throw err;
    }
}

if (require.main === module) {
    seed().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = seed;
