// Advisory compliance heuristics. This is a TEXT-LEVEL check (prompt/name + any detected text)
// against a small list of commonly-protected marks and prohibited terms. It is NOT legal advice
// and does NOT perform image-content trademark detection. It exists to catch obvious risks
// before a design becomes a product; the disclaimer is surfaced on every result.

export interface ComplianceFlag {
  severity: 'block' | 'warn';
  category: 'copyright' | 'trademark' | 'prohibited' | 'channel_specific';
  finding: string;
}

// Representative, not exhaustive. Well-known franchises / brands whose names in a design prompt
// are a frequent IP-risk signal.
const TRADEMARK_TERMS = [
  'disney',
  'mickey mouse',
  'marvel',
  'spider-man',
  'spiderman',
  'batman',
  'superman',
  'star wars',
  'harry potter',
  'pokemon',
  'nintendo',
  'super mario',
  'nike',
  'adidas',
  'gucci',
  'louis vuitton',
  'chanel',
  'coca-cola',
  'coca cola',
  'nfl',
  'nba',
  'mlb',
  'olympics',
  'super bowl',
];

// Prohibited / hateful content (kept minimal + non-graphic).
const PROHIBITED_TERMS = ['nazi', 'swastika', 'isis', 'kkk'];

function found(term: string, haystack: string): boolean {
  // word-ish boundary match to avoid substrings inside unrelated words
  const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
  return re.test(haystack);
}

export function scanText(text: string, channels: string[] = []): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];
  const h = ` ${text.toLowerCase()} `;

  for (const term of PROHIBITED_TERMS) {
    if (found(term, h)) {
      flags.push({
        severity: 'block',
        category: 'prohibited',
        finding: `Detected a prohibited term ("${term}"). This design should not be listed.`,
      });
    }
  }

  const hitTrademarks = TRADEMARK_TERMS.filter((t) => found(t, h));
  for (const term of hitTrademarks) {
    flags.push({
      severity: 'warn',
      category: 'trademark',
      finding: `Detected a possibly-trademarked term ("${term}"). Selling third-party IP without a license is a common takedown/legal risk.`,
    });
  }

  // Channel-specific note: Etsy's IP + handmade standards are strict.
  if (hitTrademarks.length && channels.some((c) => /etsy/i.test(c))) {
    flags.push({
      severity: 'warn',
      category: 'channel_specific',
      finding: 'Etsy enforces IP and creativity standards strictly; trademarked content is a frequent removal reason there.',
    });
  }

  return flags;
}
