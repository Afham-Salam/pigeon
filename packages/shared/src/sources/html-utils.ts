/**
 * Strips HTML tags and decodes common entities to produce clean plain text.
 * Runs in pure Workers runtime without DOM/Node dependencies.
 */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return '';

  return (
    input
      // First decode escaped HTML entities like &lt;p&gt;
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      // Convert line breaks and paragraph/list tags to newlines
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      // Strip all remaining HTML tags
      .replace(/<[^>]+>/g, '')
      // Decode remaining HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&middot;/g, '·')
      .replace(/&bull;/g, '•')
      .replace(/&ndash;/g, '–')
      .replace(/&mdash;/g, '—')
      .replace(/&rsquo;|&lsquo;/g, "'")
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/&hellip;/g, '...')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      // Normalize whitespace while preserving paragraphs
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim()
  );
}
