import { useMemo } from 'react'
import Papa from 'papaparse'

/** Rows rendered at most. fs_read_file caps a preview at 512 KiB (fs.rs:34),
 *  which still fits ~10k rows of a narrow CSV — enough <tr> to visibly stall
 *  the preview pane. Truncation is reported below the table, never silent. */
const MAX_ROWS = 2000

interface ParsedCsv {
  header: string[]
  body: string[][]
  columnCount: number
  totalRows: number
  errorMessage: string | null
}

function parseCsv(text: string): ParsedCsv {
  // Delimiter is auto-detected, so this also handles TSV and semicolon files
  // that happen to be named .csv.
  const result = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' })
  const rows = result.data.filter(row => Array.isArray(row))
  const [header = [], ...body] = rows
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  // Papa reports per-row problems but still returns the rows it managed to
  // read, so show the data and mention the damage rather than failing shut.
  const errorMessage = result.errors.length > 0
    ? `${result.errors.length} parse issue${result.errors.length === 1 ? '' : 's'}: ${result.errors[0].message}`
    : null
  return { header, body, columnCount, totalRows: rows.length, errorMessage }
}

/** Pad ragged rows so every row has the same cell count — CSVs in the wild are
 *  frequently short a trailing empty field, and an uneven <tr> misaligns the
 *  whole column under it. */
function cells(row: string[], columnCount: number): string[] {
  if (row.length >= columnCount) return row
  return [...row, ...Array<string>(columnCount - row.length).fill('')]
}

export function CsvPreview({ text }: { text: string }) {
  const { header, body, columnCount, errorMessage } = useMemo(() => parseCsv(text), [text])

  if (columnCount === 0) {
    return <div className="file-preview-status">Empty CSV</div>
  }

  const shown = body.slice(0, MAX_ROWS)
  const hidden = body.length - shown.length

  return (
    <div className="csv-preview">
      {errorMessage && <div className="csv-preview-warning">{errorMessage}</div>}
      <table className="csv-preview-table">
        <thead>
          <tr>
            <th className="csv-preview-rownum" />
            {cells(header, columnCount).map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {/* +2: header is row 1, and body rows start at row 2. */}
              <td className="csv-preview-rownum">{rowIndex + 2}</td>
              {cells(row, columnCount).map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <div className="csv-preview-truncated">
          {hidden.toLocaleString()} more row{hidden === 1 ? '' : 's'} not shown — switch to Source to see the raw file.
        </div>
      )}
    </div>
  )
}
