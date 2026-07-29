# MessageLoggerEnhanced v3.4

## Fixes

- Deleted messages no longer get placed above the message composer.
- The plugin first preserves the exact original DOM position.
- When jumping to an older deleted message, it inserts the entry chronologically between loaded Discord messages using message snowflake IDs.
- It never appends into an empty chat list or blindly attaches near the composer.

## Panel content filters

The main log panel now includes:

- All deleted content
- Text messages only
- Images only
- GIFs only

These filters work together with search, sorting and pagination.

## Installation

Replace your existing folder with:

`Vencord/src/userplugins/MessageLoggerEnhanced/`

Then run:

`pnpm build`

Restart Discord afterward.
