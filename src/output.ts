// Output rule shared with the other CLIs: a table on a TTY, JSON when piped
// or when --json is passed. Data goes to stdout; messages go to stderr.

import Table from "cli-table3";

export function isJsonOutput(forceJson?: boolean): boolean {
  return Boolean(forceJson) || !process.stdout.isTTY;
}

export function printRows<T extends object>(rows: T[], columns: string[], forceJson?: boolean): void {
  if (isJsonOutput(forceJson)) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("(nothing on the watchlist yet)\n");
    return;
  }
  const table = new Table({ head: columns, wordWrap: true });
  for (const row of rows) {
    table.push(columns.map((c) => String((row as Record<string, unknown>)[c] ?? "")));
  }
  process.stdout.write(`${table.toString()}\n`);
}
