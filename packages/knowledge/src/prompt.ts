/**
 * The `# Knowledge` system-prompt section: the retrieval index of every note.
 *
 * `loadKnowledgeSummaries` normalizes each file's `description` frontmatter from
 * its body when the stored tags are missing or sentence-shaped, and writes it
 * back. That side effect is intentional and preserved: the index is only useful
 * when the tags it lists are the ones a future agent would search for, and the
 * alternative — rewriting on write only — leaves pre-existing notes with
 * unsearchable descriptions. Set `autoUpdate: false` to get a read-only pass.
 */
import { type KnowledgeSummary, knowledgeUrlForPath, loadKnowledgeSummaries } from "./knowledge-index";

interface KnowledgeCategoryBlock {
	category: string;
	files: Array<{ description: string; topic: string; url: string }>;
}

function groupByCategory(summaries: readonly KnowledgeSummary[]): KnowledgeCategoryBlock[] {
	const categories = new Map<string, KnowledgeCategoryBlock>();
	for (const summary of summaries) {
		let category = categories.get(summary.category);
		if (!category) {
			category = { category: summary.category, files: [] };
			categories.set(summary.category, category);
		}
		category.files.push({
			description: summary.description,
			topic: summary.topic,
			url: knowledgeUrlForPath(summary.path),
		});
	}
	return Array.from(categories.values());
}

/**
 * Rendered `# Knowledge` block for `cwd`, or undefined when the project has no
 * notes yet (the knowledge agent has nothing to index).
 */
export async function renderKnowledgeSection(cwd: string): Promise<string | undefined> {
	const summaries = await loadKnowledgeSummaries({ cwd });
	if (summaries.length === 0) return undefined;
	const lines = ["# Knowledge", ...groupByCategory(summaries).flatMap(category => renderCategory(category))];
	return lines.join("\n");
}

function renderCategory(category: KnowledgeCategoryBlock): string[] {
	return [category.category, ...category.files.map(file => `- \`${file.url}\`: ${file.description}`)];
}
