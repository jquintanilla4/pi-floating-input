import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface FixedClusterInput {
  width: number;
  terminalRows: number;
  statusLines?: string[];
  editorLines: string[];
  infoLines?: string[];
}

export interface FixedClusterCursor {
  row: number;
  col: number;
}

export interface FixedClusterRender {
  lines: string[];
  cursor: FixedClusterCursor | null;
}

function normalize(lines: string[] | undefined, width: number): string[] {
  if (!lines) return [];
  return lines
    .filter((line) => line !== undefined && line !== null)
    .map((line) => visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line);
}

function capEditor(lines: string[], maxRows: number): string[] {
  if (lines.length <= maxRows) return lines;
  const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (cursorRow === -1) return lines.slice(-maxRows);
  const start = Math.max(0, Math.min(cursorRow - maxRows + 1, lines.length - maxRows));
  return lines.slice(start, start + maxRows);
}

function extractCursor(lines: string[]): FixedClusterRender {
  let cursor: FixedClusterCursor | null = null;
  const cleaned = lines.map((line, row) => {
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) return line;
    if (!cursor) cursor = { row, col: visibleWidth(line.slice(0, markerIndex)) };
    return line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
  });
  return { lines: cleaned, cursor };
}

export function renderFixedCluster(input: FixedClusterInput): FixedClusterRender {
  const width = Math.max(1, input.width);
  const maxRows = Math.max(1, Math.min(input.terminalRows - 1, 12));
  const status = normalize(input.statusLines, width);
  const editor = normalize(input.editorLines, width);
  const info = normalize(input.infoLines, width);

  const editorBudget = Math.max(1, maxRows - status.length - info.length);
  const cappedEditor = capEditor(editor, editorBudget);
  let lines = [...status, ...cappedEditor, ...info];
  if (lines.length > maxRows) lines = lines.slice(lines.length - maxRows);
  return extractCursor(lines);
}
