# YAC GCD Scraper

 Desktop metadata workspace for a YACReader library and the Grand Comics Database (GCD) SQLite export.

See [Architecture and operations](docs/architecture-and-operations.md) for the component design, data lifecycle, matching and import rules, backup recovery, configuration, and development workflow.

## What it does

 - Hides Admin actions, path extraction, automatic matching, bulk edits, and GCD matching/enrichment controls by default. The toolbar's **Advanced tools** checkbox shows or hides them for the current session; normal browsing and comic-information editing remain available.
 - **Admin > Match > Map library to GCD** opens a two-pane mapping window. Navigate library folders and comics on the left and GCD publishers, series, and issues on the right. The detail boxes show each selected record's identifying metadata. **Save mapping and proposal** saves the association and full GCD proposal without writing library metadata. After saving a pair, **Map remaining folder by issue** links other comics directly in that library folder to uniquely matching issue numbers in the selected GCD series. To restrict matching, Shift-click a range or Command/Ctrl-click individual entries, then choose **Map selected entries by issue**. Modifier-clicks keep the saved pair as the mapping source; selections clear when changing folder, search, or page. Cover variants are canonicalized; ambiguous, missing, or invalid issue numbers are skipped. Existing links are preserved unless **Replace existing mappings** is checked. Use **Admin > Update > Apply update** to import proposed metadata afterward.
 - Reads the YACReader `library.ydb` database without changing it during browsing, searching, matching, and enrichment work.
 - Browses the folder hierarchy and comics with pagination, clickable path breadcrumbs, full-library navigation, text search, and metadata, reading-status, and publisher filters.
 - Loads production cover JPEGs from the `covers` directory beside `library.ydb`, using each comic's YACReader hash as the filename (for example, `<hash>.jpg`). Cards use a stable placeholder when a cover is missing.
 - Searches and ranks GCD issue candidates using editable title, issue, and volume parameters. Blank issue or volume parameters are omitted; a blank title falls back to the filename and path. Use `*` to match any sequence and `?` to match one character in any parameter.
 - Shows the number of stories on each GCD candidate, so multi-story issues are visible before import.
 - Combines credits, genres, characters, synopses, and notes from all non-deleted stories. Notes include issue notes; editors include issue and story editing; cover artists include pencils/inks from every cover. Structured story credits are included alongside legacy text credits. Duplicate values are removed without splitting narrative text.
 - Maps series issue count, series format, issue age rating, and series language code. Structured story-arc links supply arc names; for a single arc, arc number is the matched issue's position among linked non-variant issues ordered by key date, series, and sort code, and arc count is the number of those issues. These are catalog-derived values, not explicit printed part numbers or a guarantee of complete arc indexing. Multiple arcs supply names only.
 - Maps structured character appearances and groups to Characters and Teams, featured appearances to Main character or team, and issue/series/story tags to Tags. This GCD snapshot has no dedicated alternative numbering, series group, locations, or review source; those fields are not inferred from free-text notes and existing library values remain unchanged.
 - Selecting a GCD candidate updates the visible proposal. Saving the selected match updates its mapped YACReader metadata and retains the complete GCD proposal for review.
 - In **Map library to GCD**, series issues are sorted by ascending numeric issue number (including negative and decimal numbers), then GCD sort code, then issue ID. Sorting is applied before pagination. Numeric sorting uses SQLite's real-number conversion; nonnumeric labels convert to zero and numeric prefixes are used for labels such as `1A`.
 - Provides an **Edit comic information** dialog with the YACReader General information, Plot, Authors, Publishing, and Notes fields. Previous and next navigation follows the active List sort order. Saving makes a timestamped backup and updates the selected comic in one transaction; Cancel discards the pending form changes.
 - Displays sortable Series and Title columns in the library list. With **Advanced tools** enabled, **Select all rows** selects every row on the current list page, preserving the active comic where possible; it does not select records on other pages. Series, Title, Issue, Volume, and Publisher can be edited inline or through **Bulk edit** for selected comics. Bulk edit also supports Story arc, Arc number, Alternative series, and Alternative number. Issue, Volume, Arc number, and Alternative number can optionally auto-increment from the entered starting value in the current list order.
 - Stores proposals in a separate SQLite database under Electron's user-data directory.
 - **Admin > Update > Alter update** lists all stored proposals with row checkboxes. **Remove** deletes the checked proposals and their saved GCD links, then refreshes the list; **Close** dismisses the window. Existing YACReader metadata is not changed.
 - Exports and imports proposed data as a `yac-gcd-update-package/v1` JSON file keyed by YACReader `comic_info_id`.
 - Provides an **Apply updates** preview that can fill only blank, supported YACReader `comic_info` fields. It never overwrites an existing YACReader value and creates a timestamped SQLite backup before a single transactional update.
 - **Admin > Maintenance > Sync from GCD** scans the entire native library against the local GCD snapshot. It reuses saved GCD issue IDs where available; otherwise it requires exactly one score-100 candidate using native series, issue, and volume metadata with filename/path fallbacks. Missing or deleted saved IDs and ambiguous matches are skipped. The preview separates missing and differing metadata and shows current and proposed values. Missing fields are selected by default; **Replace differing metadata** explicitly opts into overwriting existing values, including manual edits. Applying creates a backup and updates only the previewed fields in one transaction. A value changed since preview causes the entire transaction to roll back; use **Rescan** before retrying.
 - Maps GCD's indicia publisher to YACReader Publisher and GCD's publisher to YACReader Imprint. When either GCD value is unavailable, the available value is used for both fields.
 - Accepts only numeric issue numbers, including decimal values such as `12.5`; placeholder values such as `[nn]` are not saved or imported.
 - **Auto-match all** processes the recursive Library folder and skips comics that already have proposals by default, so its progress count reflects only records pending processing. The selected folder also offers **Auto-match**, which can include or exclude child folders. Both actions use extracted filename issue numbers to reduce GCD candidates and load story details only for accepted exact matches. The confirmation dialog offers **Overwrite existing proposals** when replacement is intended. Use **Apply updates** afterward to review and safely import those proposals into YACReader.

