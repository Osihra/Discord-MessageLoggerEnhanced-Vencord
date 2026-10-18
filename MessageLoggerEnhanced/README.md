# MessageLoggerEnhanced v4 — extended preview

Standalone Vencord userplugin. Keeps old DataStore keys and existing logs.

Features: complete edit history viewer (all recorded versions), opt-in image/GIF caching in IndexedDB (100MB default, configurable), ignored user IDs, ghost ping labels and filter for mentions in deleted messages, author/channel/date filters, bookmarks, JSON backup and merge restore, storage size indicator, and pause logging. All controls are in the main panel.

## Important limitations

Media is cached only while URLs are accessible; cache entries may not download due to Discord attachment restrictions or CORS. The backup includes message logs and ordinary message cache, but not binary cached media. Ghost pings include direct mentions plus @everyone/@here and may include false positives. The edit timeline shows only edits seen by the plugin; older versions cannot be recovered retroactively. In-chat deleted message placement still depends on Discord DOM structure.

## Installation

Replace `Vencord/src/userplugins/MessageLoggerEnhanced` and run `pnpm build`, then reinstall/inject the build and restart Discord. **This source has not been build-tested against your installed Vencord commit**; if your build fails, send the terminal output.
