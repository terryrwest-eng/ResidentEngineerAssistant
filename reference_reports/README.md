# Reference reports & source documents

Real, finished reports and the raw documents they came from. Used to:

1. **Seed the project context pack** — crew names as actually spelled, sub
   companies, equipment fleet and unit numbers, recurring vocabulary. This is
   what stops dictation from mis-hearing "Salado" or "PRSI" every single day.
2. **Provide few-shot examples** — the prompts currently describe good writing
   with banned-word lists and no example of the target. These reports *are*
   the target.
3. **Test the backfill wizard** against real handwriting and real email PDFs
   rather than synthetic samples.

## What to drop here

| Folder | Contents |
|---|---|
| `finished/` | Completed daily reports (.docx) — the output standard |
| `timesheets/` | Photos/scans of handwritten contractor timesheets (.jpg/.png/.pdf) |
| `sub_emails/` | Subcontractor emails saved as PDF |

10–20 finished reports is plenty, and variety helps more than volume — different
crews, work types, and both day and night shifts.

Note: `*.pdf` is excluded by the root `.gitignore`; the local `.gitignore` here
re-allows it, so PDFs placed in this folder will commit normally.
