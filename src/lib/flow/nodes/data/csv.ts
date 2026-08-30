/**
 * Minimal RFC 4180 CSV parser. Hand-rolled rather than a dependency: the
 * grammar is small enough that pulling in a library for it would add more
 * supply-chain surface than it saves, unlike XLSX (a real binary format).
 * Handles quoted fields, embedded commas/newlines inside quotes, and "" as
 * an escaped quote. Does not handle non-comma delimiters or BOM stripping
 * beyond a leading UTF-8 BOM.
 */

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(text: string): string[][] {
  const input = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Final field/row, unless the input ended cleanly on a newline already flushed above.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows;
}

/** First row as headers, every subsequent row as a { header: value } object. */
export function csvToRowObjects(text: string): Record<string, string>[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const [header, ...dataRows] = table;
  return dataRows
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => {
      const obj: Record<string, string> = {};
      header.forEach((key, idx) => {
        obj[key || `column_${idx + 1}`] = r[idx] ?? "";
      });
      return obj;
    });
}
