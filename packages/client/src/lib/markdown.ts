/**
 * Minimal markdown to HTML converter for AI notes display.
 * Handles: ## headings, - bullet lists, [ ]/[x] checkboxes, **bold**, paragraphs.
 */
export function mdToHtml(md: string): string {
	if (!md) return "";
	return md
		.replace(/^## (.+)$/gm, "<h2>$1</h2>")
		.replace(/^- \[ \] (.+)$/gm, "<li>&#9744; $1</li>")
		.replace(/^- \[x\] (.+)$/gm, "<li>&#9745; $1</li>")
		.replace(/^- (.+)$/gm, "<li>$1</li>")
		.replace(/(<li>[\s\S]*?<\/li>)+/gm, "<ul>$&</ul>")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\n\n/g, "<br><br>");
}

export function stripMarkdown(md: string): string {
	return md
		.replace(/^#+ /gm, "")
		.replace(/\*\*/g, "")
		.replace(/^- /gm, "• ");
}
