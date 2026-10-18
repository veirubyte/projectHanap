const ANSWER_MATCH_THRESHOLD = 80;

function normalizeAnswer(answer) {
    return answer
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function calculateAnswerMatch(userAnswer, secretAnswer) {
    if (typeof userAnswer !== 'string' || typeof secretAnswer !== 'string' || !secretAnswer.trim()) return null;

    const user = normalizeAnswer(userAnswer);
    const expected = normalizeAnswer(secretAnswer);
    if (!user || !expected) return 0;
    if (user === expected || user.includes(expected)) return 100;

    const expectedTokens = expected.split(' ').filter(Boolean);
    const userTokens = new Set(user.split(' ').filter(Boolean));
    const tokenScore = expectedTokens.length
        ? (expectedTokens.filter((token) => userTokens.has(token)).length / expectedTokens.length) * 100
        : 0;

    let previousRow = Array.from({ length: expected.length + 1 }, (_, index) => index);
    for (let userIndex = 1; userIndex <= user.length; userIndex++) {
        const currentRow = [userIndex];
        for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex++) {
            const substitutionCost = user[userIndex - 1] === expected[expectedIndex - 1] ? 0 : 1;
            currentRow[expectedIndex] = Math.min(
                currentRow[expectedIndex - 1] + 1,
                previousRow[expectedIndex] + 1,
                previousRow[expectedIndex - 1] + substitutionCost
            );
        }
        previousRow = currentRow;
    }

    const maxLength = Math.max(user.length, expected.length);
    const characterScore = maxLength
        ? (1 - previousRow[expected.length] / maxLength) * 100
        : 0;

    return Math.round(Math.max(tokenScore, characterScore));
}

module.exports = { ANSWER_MATCH_THRESHOLD, calculateAnswerMatch };
