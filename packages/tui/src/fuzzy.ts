/**
 * 模糊匹配工具。
 * 查询中的所有字符按顺序出现在目标文本中时即匹配，不要求连续。
 * 分数越低，匹配效果越好。
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): FuzzyMatch => {
		if (normalizedQuery.length === 0) {
			return { matches: true, score: 0 };
		}

		if (normalizedQuery.length > textLower.length) {
			return { matches: false, score: 0 };
		}

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		while (queryIndex < normalizedQuery.length) {
			const i = textLower.indexOf(normalizedQuery[queryIndex]!, lastMatchIndex + 1);
			if (i === -1) break;

			const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!);

			// 连续匹配时降低分数。
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				// 存在间隔时提高分数。
				if (lastMatchIndex >= 0) {
					score += (i - lastMatchIndex - 1) * 2;
				}
			}

			// 匹配到单词边界时降低分数。
			if (isWordBoundary) {
				score -= 10;
			}

			// 匹配位置靠后时略微提高分数。
			score += i * 0.1;

			lastMatchIndex = i;
			queryIndex++;
		}

		if (queryIndex < normalizedQuery.length) {
			return { matches: false, score: 0 };
		}

		if (normalizedQuery === textLower) {
			score -= 100;
		}

		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * 按模糊匹配质量筛选并排序条目，最佳匹配排在前面。
 * 支持以空白或斜杠分隔的词元，且每个词元都必须匹配。
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
