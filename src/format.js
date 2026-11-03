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

/** How a section reads at a glance: what to fix, what can go, what is only informative. */
export const TONE = {
  error: c.red,
  remove: c.yellow,
  review: c.magenta,
  info: c.cyan,
};

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
 * A row is `{ kind?, id, levels?, detail?, note?, noteTone? }`: the id stands out, the kind and the
 * file or page it points to stay quiet. A note goes on its own line under the id.
 */
const formatRow = ({ kind, id, levels, detail, note, noteTone = c.dim }) => {
  const kindText = kind ? c.dim(kind.padEnd(KIND_WIDTH)) : '';
  const line = `  ${kindText}${c.bold(id)}  ${formatLevels(levels)}${detail ? c.dim(detail) : ''}`;
  return note ? `${line}\n  ${' '.repeat(kind ? KIND_WIDTH : 0)}${noteTone(note)}` : line;
};

export const printHeader = (lines, warnings = []) => {
  console.log(c.bold('Arc blocks audit'));
  for (const [label, value] of lines) console.log(`${c.dim(`${label}:`)} ${value}`);
  for (const text of warnings) console.log(c.yellow(`warning: ${text}`));
};

export const printSection = (title, tone, rows) => {
  const count = rows.length === 0 ? c.green('0') : tone(c.bold(rows.length));
  console.log(`\n${tone(c.bold('■'))} ${c.bold(title)} ${c.dim('(')}${count}${c.dim(')')}`);
  if (rows.length === 0) {
    console.log(`  ${c.green('nothing found')}`);
    return;
  }
  const sorted = [...rows].sort((a, b) => `${a.kind ?? ''}${a.id}`.localeCompare(`${b.kind ?? ''}${b.id}`));
  for (const row of sorted) console.log(formatRow(row));
};

// A quiet line under a section.
export const printNote = (text) => console.log(`  ${c.dim(text)}`);

export const printSummary = (items) => {
  console.log(`\n${c.bold('Summary')}`);
  for (const { label, count, tone } of items) {
    console.log(`  ${(count ? tone : c.green)(String(count).padStart(3))}  ${label}`);
  }
};
