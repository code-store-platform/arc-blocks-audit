// Plain ANSI colours, off when output is piped or NO_COLOR is set (https://no-color.org).
const enabled = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : process.stdout.isTTY && !process.env.NO_COLOR;

const style = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));

export const c = {
  bold: style(1, 22),
  dim: style(2, 22),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  blue: style(34, 39),
  magenta: style(35, 39),
  cyan: style(36, 39),
};

/**
 * How sure the audit is that a row can go. The label is printed on every row, so the
 * report reads the same without colours.
 *   candidate - nothing found anywhere: not in PageBuilder, not in code, not imported;
 *   check     - a trace found: a mention, an import, drafts only;
 *   info      - for reference, keep.
 */
export const HINT = { CANDIDATE: 'candidate', CHECK: 'check', INFO: 'info' };
const HINT_TONE = { candidate: c.red, check: c.yellow, info: c.dim };
const HINT_ORDER = Object.keys(HINT_TONE);
const HINT_WIDTH = 10;

/** Tone of a whole section: `error` is for what is broken, not a hint. */
export const TONE = { error: c.red, ...HINT_TONE };

const LEVEL_COLOUR = { live: c.green, draft: c.yellow, stashed: c.cyan };

const KIND_WIDTH = 8;

const LEVEL_ORDER = Object.keys(LEVEL_COLOUR);

const formatLevels = (levels) =>
  levels?.length
    ? `${c.dim('[')}${[...levels]
        .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))
        .map((level) => (LEVEL_COLOUR[level] ?? c.dim)(level))
        .join(c.dim(', '))}${c.dim(']')} `
    : '';

/**
 * A row is `{ hint?, kind?, id, levels?, detail?, note? }`: the hint and id stand out, the kind
 * and the file or page it points to stay quiet. A note goes on its own line under the id.
 */
const formatRow = ({ hint, kind, id, levels, detail, note }) => {
  const hintText = hint ? HINT_TONE[hint](hint.padEnd(HINT_WIDTH)) : '';
  const kindText = kind ? c.dim(kind.padEnd(KIND_WIDTH)) : '';
  const line = `  ${hintText}${kindText}${c.bold(id)}  ${formatLevels(levels)}${detail ? c.dim(detail) : ''}`;
  const indent = (hint ? HINT_WIDTH : 0) + (kind ? KIND_WIDTH : 0);
  return note ? `${line}\n  ${' '.repeat(indent)}${c.dim(note)}` : line;
};

export const printHeader = (lines, warnings = []) => {
  console.log(c.bold('Arc blocks audit'));
  console.log(`Hints, not errors. ${c.red('Red')} = nothing found anywhere, check by hand before removing.`);
  for (const [label, value] of lines) console.log(`${c.dim(`${label}:`)} ${value}`);
  for (const text of warnings) console.log(c.yellow(`warning: ${text}`));
};

// Strongest hint first, then rows on live pages, then by kind and id.
const rank = (row) => [
  row.hint ? HINT_ORDER.indexOf(row.hint) : 0,
  row.levels?.includes('live') ? 0 : 1,
  `${row.kind ?? ''}${row.id}`,
];
const compareRows = (a, b) => {
  const [x, y] = [rank(a), rank(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
};

/**
 * The marker takes the tone of the strongest hint in the section, or `tone` when given.
 * `loud` colours the title too, for what is broken rather than a hint.
 */
export const printSection = (title, rows, { tone, loud = false } = {}) => {
  const strongest = HINT_ORDER.find((hint) => rows.some((row) => row.hint === hint));
  const sectionTone = tone ?? HINT_TONE[strongest] ?? c.dim;
  const count = rows.length === 0 ? c.green('0') : sectionTone(c.bold(rows.length));
  const titleText = loud ? sectionTone(c.bold(title)) : c.bold(title);
  console.log(`\n${sectionTone(c.bold('■'))} ${titleText} ${c.dim('(')}${count}${c.dim(')')}`);
  if (rows.length === 0) {
    console.log(`  ${c.green('nothing found')}`);
    return;
  }
  for (const row of [...rows].sort(compareRows)) console.log(formatRow(row));
};

// A quiet line under a section, optionally labelled with a hint.
export const printNote = (text, hint) => console.log(`  ${hint ? HINT_TONE[hint](hint.padEnd(HINT_WIDTH)) : ''}${c.dim(text)}`);

export const printSummary = (items) => {
  console.log(`\n${c.bold('Summary')}`);
  for (const { label, count, tone } of items) {
    console.log(`  ${(count ? tone : c.green)(String(count).padStart(3))}  ${label}`);
  }
};
