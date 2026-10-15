const db = require('../config/db');

/**
 * Automatically archives item reports that have been active past their 60-day retention period.
 * @returns {Promise<{ count: number }>}
 */
async function flagStaleItems() {
    try {
        const [result] = await db.execute(
            `UPDATE item_reports 
             SET status = 'archived' 
             WHERE status = 'active' 
               AND date_reported <= NOW() - INTERVAL 60 DAY`
        );
        if (result.affectedRows > 0) {
            console.log(`[Lifecycle] Archived ${result.affectedRows} item report(s) exceeding 60-day retention.`);
        }
        return { count: result.affectedRows };
    } catch (err) {
        console.error('[Lifecycle] Error archiving stale items:', err);
        return { count: 0, error: err.message };
    }
}

module.exports = {
    flagStaleItems
};