YACReader stores characters, teams, locations, creator credits, and tags as plain text. Comma-separated values are preserved exactly as entered.

Manual-match saves, automatic-match proposals, and confirmed sync matches persist the association from YACReader `comic_info.id` to GCD `gcd_issue.id` in the app-side `enrichment.db` proposal's `gcdIssueId`. Sync saves confirmed links when its scan completes, even when metadata is already current or the update preview is cancelled; it does not overwrite existing proposals. Later proposal edits retain the link unless a replacement GCD ID is explicitly supplied. Subsequent syncs reuse saved links. Metadata writes to the YACReader library still require confirmation.

## Development

 ```sh
 npm install
 npm run rebuild:native
 npm run dev
 ```

 The default development paths are relative to this project:

 - `../../yac_data/yacreaderlibrary/library.ydb`
 - `../../yac_data/yacreaderlibrary/covers/<hash>.jpg`
 - `../../gcd_data/sqlite2026-09-01.db`

 Set either environment variable to use different data sources:

 ```sh
 YAC_GCD_LIBRARY_PATH=/path/to/library.ydb \
 YAC_GCD_DATABASE_PATH=/path/to/gcd.sqlite \
 npm run dev
 ```

Set `YAC_GCD_COVERS_PATH=/path/to/covers` when the cover directory is not next to the selected library database.

## Sync Tests

Run the metadata and matching tests with Electron's Node runtime so the native SQLite module uses the correct ABI:

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/*.test.mjs
```

## Packaging

 ```sh
 npm run package
 ```

The app is designed to preserve the original YACReader database. Direct updates require an explicit review and confirmation in the application. Close YACReader before applying updates so the library is not being modified by another process.
