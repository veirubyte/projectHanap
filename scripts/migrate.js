// Migration: Add ownership verification fields and constraints.
const db = require('../config/db');

async function migrate() {
    try {
        // Check existing columns
        const [cols] = await db.execute(`SHOW COLUMNS FROM item_reports`);
        const colNames = cols.map(c => c.Field);

        if (!colNames.includes('secret_challenge')) {
            await db.execute(`ALTER TABLE item_reports ADD COLUMN secret_challenge VARCHAR(500) DEFAULT NULL`);
            console.log('✓ Added column: secret_challenge');
        } else {
            console.log('- Column secret_challenge already exists');
        }

        if (!colNames.includes('secret_answer')) {
            await db.execute(`ALTER TABLE item_reports ADD COLUMN secret_answer VARCHAR(500) DEFAULT NULL`);
            console.log('✓ Added column: secret_answer');
        } else {
            console.log('- Column secret_answer already exists');
        }

        if (!colNames.includes('custody_mode')) {
            await db.execute(`ALTER TABLE item_reports ADD COLUMN custody_mode ENUM('peer_meetup','security_desk') DEFAULT 'peer_meetup'`);
            console.log('✓ Added column: custody_mode');
        } else {
            console.log('- Column custody_mode already exists');
        }

        const [invalidRows] = await db.execute(`
            SELECT id
            FROM item_reports
            WHERE (secret_challenge IS NULL) <> (secret_answer IS NULL)
               OR (secret_challenge IS NOT NULL AND CHAR_LENGTH(TRIM(secret_challenge)) = 0)
               OR (secret_answer IS NOT NULL AND CHAR_LENGTH(TRIM(secret_answer)) = 0)
            LIMIT 20
        `);
        if (invalidRows.length > 0) {
            const ids = invalidRows.map((row) => row.id).join(', ');
            throw new Error(
                `Cannot add ownership verification constraint. Resolve item_reports rows with incomplete or blank question/answer pairs first. Affected IDs (up to 20): ${ids}`
            );
        }

        const [checks] = await db.execute(`
            SELECT CONSTRAINT_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'item_reports'
              AND CONSTRAINT_TYPE = 'CHECK'
              AND CONSTRAINT_NAME = 'chk_item_reports_secret_verification'
        `);
        if (checks.length === 0) {
            await db.execute(`
                ALTER TABLE item_reports
                ADD CONSTRAINT chk_item_reports_secret_verification
                CHECK (
                    (secret_challenge IS NULL AND secret_answer IS NULL)
                    OR (
                        secret_challenge IS NOT NULL
                        AND secret_answer IS NOT NULL
                        AND CHAR_LENGTH(TRIM(secret_challenge)) BETWEEN 1 AND 500
                        AND CHAR_LENGTH(TRIM(secret_answer)) BETWEEN 1 AND 500
                    )
                )
            `);
            console.log('✓ Added constraint: chk_item_reports_secret_verification');
        } else {
            console.log('- Constraint chk_item_reports_secret_verification already exists');
        }

        console.log('\n✅ Migration complete.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err.message);
        process.exit(1);
    }
}

migrate();
