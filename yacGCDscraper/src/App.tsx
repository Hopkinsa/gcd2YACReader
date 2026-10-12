import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowUpDown,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Folder,
  Info,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import './App.css'
import MappingWindow from './MappingWindow'
import type { GcdProposal } from './library-api'

type FolderRecord = {
  id: number
  parentId: number
  name: string
  path: string
  numChildren: number | null
}

type Comic = {
  id: number
  comicInfoId: number
  fileName: string
  path: string
  title: string | null
  series: string | null
  number: string | null
  volume: string | null
  publisher: string | null
  date: string | null
  writer: string | null
  penciller: string | null
  inker: string | null
  colorist: string | null
  letterer: string | null
  storyArc: string | null
  arcNumber: string | null
  numPages: number | null
  read: number
  rating: number
  hash: string
  coverUrl: string | null
  proposedFields: Enrichment
  pendingFields: Enrichment
}

type LibraryData = {
  folders: FolderRecord[]
  comics: Comic[]
  total: number
  page: number
  pageSize: number
  publishers: string[]
  libraryPath: string
}

type Filters = {
  folderId: number
  page: number
  pageSize: number
  search: string
  metadata: string
  reading: string
  publisher: string
  gcdStatus: string
}

type Enrichment = Record<string, string>
type StoredMetadata = Record<string, unknown>
type EditorTab = 'general' | 'plot' | 'authors' | 'publishing' | 'notes' | 'matching'
type EditableMetadata = Record<string, string>
type MetadataTab = 'file' | 'proposed'

type Story = { id: number; type: string; sequenceNumber: number; title: string; feature: string; pageCount: string; script: string; pencils: string; inks: string; colors: string; letters: string; editing: string; genre: string; characters: string; synopsis: string; notes: string; firstLine: string }
type Match = { id: number; number: string; volume: string; title: string; onSaleDate: string; publicationDate: string; pageCount: string; seriesName: string; publisherName: string; indiciaPublisher: string; score: number; confident: boolean; stories: Story[]; proposedFields: Enrichment }
type ImportChange = { comicInfoId: number; fileName: string; enrichmentField: string; libraryField: string; value: string }
type ImportPlan = { proposedRecords: number; eligibleComics: number; changes: ImportChange[]; skippedExisting: number; skippedUnsupported: number; skippedInvalidIssue: number; missingComics: number; updatedFields?: number; backupPath?: string | null }
type GcdSyncChange = ImportChange & { previousValue: string | number | null }
type GcdSyncPlan = { planId: string; gcdSnapshot: string; scanned: number; matched: number; unmatched: number; failed: number; skippedUnsupported: number; missingChanges: GcdSyncChange[]; differingChanges: GcdSyncChange[] }
type GcdSyncProgress = { scanned: number; total: number; matched: number; unmatched: number; failed: number }
type GcdSyncResult = { updatedFields: number; updatedComics: number; backupPath: string | null }
type AutoMatchResult = { scanned: number; proposed: number; unmatched: number }
type AutoMatchProgress = { scanned: number; total: number; proposed: number; unmatched: number }
type PathExtractionResult = { scanned: number; updatedComics: number; updatedFields: number; skippedExisting: number; backupPath: string | null }
type PackageImportResult = { canceled: boolean; imported: number; filePath?: string }
type AutoMatchRefinement = { title: string; volume: string; publisher: string }
type AutoMatchTarget = { label: string; isLibrary: boolean; folderId?: number; comicInfoIds?: number[] }
type MatchParameters = { title: string; number: string; volume: string }
type LibrarySortField = 'path' | 'series' | 'title' | 'number' | 'volume' | 'publisher' | 'date'
type EditableRowField = 'series' | 'title' | 'number' | 'volume' | 'publisher'
type LibrarySort = { field: LibrarySortField; direction: 'ascending' | 'descending' }
type RowDrafts = Record<number, Partial<Record<EditableRowField, string>>>

const allComicsFolderId = 0
const libraryRootFolderId = 1

const enrichmentFields: ReadonlyArray<readonly [string, string, string]> = [
  ['series', 'Series', 'series'], ['title', 'Title', 'title'], ['issueNumber', 'Issue number', 'number'], ['issueCount', 'Issue count', 'count'],
  ['volume', 'Volume', 'volume'], ['onSaleDate', 'On-sale date', 'date'], ['publisher', 'Publisher', 'publisher'], ['imprint', 'Imprint', 'imprint'],
  ['editor', 'Editor', 'editor'], ['coverArtist', 'Cover artist', 'coverArtist'], ['crossoverArc', 'Story arc', 'storyArc'], ['crossoverPart', 'Arc number', 'arcNumber'], ['arcCount', 'Arc count', 'arcCount'],
  ['script', 'Writer', 'writer'], ['pencils', 'Penciller', 'penciller'], ['inks', 'Inker', 'inker'], ['colors', 'Colorist', 'colorist'], ['letters', 'Letterer', 'letterer'],
  ['storyGenre', 'Genre', 'genere'], ['storyCharacters', 'Characters', 'characters'], ['storySynopsis', 'Synopsis', 'synopsis'], ['storyNotes', 'Notes', 'notes'],
  ['alternateSeries', 'Alternative series', 'alternateSeries'], ['alternateNumber', 'Alternative number', 'alternateNumber'], ['alternateCount', 'Alternative count', 'alternateCount'],
  ['seriesGroup', 'Series group', 'seriesGroup'], ['teams', 'Teams', 'teams'], ['locations', 'Locations', 'locations'], ['mainCharacterOrTeam', 'Main character or team', 'mainCharacterOrTeam'],
  ['format', 'Format', 'format'], ['ageRating', 'Age rating', 'ageRating'], ['languageISO', 'Language (ISO)', 'languageISO'], ['review', 'Review', 'review'], ['tags', 'Tags', 'tags'],
]

function proposedEntries(fields: Enrichment = {}) {
  return enrichmentFields.flatMap(([field, label]) => fields[field]?.trim() ? [[label, fields[field]] as const] : [])
}

function ProposedUpdates({ fields, className = '' }: { fields: Enrichment; className?: string }) {
  const entries = proposedEntries(fields)
  if (!entries.length) return null
  return <section className={`proposed-updates ${className}`}><div className="proposed-updates-header"><span>Proposed updates</span><small>Not applied to YACReader</small></div><dl>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
}

function AlterUpdateDialog({ onClose, onRemoved }: { onClose: () => void; onRemoved: (comicInfoIds: number[]) => void }) {
  const api = window.libraryApi
  const [proposals, setProposals] = useState<GcdProposal[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.listProposals().then((rows) => { if (active) setProposals(rows) })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Could not load proposals.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api])

  const removeSelected = async () => {
    if (!selected.size || removing) return
    const comicInfoIds = [...selected]
    setRemoving(true)
    setError(null)
    try {
      await api.removeProposals(comicInfoIds)
      setProposals((current) => current.filter((proposal) => !selected.has(proposal.comicInfoId)))
      setSelected(new Set())
      onRemoved(comicInfoIds)
      setProposals(await api.listProposals())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove or refresh proposals.')
    } finally { setRemoving(false) }
  }

  return <div className="modal-backdrop"><section className="match-dialog alter-update-dialog" role="dialog" aria-modal="true" aria-labelledby="alter-update-title" aria-busy={loading || removing}>
    <header className="dialog-header"><h2 id="alter-update-title">Alter update</h2><span>{proposals.length.toLocaleString()} proposals</span></header>
    <div className="alter-update-body">
      {error && <p className="match-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading proposals...</p> : proposals.length ? <table className="alter-update-table">
        <thead><tr><th scope="col">Select</th><th scope="col">Comic</th><th scope="col">GCD issue</th><th scope="col">Proposed updates</th></tr></thead>
        <tbody>{proposals.map((proposal) => {
          const label = proposal.fileName || proposal.title || proposal.fields.title || `Comic info ID ${proposal.comicInfoId}`
          const entries = proposedEntries(proposal.fields)
          return <tr key={proposal.comicInfoId}>
            <td><input type="checkbox" aria-label={`Select proposal for ${label} (${proposal.comicInfoId})`} checked={selected.has(proposal.comicInfoId)} disabled={removing} onChange={(event) => {
              const checked = event.target.checked
              setSelected((current) => { const next = new Set(current); if (checked) next.add(proposal.comicInfoId); else next.delete(proposal.comicInfoId); return next })
            }} /></td>
            <td><b>{label}</b><small>{proposal.path || `Comic info ID ${proposal.comicInfoId}`}</small></td>
            <td>{proposal.fields.gcdIssueId || 'Not set'}</td>
            <td>{entries.length ? <details><summary>{entries.length} fields</summary><dl>{entries.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details> : 'No metadata fields'}</td>
          </tr>
        })}</tbody>
      </table> : <p role="status">No proposed updates.</p>}
    </div>
    <footer className="dialog-footer"><button className="secondary-button" type="button" disabled={loading || removing || !selected.size} onClick={() => void removeSelected()}><Trash2 size={16} />{removing ? 'Removing...' : 'Remove'}</button><button className="secondary-button" type="button" disabled={removing} onClick={onClose}>Close</button></footer>
  </section></div>
}

function LibraryProposalSummary({ comics }: { comics: Comic[] }) {
  const proposals = comics.map((comic) => ({ comic, entries: proposedEntries(comic.pendingFields) })).filter(({ entries }) => entries.length)
  if (!proposals.length) return null
  return <section className="library-proposals"><div className="proposed-updates-header"><span>{proposals.length} comics have proposed updates</span><small>Not applied to YACReader</small></div><div>{proposals.map(({ comic, entries }) => <article key={comic.id}><b>{comic.title || comic.fileName}</b><span>{entries.map(([label, value]) => `${label}: ${value}`).join(' | ')}</span></article>)}</div></section>
}

const allEditorTabs: { id: EditorTab; label: string }[] = [
  { id: 'general', label: 'General information' },
  { id: 'plot', label: 'Plot' },
  { id: 'authors', label: 'Authors' },
  { id: 'publishing', label: 'Publishing' },
  { id: 'notes', label: 'Notes' },
  { id: 'matching', label: 'GCD matching' },
]

const metadataTabs: { id: MetadataTab; label: string; fields: ReadonlyArray<readonly [string, string]> }[] = [
  { id: 'file', label: 'File', fields: [['comicId', 'Comic ID'], ['comicInfoId', 'Comic info ID'], ['folderId', 'Folder ID'], ['fileName', 'File name'], ['path', 'Path'], ['hash', 'Hash'], ['added', 'Added'], ['edited', 'Edited']] },
]

const editableMetadataDefaults: EditableMetadata = {
  series: '', title: '', number: '', count: '', volume: '', storyArc: '', arcNumber: '', arcCount: '', alternateSeries: '', alternateNumber: '', alternateCount: '', seriesGroup: '', genere: '',
  synopsis: '', characters: '', teams: '', locations: '', mainCharacterOrTeam: '',
  writer: '', penciller: '', inker: '', colorist: '', letterer: '', coverArtist: '', editor: '', imprint: '',
  day: '', month: '', year: '', publisher: '', format: '', color: '', ageRating: '', type: '', languageISO: '',
  review: '', notes: '', tags: '',
}

function editableMetadataFrom(metadata: StoredMetadata): EditableMetadata {
  const values = { ...editableMetadataDefaults }
  for (const field of Object.keys(values)) if (field in metadata && metadata[field] !== null && metadata[field] !== undefined) values[field] = String(metadata[field])
  const date = String(metadata.date ?? '')
  const isoDate = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const yacReaderDate = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/)
  if (isoDate) [values.year, values.month, values.day] = isoDate.slice(1)
  if (yacReaderDate) [values.day, values.month, values.year] = yacReaderDate.slice(1)
  values.color = metadata.color === null || metadata.color === undefined || metadata.color === '' ? '' : Number(metadata.color) === 1 ? '1' : '0'
  values.type = metadata.type === null || metadata.type === undefined || metadata.type === '' ? '' : Number.isInteger(Number(metadata.type)) ? String(metadata.type) : ''
  return values
}

function metadataSize(hash: unknown) {
  const bytes = Number(String(hash ?? '').slice(40))
  return Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : 'Not available'
}

function MetadataEditorField({ field, label, value, onChange, multiline = false }: { field: string; label: string; value: string; onChange: (field: string, value: string) => void; multiline?: boolean }) {
  return <label className="metadata-editor-field"><span>{label}</span>{multiline ? <textarea value={value} onChange={(event) => onChange(field, event.target.value)} /> : <input value={value} onChange={(event) => onChange(field, event.target.value)} />}</label>
}

function findEditorFooter() {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.metadata-editor-dialog > .dialog-footer')
}

function subscribeToEditorFooter(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

function EditorNavigationDock({ canGoPrevious, canGoNext, saving, onNavigate }: { canGoPrevious: boolean; canGoNext: boolean; saving: boolean; onNavigate: (offset: -1 | 1) => void }) {
  const footer = useSyncExternalStore(subscribeToEditorFooter, findEditorFooter, () => null)

  if (!footer) return null
  return createPortal(<div className="editor-navigation-dock"><button className="icon-button" type="button" title="Previous record" aria-label="Previous record" disabled={!canGoPrevious || saving} onClick={() => onNavigate(-1)}><ChevronLeft size={17} /></button><button className="icon-button" type="button" title="Next record" aria-label="Next record" disabled={!canGoNext || saving} onClick={() => onNavigate(1)}><ChevronRight size={17} /></button></div>, footer)
}

function GcdSyncChangeList({ changes, label }: { changes: GcdSyncChange[]; label: string }) {
  const [page, setPage] = useState(0)
  const pageSize = 50
  const pageCount = Math.max(1, Math.ceil(changes.length / pageSize))
  return <section className="gcd-sync-section">
    <header><h3>{label} ({changes.length.toLocaleString()})</h3>{pageCount > 1 && <nav aria-label={`${label} pages`}><button className="icon-button" type="button" title="Previous page" disabled={page === 0} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={16} /></button><span>{page + 1} / {pageCount}</span><button className="icon-button" type="button" title="Next page" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)}><ChevronRight size={16} /></button></nav>}</header>
    <div className="gcd-sync-list">{changes.slice(page * pageSize, (page + 1) * pageSize).map((change) => <article key={`${change.comicInfoId}-${change.libraryField}`}><b>{change.fileName}</b><span>{change.libraryField}</span><dl><div><dt>Current</dt><dd>{String(change.previousValue ?? '').trim() ? String(change.previousValue) : 'Empty'}</dd></div><div><dt>GCD</dt><dd>{change.value}</dd></div></dl></article>)}</div>
  </section>
}

function GcdSyncDialog({ plan, progress, result, busy, error, onClose, onScan, onApply }: { plan: GcdSyncPlan | null; progress: GcdSyncProgress | null; result: GcdSyncResult | null; busy: boolean; error: string | null; onClose: () => void; onScan: () => void; onApply: (replaceExisting: boolean) => void }) {
  const [replaceExisting, setReplaceExisting] = useState(false)
  const changes = plan ? [...plan.missingChanges, ...(replaceExisting ? plan.differingChanges : [])] : []
  const eligibleComics = new Set(changes.map((change) => change.comicInfoId)).size
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
    <section className="import-dialog gcd-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="gcd-sync-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialog-header"><div><p className="eyebrow">GCD SYNC</p><h2 id="gcd-sync-title">{result ? 'GCD sync complete' : busy && !plan ? 'Scanning library' : 'Review GCD metadata'}</h2></div><button className="dialog-close" type="button" title="Close GCD sync" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <div className="import-dialog-body">
        {busy && !plan && <div role="status"><progress aria-label="GCD sync progress" max={progress?.total || 1} value={progress?.scanned || 0} /><p>{progress ? `${progress.scanned.toLocaleString()} / ${progress.total.toLocaleString()} records scanned` : 'Preparing records...'}</p></div>}
        {result ? <div className="import-summary complete"><b>{result.updatedFields.toLocaleString()} fields updated across {result.updatedComics.toLocaleString()} comics.</b>{result.backupPath && <><span>Backup</span><code>{result.backupPath}</code></>}</div> : plan && <>
          <div className="import-summary"><b>{changes.length.toLocaleString()} fields across {eligibleComics.toLocaleString()} comics selected</b><span>GCD snapshot: {plan.gcdSnapshot}</span></div>
          <dl className="import-counts"><div><dt>Scanned</dt><dd>{plan.scanned.toLocaleString()}</dd></div><div><dt>Matched</dt><dd>{plan.matched.toLocaleString()}</dd></div><div><dt>Unmatched / skipped</dt><dd>{plan.unmatched.toLocaleString()}</dd></div><div><dt>Scan errors (included in skipped)</dt><dd>{plan.failed.toLocaleString()}</dd></div><div><dt>Unsupported fields</dt><dd>{plan.skippedUnsupported.toLocaleString()}</dd></div></dl>
          <label className="overwrite-toggle"><input type="checkbox" checked={replaceExisting} disabled={busy} onChange={(event) => setReplaceExisting(event.target.checked)} /><span>Replace differing metadata ({plan.differingChanges.length.toLocaleString()} fields)</span></label>
          {replaceExisting && <p className="match-error">Existing values, including manual edits, will be replaced with the reviewed GCD values.</p>}
          <p>Close YACReader before applying updates.</p>
          <GcdSyncChangeList changes={plan.missingChanges} label="Missing metadata" />
          <GcdSyncChangeList changes={plan.differingChanges} label={replaceExisting ? 'Differing metadata: selected' : 'Differing metadata: protected'} />
        </>}
        {error && <p className="match-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-footer"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button><button className="secondary-button" type="button" disabled={busy} onClick={onScan}><RefreshCw size={16} />Rescan</button>{!result && <button className="save-button" type="button" disabled={busy || !plan || !changes.length || Boolean(error)} onClick={() => onApply(replaceExisting)}>{busy ? 'Applying...' : replaceExisting ? 'Create backup and fill / replace' : 'Create backup and fill missing'}</button>}</footer>
    </section>
  </div>
}

function AutoMatchConfirmation({ target, onCancel, onContinue }: { target: AutoMatchTarget; onCancel: () => void; onContinue: (overwriteExisting: boolean, recursive: boolean, refinement?: AutoMatchRefinement) => void }) {
  const [overwriteExisting, setOverwriteExisting] = useState(false)
  const [recursive, setRecursive] = useState(true)
  const [useRefinement, setUseRefinement] = useState(false)
  const [refinement, setRefinement] = useState<AutoMatchRefinement>({ title: '', volume: '', publisher: '' })
  const isFileSelection = Boolean(target.comicInfoIds?.length)
  return <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="overwrite-dialog" role="alertdialog" aria-modal="true" aria-labelledby="overwrite-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialog-header"><div><p className="eyebrow">AUTO-MATCH</p><h2 id="overwrite-dialog-title">Match {target.label}?</h2></div><button className="dialog-close" type="button" title="Cancel automatic matching" onClick={onCancel}><X size={18} /></button></header>
      <div className="overwrite-dialog-body">
        <p>Exact GCD proposals will be generated for comics in {target.label}. Existing proposals are skipped by default.</p>
        {!target.isLibrary && !isFileSelection && <label className="overwrite-toggle"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /><span>Include child folders</span></label>}
        {isFileSelection && <label className="overwrite-toggle"><input type="checkbox" checked={useRefinement} onChange={(event) => setUseRefinement(event.target.checked)} /><span>Use matching refinements</span></label>}
        {isFileSelection && useRefinement && <div className="auto-match-refinement"><label>Series / title<input value={refinement.title} onChange={(event) => setRefinement((current) => ({ ...current, title: event.target.value }))} /></label><label>Volume<input value={refinement.volume} onChange={(event) => setRefinement((current) => ({ ...current, volume: event.target.value }))} /></label><label>Publisher<input value={refinement.publisher} onChange={(event) => setRefinement((current) => ({ ...current, publisher: event.target.value }))} /></label></div>}
        <label className="overwrite-toggle"><input type="checkbox" checked={overwriteExisting} onChange={(event) => setOverwriteExisting(event.target.checked)} /><span>Overwrite existing proposals</span></label>
      </div>
      <footer className="dialog-footer"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="auto-match-button" type="button" onClick={() => onContinue(overwriteExisting, target.isLibrary || isFileSelection || recursive, useRefinement ? refinement : undefined)}>Start matching</button></footer>
    </section>
  </div>
}

function PathExtractionConfirmation({ folderName, onCancel, onContinue }: { folderName: string; onCancel: () => void; onContinue: (overwriteExisting: boolean, recursive: boolean) => void }) {
  const [overwriteExisting, setOverwriteExisting] = useState(false)
  const [recursive, setRecursive] = useState(true)
  return <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="overwrite-dialog" role="alertdialog" aria-modal="true" aria-labelledby="path-extraction-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialog-header"><div><p className="eyebrow">PATH METADATA</p><h2 id="path-extraction-title">Extract data from {folderName}?</h2></div><button className="dialog-close" type="button" title="Cancel path extraction" onClick={onCancel}><X size={18} /></button></header>
      <div className="overwrite-dialog-body"><p>Series, title, issue, volume, story arcs, and alternate-series data are inferred from file names and paths. Review the folder naming convention before continuing.</p><label className="overwrite-toggle"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /><span>Include child folders</span></label><label className="overwrite-toggle"><input type="checkbox" checked={overwriteExisting} onChange={(event) => setOverwriteExisting(event.target.checked)} /><span>Overwrite existing metadata values</span></label></div>
      <footer className="dialog-footer"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="auto-match-button" type="button" onClick={() => onContinue(overwriteExisting, recursive)}>Extract metadata</button></footer>
    </section>
  </div>
}
 
 function AutoMatchProgressDialog({ progress }: { progress: AutoMatchProgress | null }) {
   const scanned = progress?.scanned ?? 0
   const total = progress?.total ?? 0
   const proposed = progress?.proposed ?? 0
   const percent = total ? Math.round((scanned / total) * 100) : 0
   return <div className="modal-backdrop auto-match-backdrop" role="presentation">
     <section className="auto-match-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-match-progress-title">
       <header className="dialog-header"><div><p className="eyebrow">AUTO-MATCH EXACT</p><h2 id="auto-match-progress-title">Applying exact matches</h2></div></header>
       <div className="auto-match-progress-body">
         <div className="auto-match-progress-track" role="progressbar" aria-label="Automatic matching progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={scanned}><span style={{ width: `${percent}%` }} /></div>
         <p>{total ? `${percent}% complete` : 'Preparing library records...'}</p>
         <dl className="auto-match-counts"><div><dt>Records processed</dt><dd>{scanned.toLocaleString()}</dd></div><div><dt>Records to process</dt><dd>{total.toLocaleString()}</dd></div><div><dt>Matches applied</dt><dd>{proposed.toLocaleString()}</dd></div></dl>
       </div>
     </section>
   </div>
 }

function FolderTree({ folders, selectedId, onSelect }: { folders: FolderRecord[]; selectedId: number; onSelect: (id: number) => void }) {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(() => new Set([libraryRootFolderId]))
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]))
  const childrenByParentId = new Map<number, FolderRecord[]>()
  folders.forEach((folder) => {
    if (folder.id === folder.parentId) return
    const children = childrenByParentId.get(folder.parentId) ?? []
    children.push(folder)
    childrenByParentId.set(folder.parentId, children)
  })
  const libraryRoot = foldersById.get(libraryRootFolderId) ?? { id: libraryRootFolderId, parentId: libraryRootFolderId, name: 'Library root', path: '', numChildren: null }

  useEffect(() => {
    const ancestorIds = new Set<number>()
    let folder = foldersById.get(selectedId)
    while (folder && folder.id !== libraryRootFolderId && folder.parentId !== folder.id) {
      ancestorIds.add(folder.parentId)
      folder = foldersById.get(folder.parentId)
    }
    if (ancestorIds.size) setExpandedFolderIds((current) => {
      const next = new Set(current)
      ancestorIds.forEach((id) => next.add(id))
      return next.size === current.size ? current : next
    })
  }, [folders, selectedId])

  const toggleFolder = (folderId: number) => setExpandedFolderIds((current) => {
    const next = new Set(current)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    return next
  })
  const renderFolder = (folder: FolderRecord, depth: number) => {
    const children = childrenByParentId.get(folder.id) ?? []
    const hasChildren = children.length > 0
    const expanded = expandedFolderIds.has(folder.id)
    return <li key={folder.id} role="treeitem" aria-level={depth + 1} aria-expanded={hasChildren ? expanded : undefined} aria-selected={folder.id === selectedId}>
      <div className="folder-tree-row" style={{ paddingLeft: `${7 + depth * 16}px` }}>
        {hasChildren ? <button className="tree-toggle" type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.name}`} aria-expanded={expanded} onClick={() => toggleFolder(folder.id)}><ChevronRight size={14} /></button> : <span className="tree-toggle spacer" aria-hidden="true" />}
        <button className={`folder-item ${folder.id === selectedId ? 'selected' : ''} ${folder.id === libraryRootFolderId ? 'library-root' : ''}`} onClick={() => onSelect(folder.id)} type="button"><Folder size={15} /><span title={folder.name}>{folder.name}</span></button>
      </div>
      {hasChildren && expanded && <ul className="folder-tree-children" role="group">{children.map((child) => renderFolder(child, depth + 1))}</ul>}
    </li>
  }

  return <nav className="folder-tree" aria-label="Library folders"><ul className="folder-tree-list" role="tree">{renderFolder(libraryRoot, 0)}</ul></nav>
}

function MatchReviewDialog({ reviewComic, matches, selectedMatch, matching, parameters, onParametersChange, onSearch, onSelectMatch, onSave, onClose }: { reviewComic: Comic; matches: Match[]; selectedMatch: Match | null; matching: boolean; parameters: MatchParameters; onParametersChange: (parameters: MatchParameters) => void; onSearch: () => void; onSelectMatch: (match: Match) => void; onSave: () => void; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="match-dialog" role="dialog" aria-modal="true" aria-labelledby="match-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialog-header"><div><p className="eyebrow">GCD MATCH REVIEW</p><h2 id="match-dialog-title">{reviewComic.title || reviewComic.fileName}</h2></div><button className="dialog-close" type="button" title="Close match review" onClick={onClose}><X size={18} /></button></header>
      <div className="match-review-controls"><label>Series / title<input value={parameters.title} onChange={(event) => onParametersChange({ ...parameters, title: event.target.value })} /></label><label>Issue<input value={parameters.number} onChange={(event) => onParametersChange({ ...parameters, number: event.target.value })} inputMode="decimal" /></label><label>Volume<input value={parameters.volume} onChange={(event) => onParametersChange({ ...parameters, volume: event.target.value })} inputMode="numeric" /></label><button className="auto-match-button" type="button" disabled={matching} onClick={onSearch}>{matching ? 'Searching...' : 'Search again'}</button></div>
      <div className="dialog-body"><nav className="candidate-list" aria-label="GCD candidates">{matches.map((match) => <button className={match.id === selectedMatch?.id ? 'active' : ''} type="button" key={match.id} onClick={() => onSelectMatch(match)}><b>{match.seriesName} #{match.number}</b><span>{match.publisherName || 'Unknown publisher'}</span><small>Score {match.score} | {match.stories.length} stories</small></button>)}</nav><div className="candidate-detail">{selectedMatch ? <><dl className="candidate-metadata"><div><dt>Series title</dt><dd>{selectedMatch.seriesName || 'Not listed'}</dd></div><div><dt>Issue number</dt><dd>{selectedMatch.number || 'Not listed'}</dd></div><div><dt>Issue title</dt><dd>{selectedMatch.title || 'Not listed'}</dd></div><div><dt>Volume</dt><dd>{selectedMatch.volume || 'Not listed'}</dd></div><div><dt>Publisher</dt><dd>{selectedMatch.publisherName || 'Not listed'}</dd></div><div><dt>Indicia publisher</dt><dd>{selectedMatch.indiciaPublisher || 'Not listed'}</dd></div><div><dt>On-sale date</dt><dd>{selectedMatch.onSaleDate || selectedMatch.publicationDate || 'Not listed'}</dd></div><div><dt>Pages</dt><dd>{selectedMatch.pageCount || 'Not listed'}</dd></div></dl><h3>Stories ({selectedMatch.stories.length})</h3>{selectedMatch.stories.length ? <div className="story-list">{selectedMatch.stories.map((story) => <article key={story.sequenceNumber}><b>{story.sequenceNumber}. {story.title || story.feature || 'Untitled story'}</b><span>{[['Script', story.script], ['Pencils', story.pencils], ['Inks', story.inks], ['Colors', story.colors], ['Letters', story.letters]].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(' | ') || 'No creator credits listed'}</span></article>)}</div> : <p className="no-stories">No story records are listed for this issue.</p>}</> : <p className="no-stories">No GCD candidates found for this record.</p>}</div></div>
      <footer className="dialog-footer" style={{ justifyContent: 'flex-end' }}><div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Close</button><button className="save-button" type="button" disabled={!selectedMatch || matching} onClick={onSave}>Save</button></div></footer>
    </section>
  </div>
}

function LibraryList({ comics, selectedComicIds, drafts, sort, onSort, onSelect, onDraftChange, onCommit, onContextMenu }: { comics: Comic[]; selectedComicIds: Set<number>; drafts: RowDrafts; sort: LibrarySort; onSort: (field: LibrarySortField) => void; onSelect: (comic: Comic, event: React.MouseEvent<HTMLElement>) => void; onDraftChange: (comic: Comic, field: EditableRowField, value: string) => void; onCommit: (comic: Comic, field: EditableRowField, value: string) => void; onContextMenu: (comic: Comic, event: React.MouseEvent<HTMLElement>) => void }) {
  const [pathTooltip, setPathTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Set<LibrarySortField>>(() => new Set(['path', 'series', 'title', 'number', 'volume', 'publisher', 'date']))
  const [columnWidths, setColumnWidths] = useState<Record<LibrarySortField, number>>({ path: 300, series: 220, title: 220, number: 84, volume: 84, publisher: 150, date: 100 })
  const columns: { field: LibrarySortField; label: string; minimumWidth: number }[] = [
    { field: 'path', label: 'File path', minimumWidth: 180 },
    { field: 'series', label: 'Series', minimumWidth: 140 },
    { field: 'title', label: 'Title', minimumWidth: 140 },
    { field: 'number', label: 'Issue', minimumWidth: 62 },
    { field: 'volume', label: 'Volume', minimumWidth: 68 },
    { field: 'publisher', label: 'Publisher', minimumWidth: 110 },
    { field: 'date', label: 'Date', minimumWidth: 84 },
  ]
  const displayedColumns = columns.filter(({ field }) => visibleColumns.has(field))
  const editableFields = new Set<LibrarySortField>(['series', 'title', 'number', 'volume', 'publisher'])
  const gridTemplateColumns = `${displayedColumns.map(({ field }) => `${columnWidths[field]}px`).join(' ')} 34px`
  const resizeColumn = (field: LibrarySortField, minimumWidth: number, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = columnWidths[field]
    const updateWidth = (moveEvent: PointerEvent) => setColumnWidths((current) => ({ ...current, [field]: Math.max(minimumWidth, startWidth + moveEvent.clientX - startX) }))
    const stopResizing = () => {
      window.removeEventListener('pointermove', updateWidth)
      window.removeEventListener('pointerup', stopResizing)
    }
    window.addEventListener('pointermove', updateWidth)
    window.addEventListener('pointerup', stopResizing)
  }
  const toggleColumn = (field: LibrarySortField) => setVisibleColumns((current) => {
    if (current.has(field) && current.size === 1) return current
    const next = new Set(current)
    if (next.has(field)) next.delete(field)
    else next.add(field)
    return next
  })
  return <section className="library-list" aria-label="Folder contents" style={{ '--library-list-width': `${displayedColumns.reduce((total, { field }) => total + columnWidths[field], 34)}px` } as React.CSSProperties}>
    <div className="library-list-header" role="row" style={{ gridTemplateColumns }}>{displayedColumns.map(({ field, label, minimumWidth }) => <div className="library-list-header-cell" key={field}><button type="button" className={sort.field === field ? 'active' : ''} onClick={() => onSort(field)}>{label}<ArrowUpDown size={13} /></button><span className="column-resizer" role="separator" aria-label={`Resize ${label} column`} aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => resizeColumn(field, minimumWidth, event)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setColumnWidths((current) => ({ ...current, [field]: Math.max(minimumWidth, current[field] + (event.key === 'ArrowLeft' ? -12 : 12)) })) } }} /></div>)}<div className="library-column-controls"><button className="row-actions" type="button" title="Choose visible columns" aria-label="Choose visible columns" aria-expanded={columnMenuOpen} onClick={() => setColumnMenuOpen((open) => !open)}><SlidersHorizontal size={16} /></button>{columnMenuOpen && <div className="column-menu" role="menu" aria-label="Visible columns">{columns.map(({ field, label }) => <label key={field}><input type="checkbox" checked={visibleColumns.has(field)} disabled={visibleColumns.has(field) && visibleColumns.size === 1} onChange={() => toggleColumn(field)} /><span>{label}</span></label>)}</div>}</div></div>
    <div className="library-list-rows">{comics.map((comic) => <div key={comic.id} className={`library-row ${selectedComicIds.has(comic.id) ? 'selected' : ''}`} style={{ gridTemplateColumns }} role="button" tabIndex={0} onClick={(event) => onSelect(comic, event)} onContextMenu={(event) => onContextMenu(comic, event)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(comic, event as unknown as React.MouseEvent<HTMLElement>) }}>
      {displayedColumns.map(({ field }) => editableFields.has(field) ? <input key={field} aria-label={`${field} for ${comic.title || comic.fileName}`} value={drafts[comic.id]?.[field as EditableRowField] ?? comic[field as EditableRowField] ?? ''} onClick={(event) => event.stopPropagation()} onChange={(event) => onDraftChange(comic, field as EditableRowField, event.target.value)} onBlur={(event) => onCommit(comic, field as EditableRowField, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') onDraftChange(comic, field as EditableRowField, comic[field as EditableRowField] ?? '') }} /> : field === 'path' ? <span key={field} className="path-cell" title={comic.path} onMouseEnter={(event) => setPathTooltip({ text: comic.path, x: event.clientX, y: event.clientY })} onMouseMove={(event) => setPathTooltip({ text: comic.path, x: event.clientX, y: event.clientY })} onMouseLeave={() => setPathTooltip(null)}>{comic.path}</span> : <span key={field}>{comic[field] || 'Not set'}</span>)}
      <button className="row-actions" type="button" title="Open row actions" aria-label="Open row actions" onClick={(event) => { event.stopPropagation(); onContextMenu(comic, event) }}><MoreHorizontal size={17} /></button>
    </div>)}</div>{pathTooltip && <div className="path-tooltip" role="tooltip" style={{ left: `${pathTooltip.x + 12}px`, top: `${pathTooltip.y + 16}px` }}>{pathTooltip.text}</div>}
  </section>
}

function BulkMetadataDialog({ comicCount, saving, error, onCancel, onSave }: { comicCount: number; saving: boolean; error: string | null; onCancel: () => void; onSave: (fields: Record<string, string>, incrementFields: string[]) => void }) {
  const fields: { id: EditableRowField; label: string; numeric?: boolean }[] = [{ id: 'series', label: 'Series' }, { id: 'title', label: 'Title' }, { id: 'number', label: 'Issue', numeric: true }, { id: 'volume', label: 'Volume', numeric: true }, { id: 'publisher', label: 'Publisher' }]
  const [enabled, setEnabled] = useState<Record<EditableRowField, boolean>>({ series: false, title: false, number: false, volume: false, publisher: false })
  const [values, setValues] = useState<Record<EditableRowField, string>>({ series: '', title: '', number: '', volume: '', publisher: '' })
  const [increments, setIncrements] = useState<Record<EditableRowField, boolean>>({ series: false, title: false, number: false, volume: false, publisher: false })
  const selectedFields = Object.fromEntries(fields.filter(({ id }) => enabled[id]).map(({ id }) => [id, values[id]]))
  const incrementFields = (Object.entries(increments) as ['number' | 'volume', boolean][]).filter(([field, checked]) => checked && enabled[field]).map(([field]) => field)
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => !saving && onCancel()}><section className="bulk-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-editor-title" onMouseDown={(event) => event.stopPropagation()}><header className="dialog-header"><div><p className="eyebrow">BULK METADATA</p><h2 id="bulk-editor-title">Edit {comicCount} selected comics</h2></div><button className="dialog-close" type="button" title="Cancel bulk edits" onClick={onCancel} disabled={saving}><X size={18} /></button></header><div className="bulk-editor-body">{error && <p className="match-error">{error}</p>}<p>Select the fields to overwrite. Incremented values are assigned in the current list order.</p>{fields.map(({ id, label, numeric }) => <div className="bulk-editor-field" key={id}><label><input type="checkbox" checked={enabled[id]} onChange={(event) => setEnabled((current) => ({ ...current, [id]: event.target.checked }))} /><span>{label}</span></label><input aria-label={`${label} value`} value={values[id]} disabled={!enabled[id]} inputMode={numeric ? 'decimal' : undefined} onChange={(event) => setValues((current) => ({ ...current, [id]: event.target.value }))} />{numeric && <label className="bulk-increment"><input type="checkbox" checked={increments[id]} disabled={!enabled[id]} onChange={(event) => setIncrements((current) => ({ ...current, [id]: event.target.checked }))} />Increment</label>}</div>)}</div><footer className="dialog-footer"><button className="secondary-button" type="button" onClick={onCancel} disabled={saving}>Cancel</button><button className="save-button editor-save-button" type="button" disabled={saving || !Object.keys(selectedFields).length} onClick={() => onSave(selectedFields, incrementFields)}>{saving ? 'Updating...' : 'Update comics'}</button></footer></section></div>
}

function HelpPage({ onClose }: { onClose: () => void }) {
  return <section className="help-page" role="dialog" aria-modal="true" aria-labelledby="help-page-title">
    <header className="help-page-header"><div><p className="eyebrow">YAC GCD SCRAPER</p><h1 id="help-page-title">Using your library</h1><p>Find, verify, and apply comic metadata without losing control of the YACReader library.</p></div><button className="icon-button" type="button" title="Close help" aria-label="Close help" onClick={onClose}><X size={18} /></button></header>
    <div className="help-page-body">
      <nav className="help-navigation" aria-label="Help topics"><a href="#help-browse">Browse</a><a href="#help-edit">Edit</a><a href="#help-match">Match</a><a href="#help-admin">Admin</a><a href="#help-safety">Safeguards</a></nav>
      <div className="help-content">
        <section id="help-browse"><p className="eyebrow">01 / BROWSE</p><h2>Find the comics you need</h2><div className="help-grid"><div><h3>Library panel</h3><p><b>All comics</b> searches the whole library. Use the chevrons under <b>Library root</b> to expand or collapse folders, then select a folder to limit the results to that folder.</p></div><div><h3>Search and filters</h3><p>The search box looks across filename, title, issue, publisher, creator, and series. The filter button exposes metadata, reading, GCD-status, and publisher filters; <b>Clear</b> restores the unfiltered list.</p></div><div><h3>List columns</h3><p>Series appears alongside title, issue, volume, publisher, and date. Select a header to sort, drag its divider to resize it, and use the control at the end of the header to choose visible columns.</p></div><div><h3>Views and selection</h3><p>Use the Folders, Covers, List, and Details controls to show the working areas you need. Select one comic for review; use Command-click and Shift-click to select several comics.</p></div></div></section>
        <section id="help-edit"><p className="eyebrow">02 / EDIT</p><h2>Correct library metadata</h2><div className="help-grid"><div><h3>Quick list edits</h3><p>In List view, edit title, issue, volume, or publisher directly in a row. Press Enter or move focus away to save the value.</p></div><div><h3>Full record editor</h3><p>Select a comic, then use the information button in its detail panel. The tabs organize general, plot, author, publishing, note, and matching fields. Previous and next follow the current List sort order. Save writes to the YACReader library and creates a backup first.</p></div><div><h3>Extract from paths</h3><p>When viewing a folder, use <b>Extract from paths</b> to infer series, title, numbering, volume, story arc, and alternate-series data. It fills only blank fields unless overwrite is selected.</p></div><div><h3>Pending updates</h3><p>Eligible proposed values appear in the library, Details, and editor before they are applied. A field is shown only when it can fill an empty supported YACReader value.</p></div><div><h3>Bulk edits</h3><p>With two or more comics selected, choose <b>Bulk edit</b>. Enable only the fields you intend to overwrite; issue and volume can be incremented in the current list order.</p></div></div></section>
        <section id="help-match"><p className="eyebrow">03 / GCD MATCHING</p><h2>Review before applying a match</h2><div className="help-grid"><div><h3>Manual match</h3><p>Enable <b>Advanced tools</b>, select a comic, and open its full record editor. Use the matching tab to enter its series title, issue, and optional volume. Select <b>Overwrite existing proposals</b> only when replacing a saved proposal. <b>Review candidates</b> lets you inspect the result before saving. Review navigation keeps the List sort order that was active when matching began.</p></div><div><h3>Canonical candidates</h3><p>Cover variants are grouped under their GCD root issue. When one canonical result is fully confident and every alternative is less confident, only that result is returned.</p></div><div><h3>Automatic match</h3><p><b>Auto-match</b> on a folder or selected comics saves only one unambiguous exact result. Existing proposals are skipped unless <b>Overwrite existing proposals</b> is selected. Selected-comic matching can use title, volume, and publisher refinements.</p></div><div><h3>Proposed data</h3><p>Saving a selected match through the editor updates its mapped YACReader fields and stores the complete proposal. Automatic matching and the Admin mapping window save proposals without changing library metadata. Credits, genre, characters, and synopsis combine all stories; notes combine issue and story notes. GCD format and rating populate Format and Age rating where available.</p></div></div></section>
        <section id="help-admin"><p className="eyebrow">04 / ADMIN MENU</p><h2>Manage mappings and proposals</h2><p><b>Advanced tools</b> is off on each launch. Enable it in the toolbar to access Admin, GCD matching, automatic matching, path extraction, and bulk edits.</p><div className="help-grid">
          <div><h3>Map library to GCD</h3><p>Open <b>Admin &gt; Match &gt; Map library to GCD</b>. Navigate library folders and comics on the left, ordered by file path A-Z without regard to case. Navigate GCD publishers, series, and issues on the right. The detail boxes show file path, series and issue titles, number, publisher, and date; GCD also shows Indicia Publisher and on-sale date.</p></div>
          <div><h3>Search GCD records</h3><p>Search matches publisher names, series titles, and issue titles from any navigation level, with issue numbers also searchable within a series. Library and GCD searches remain active while navigating folders, publishers, series, and breadcrumbs. Clear the corresponding search text box to remove its filter.</p></div>
          <div><h3>Save a mapping</h3><p>Select one library comic and one GCD issue, then choose <b>Save mapping and proposal</b>. This stores the persistent link between the comic info ID and GCD issue ID, together with the extracted metadata proposal. It does not change YACReader metadata; use <b>Apply updates</b> later. Enable <b>Replace existing mappings</b> only to replace a saved link and its proposal.</p></div>
          <div><h3>Map the remaining folder</h3><p>After saving the selected pair, choose <b>Map remaining folder by issue</b>. Only other comics directly in that library folder are considered, not child folders. Their normalized issue numbers are matched against the selected GCD series, with cover variants grouped under their root issue. Unmatched and ambiguous issues are skipped. Existing mappings are preserved unless replacement is enabled; the result reports saved and skipped records.</p></div>
        </div><dl className="help-menu-list"><div><dt>Auto-match all</dt><dd>Runs exact automatic matching across the library, including child folders, and saves proposals and persistent GCD links.</dd></div><div><dt>Apply updates</dt><dd>Previews eligible proposed fields, then writes only into empty supported YACReader fields.</dd></div><div><dt>Sync from GCD</dt><dd>Previews missing and differing metadata from linked or unambiguously matched GCD issues. Newly discovered links are saved even if the preview is cancelled. Existing library values are replaced only when replacement is explicitly enabled.</dd></div><div><dt>Export updates</dt><dd>Saves the current enrichment proposals as a portable JSON update package.</dd></div><div><dt>Import updates</dt><dd>Loads a previously exported JSON update package into the proposal store for review and application.</dd></div></dl></section>
        <section id="help-safety" className="help-safety"><p className="eyebrow">05 / SAFEGUARDS</p><h2>Your source data stays in charge</h2><p>Mappings and automatic proposals are stored separately from library metadata. Applying updates preserves existing YACReader values and skips unsupported or invalid fields; sync replaces existing values only with explicit permission. Library metadata writes create a timestamped backup before changes are committed. The GCD snapshot is read-only, and pending-update displays show only eligible values for empty supported fields.</p></section>
      </div>
    </div>
  </section>
}

function App() {
  const libraryApi = window.libraryApi
  const [filters, setFilters] = useState<Filters>({ folderId: allComicsFolderId, page: 1, pageSize: 120, search: '', metadata: 'all', reading: 'all', publisher: 'all', gcdStatus: 'all' })
  const [data, setData] = useState<LibraryData | null>(null)
  const [libraryRevision, setLibraryRevision] = useState(0)
  const [selectedComic, setSelectedComic] = useState<Comic | null>(null)
  const [selectedComicIds, setSelectedComicIds] = useState<Set<number>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null)
  const [enrichment, setEnrichment] = useState<Enrichment>({})
  const [enrichmentDetailsOpen, setEnrichmentDetailsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminSubmenu, setAdminSubmenu] = useState<'match' | 'update' | 'maintenance' | null>(null)
  const [advancedToolsVisible, setAdvancedToolsVisible] = useState(false)
  const [mappingWindowOpen, setMappingWindowOpen] = useState(false)
  const [alterUpdateOpen, setAlterUpdateOpen] = useState(false)
  const editorTabs = allEditorTabs.filter((tab) => advancedToolsVisible || tab.id !== 'matching')
  const adminActionsRef = useRef<HTMLDivElement>(null)
  const initializedSelectedComicIdRef = useRef<number | null>(null)
  const [matchParameters, setMatchParameters] = useState<MatchParameters>({ title: '', number: '', volume: '' })
  const [matches, setMatches] = useState<Match[]>([])
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null)
  const [matchDialogOpen, setMatchDialogOpen] = useState(false)
  const [reviewComic, setReviewComic] = useState<Comic | null>(null)
  const [reviewMatchParameters, setReviewMatchParameters] = useState<MatchParameters>({ title: '', number: '', volume: '' })
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false)
  const [metadataTab, setMetadataTab] = useState<MetadataTab>('file')
  const [storedMetadata, setStoredMetadata] = useState<StoredMetadata | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [editorDialogOpen, setEditorDialogOpen] = useState(false)
  const [editorTab, setEditorTab] = useState<EditorTab>('general')
  const [editorMetadata, setEditorMetadata] = useState<EditableMetadata>(editableMetadataDefaults)
  const [editorOriginal, setEditorOriginal] = useState<EditableMetadata>(editableMetadataDefaults)
  const [editorSize, setEditorSize] = useState('Not available')
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [editorMessage, setEditorMessage] = useState<string | null>(null)
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [gcdSyncOpen, setGcdSyncOpen] = useState(false)
  const [gcdSyncPlan, setGcdSyncPlan] = useState<GcdSyncPlan | null>(null)
  const [gcdSyncProgress, setGcdSyncProgress] = useState<GcdSyncProgress | null>(null)
  const [gcdSyncResult, setGcdSyncResult] = useState<GcdSyncResult | null>(null)
  const [gcdSyncBusy, setGcdSyncBusy] = useState(false)
  const [gcdSyncError, setGcdSyncError] = useState<string | null>(null)
  const [autoMatching, setAutoMatching] = useState(false)
  const [autoMatchProgress, setAutoMatchProgress] = useState<AutoMatchProgress | null>(null)
  const [autoMatchMessage, setAutoMatchMessage] = useState<string | null>(null)
  const [autoMatchConfirmationOpen, setAutoMatchConfirmationOpen] = useState(false)
  const [autoMatchTarget, setAutoMatchTarget] = useState<AutoMatchTarget | null>(null)
  const [pathExtractionConfirmationOpen, setPathExtractionConfirmationOpen] = useState(false)
  const [pathExtracting, setPathExtracting] = useState(false)
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [overwriteExistingProposals, setOverwriteExistingProposals] = useState(false)
  const [panels, setPanels] = useState({ folders: true, covers: true, list: true, details: true })
  const [librarySort, setLibrarySort] = useState<LibrarySort>({ field: 'path', direction: 'ascending' })
  const [rowDrafts, setRowDrafts] = useState<RowDrafts>({})
  const [rowContext, setRowContext] = useState<{ comic: Comic; x: number; y: number } | null>(null)
  const [bulkEditorOpen, setBulkEditorOpen] = useState(false)
  const [bulkEditorSaving, setBulkEditorSaving] = useState(false)
  const [bulkEditorError, setBulkEditorError] = useState<string | null>(null)
  const [editorNavigationTarget, setEditorNavigationTarget] = useState<Comic | null>(null)
  const sortedComics = [...(data?.comics ?? [])].sort((left, right) => {
    const comparison = String(left[librarySort.field] ?? '').localeCompare(String(right[librarySort.field] ?? ''), undefined, { numeric: true, sensitivity: 'base' })
    return librarySort.direction === 'ascending' ? comparison : -comparison
  })

  useEffect(() => {
    let cancelled = false
    if (!libraryApi) {
      setError('The desktop bridge is unavailable. Start this application with "npm run dev" from code/yacGCDscraper, rather than opening the Vite URL in a browser.')
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    libraryApi.loadLibrary(filters).then((result) => {
      const libraryData = result as LibraryData
      if (!cancelled) {
        setData(libraryData)
        setSelectedComic((current) => libraryData.comics.find((comic) => comic.id === current?.id) ?? null)
        setError(null)
      }
    }).catch((loadError: Error) => !cancelled && setError(loadError.message)).finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [filters, libraryApi, libraryRevision])

  useEffect(() => {
    if (!selectedComic || !libraryApi) {
      initializedSelectedComicIdRef.current = null
      return
    }
    if (initializedSelectedComicIdRef.current === selectedComic.id) return
    initializedSelectedComicIdRef.current = selectedComic.id
    setEnrichment(selectedComic.pendingFields ?? {})
    setMatches([])
    setSelectedMatch(null)
    setMatchDialogOpen(false)
    setReviewComic(null)
    setMetadataDialogOpen(false)
    setMetadataTab('file')
    setStoredMetadata(null)
    setMatchParameters({ title: selectedComic.title ?? '', number: selectedComic.number ?? '', volume: selectedComic.volume ?? '' })
    setMatchError(null)
    setOverwriteExistingProposals(false)
  }, [selectedComic, libraryApi])

  useEffect(() => {
    if (!adminOpen) return
    const closeMenu = (event: PointerEvent) => {
      if (!adminActionsRef.current?.contains(event.target as Node)) setAdminOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdminOpen(false)
    }
    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [adminOpen])

  useEffect(() => {
    if (!libraryApi) return
    return libraryApi.onAutoMatchProgress((progress: AutoMatchProgress) => {
      setAutoMatchProgress(progress)
      const percent = progress.total ? Math.round((progress.scanned / progress.total) * 100) : 100
      setAutoMatchMessage(`Matching ${progress.scanned.toLocaleString()} of ${progress.total.toLocaleString()} comics (${percent}%). ${progress.proposed.toLocaleString()} exact matches found.`)
    })
  }, [libraryApi])

  useEffect(() => {
    if (!autoMatchMessage) return
    const dismiss = () => setAutoMatchMessage(null)
    const timeout = window.setTimeout(dismiss, 5_000)
    window.addEventListener('pointerdown', dismiss, { capture: true })
    window.addEventListener('keydown', dismiss, { capture: true })
    window.addEventListener('focusin', dismiss, { capture: true })
    window.addEventListener('wheel', dismiss, { capture: true })
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('pointerdown', dismiss, { capture: true })
      window.removeEventListener('keydown', dismiss, { capture: true })
      window.removeEventListener('focusin', dismiss, { capture: true })
      window.removeEventListener('wheel', dismiss, { capture: true })
    }
  }, [autoMatchMessage])

  const selectedFolder = data?.folders.find((folder) => folder.id === filters.folderId)
  const updateFilter = (updates: Partial<Filters>) => setFilters((current) => ({ ...current, ...updates, page: 'page' in updates ? updates.page ?? current.page : 1 }))
  const selectFolder = (folderId: number) => {
    setSelectedComic(null)
    setSelectedComicIds(new Set())
    setSelectionAnchorId(null)
    updateFilter({ folderId })
  }
  const saveEnrichment = async () => {
    if (!selectedComic || !libraryApi) return
    await libraryApi.saveEnrichment(selectedComic.comicInfoId, enrichment)
  }
  const searchMatches = async (comic: Comic, parameters: MatchParameters, openReview = false) => {
    if (!libraryApi) return
    setMatching(true)
    try {
      const foundMatches = await libraryApi.findMatches(comic, parameters) as Match[]
      setMatches(foundMatches)
      setSelectedMatch(foundMatches[0] ?? null)
      if (openReview) setMatchDialogOpen(true)
      setMatchError(null)
    } catch (searchError) {
      setMatchError(searchError instanceof Error ? searchError.message : 'Could not query the GCD database.')
    } finally { setMatching(false) }
  }
  const findMatches = async () => {
    if (!selectedComic || !libraryApi) return
    setReviewComic(selectedComic)
    setReviewMatchParameters(matchParameters)
    await searchMatches(selectedComic, matchParameters, true)
  }
  const searchReviewMatches = async () => {
    if (!reviewComic) return
    await searchMatches(reviewComic, reviewMatchParameters, true)
  }
  const closeMatchReview = () => {
    setMatchDialogOpen(false)
    setReviewComic(null)
    setReviewMatchParameters({ title: '', number: '', volume: '' })
    setMatchParameters({ title: '', number: '', volume: '' })
  }
  const applyMatch = async (match: Match, comic = selectedComic, overwriteExisting = false) => {
    if (!comic || !libraryApi) return
    if (Object.keys(comic.proposedFields ?? {}).length && !overwriteExisting) {
      setMatchError('This comic already has a proposed GCD record. Select Overwrite existing proposals before saving a replacement.')
      return
    }
    const fields = match.proposedFields
    try {
      const libraryFields = Object.fromEntries(enrichmentFields
        .map(([source, , destination]) => [destination, fields[source]])
        .filter(([, value]) => Boolean(value?.trim())))
      if (Object.keys(libraryFields).length) await libraryApi.updateComicMetadata(comic.comicInfoId, libraryFields)
      await libraryApi.saveEnrichment(comic.comicInfoId, fields)
      setData((current) => current ? {
        ...current,
        comics: current.comics.map((candidate) => candidate.id === comic.id ? { ...candidate, ...libraryFields, proposedFields: fields, pendingFields: {} } : candidate),
      } : current)
      if (selectedComic?.id === comic.id) {
        setEnrichment({})
        setEditorMetadata((current) => ({ ...current, ...libraryFields }))
        setEditorOriginal((current) => ({ ...current, ...libraryFields }))
      }
      setAutoMatchMessage('Selected GCD match saved to the library and proposal store.')
      setLibraryRevision((revision) => revision + 1)
      closeMatchReview()
    } catch (saveError) {
      setMatchError(saveError instanceof Error ? saveError.message : 'The selected GCD record could not be saved.')
    }
  }
  const openMetadataEditor = async (comic = selectedComic) => {
    if (!comic || !libraryApi) return
    setEditorDialogOpen(true)
    setMetadataLoading(true)
    setEditorError(null)
    setEditorMessage(null)
    try {
      const metadata = await libraryApi.getComicMetadata(comic.id)
      if (!metadata) throw new Error('The selected comic could not be found in the library.')
      const stored = metadata as StoredMetadata
      const values = editableMetadataFrom(stored)
      setEditorMetadata(values)
      setEditorOriginal(values)
      setEnrichment(comic.pendingFields ?? {})
      const proposals = proposedEntries(comic.pendingFields ?? {})
      if (proposals.length) setEditorMessage(`Proposed updates not yet applied: ${proposals.map(([label, value]) => `${label}: ${value}`).join(' | ')}`)
      setEditorSize(metadataSize(stored.hash))
      setEditorTab('general')
    } catch (metadataError) {
      setEditorError(metadataError instanceof Error ? metadataError.message : 'Comic metadata could not be loaded.')
    } finally { setMetadataLoading(false) }
  }
  const updateEditorMetadata = (field: string, value: string) => {
    setEditorMessage(null)
    setEditorMetadata((current) => ({ ...current, [field]: value }))
  }
  const saveComicMetadata = async () => {
    if (!selectedComic || !libraryApi) return false
    const { day, month, year, color, type, ...fields } = editorMetadata
    const includesDate = Boolean(day || month || year)
    const validDate = !includesDate || (Number.isInteger(Number(day)) && Number(day) >= 1 && Number(day) <= 31 && Number.isInteger(Number(month)) && Number(month) >= 1 && Number(month) <= 12 && Number.isInteger(Number(year)) && Number(year) >= 1 && Number(year) <= 9999)
    if (!validDate) {
      setEditorError('Enter a complete valid day, month, and year, or leave all three date fields blank.')
      return false
    }
    setEditorSaving(true)
    setEditorError(null)
    try {
      const updates: Record<string, unknown> = {
        ...fields,
        date: includesDate ? `${day}/${month}/${year}` : '',
      }
      if (color) updates.color = color === '1'
      if (type) updates.type = Number(type)
      const result = await libraryApi.updateComicMetadata(selectedComic.comicInfoId, updates)
      setAutoMatchMessage(`Changes saved. Backup created at ${result.backupPath}`)
      setEditorOriginal(editorMetadata)
      setLibraryRevision((revision) => revision + 1)
      return true
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : 'Comic metadata could not be saved.')
      return false
    } finally { setEditorSaving(false) }
  }
  const editorHasChanges = JSON.stringify(editorMetadata) !== JSON.stringify(editorOriginal)
  const editorComicIndex = selectedComic ? sortedComics.findIndex((comic) => comic.id === selectedComic.id) : -1
  const moveEditorToComic = (comic: Comic) => {
    setSelectedComic(comic)
    setSelectedComicIds(new Set([comic.id]))
    setSelectionAnchorId(comic.id)
    void openMetadataEditor(comic)
  }
  const requestEditorNavigation = (offset: -1 | 1) => {
    const target = sortedComics[editorComicIndex + offset]
    if (!target) return
    if (editorHasChanges) setEditorNavigationTarget(target)
    else moveEditorToComic(target)
  }
  const resolveEditorNavigation = async (saveChanges: boolean) => {
    const target = editorNavigationTarget
    if (!target) return
    if (saveChanges && !await saveComicMetadata()) return
    setEditorNavigationTarget(null)
    moveEditorToComic(target)
  }
  useEffect(() => libraryApi?.onGcdSyncProgress(setGcdSyncProgress), [libraryApi])

  const showGcdSyncPreview = async () => {
    if (!libraryApi) return
    setAdminOpen(false)
    setMappingWindowOpen(false)
    setGcdSyncOpen(true)
    setGcdSyncBusy(true)
    setGcdSyncPlan(null)
    setGcdSyncProgress(null)
    setGcdSyncResult(null)
    setGcdSyncError(null)
    try {
      setGcdSyncPlan(await libraryApi.previewGcdSync() as GcdSyncPlan)
    } catch (syncError) {
      setGcdSyncError(syncError instanceof Error ? syncError.message : 'Could not preview GCD metadata.')
    } finally { setGcdSyncBusy(false) }
  }
  const applyGcdSync = async (replaceExisting: boolean) => {
    if (!libraryApi || !gcdSyncPlan) return
    setGcdSyncBusy(true)
    setGcdSyncError(null)
    try {
      const result = await libraryApi.applyGcdSync({ planId: gcdSyncPlan.planId, replaceExisting })
      setGcdSyncResult(result)
      if (result.updatedFields) setLibraryRevision((revision) => revision + 1)
    } catch (syncError) {
      setGcdSyncError(syncError instanceof Error ? syncError.message : 'Could not apply GCD metadata.')
    } finally { setGcdSyncBusy(false) }
  }
  const showImportPreview = async () => {
    if (!libraryApi) return
    setImportError(null)
    try {
      setImportPlan(await libraryApi.previewImport() as ImportPlan)
      setImportDialogOpen(true)
    } catch (previewError) {
      setImportError(previewError instanceof Error ? previewError.message : 'Could not inspect proposed changes.')
    }
  }
  const applyImport = async () => {
    if (!libraryApi) return
    setImporting(true)
    setImportError(null)
    try {
      const completedPlan = await libraryApi.importEnrichment() as ImportPlan
      setImportPlan(completedPlan)
      if (completedPlan.updatedFields) setLibraryRevision((revision) => revision + 1)
    } catch (applyError) {
      setImportError(applyError instanceof Error ? applyError.message : 'Could not update the YACReader library.')
    } finally { setImporting(false) }
  }
  const importUpdatePackage = async () => {
    if (!libraryApi) return
    setAdminOpen(false)
    try {
      const result = await libraryApi.importEnrichmentPackage() as PackageImportResult
      if (!result.canceled) {
        setAutoMatchMessage(`${result.imported.toLocaleString()} proposed updates imported. Review them with Apply updates.`)
        setLibraryRevision((revision) => revision + 1)
      }
    } catch (importPackageError) {
      setAutoMatchMessage(importPackageError instanceof Error ? importPackageError.message : 'Could not import the update package.')
    }
  }
  const autoMatchExact = async (target: AutoMatchTarget, overwriteExisting = false, recursive = true, refinement?: AutoMatchRefinement) => {
    if (!libraryApi) return
    setAutoMatching(true)
    setAutoMatchProgress(null)
    setAutoMatchMessage('Preparing automatic matching...')
    try {
      const result = await libraryApi.autoMatchExact({ folderId: target.folderId, comicInfoIds: target.comicInfoIds, recursive, overwriteExisting, refinement }) as AutoMatchResult
      setAutoMatchMessage(`${result.proposed} exact matches ${overwriteExisting ? 'overwritten' : 'saved'} from ${result.scanned} comics queued for processing. ${result.unmatched} comics were skipped.`)
      setLibraryRevision((revision) => revision + 1)
    } catch (autoMatchError) {
      setAutoMatchMessage(autoMatchError instanceof Error ? autoMatchError.message : 'Automatic matching could not complete.')
    } finally { setAutoMatching(false) }
  }
  const extractPathMetadata = async (folderId: number, overwriteExisting: boolean, recursive: boolean) => {
    if (!libraryApi) return
    setPathExtracting(true)
    setAutoMatchMessage('Extracting metadata from file paths...')
    try {
      const result = await libraryApi.extractPathMetadata({ folderId, overwriteExisting, recursive }) as PathExtractionResult
      const backupMessage = result.backupPath ? ` Backup created at ${result.backupPath}` : ''
      setAutoMatchMessage(`Extracted ${result.updatedFields} fields across ${result.updatedComics} comics from ${result.scanned} scanned. ${result.skippedExisting} existing values were preserved.${backupMessage}`)
      setLibraryRevision((revision) => revision + 1)
    } catch (extractionError) {
      setAutoMatchMessage(extractionError instanceof Error ? extractionError.message : 'Path metadata extraction could not complete.')
    } finally { setPathExtracting(false) }
  }
  const presentValue = (value: unknown, available = true) => {
    if (!available) return 'Not available in this database'
    if (value === null || value === undefined || value === '') return 'Not set'
    if (typeof value === 'number' && (value === -1 || value === 0)) return String(value)
    return String(value)
  }
  const activeMetadataTab = metadataTabs.find((tab) => tab.id === metadataTab)!
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const folderBreadcrumbs = (() => {
    if (!data || filters.folderId <= libraryRootFolderId) return []
    const foldersById = new Map(data.folders.map((folder) => [folder.id, folder]))
    const breadcrumbs: FolderRecord[] = []
    let folder = foldersById.get(filters.folderId)
    while (folder && folder.id !== 1) {
      breadcrumbs.unshift(folder)
      folder = foldersById.get(folder.parentId)
    }
    return breadcrumbs
  })()
  const openAutoMatch = (target: AutoMatchTarget) => {
    setAdminOpen(false)
    setAutoMatchTarget(target)
    setAutoMatchConfirmationOpen(true)
  }
  const selectComic = (comic: Comic, event: React.MouseEvent<HTMLElement>) => {
    const comics = data?.comics ?? []
    if (event.shiftKey && selectionAnchorId !== null) {
      const anchorIndex = comics.findIndex((candidate) => candidate.id === selectionAnchorId)
      const comicIndex = comics.findIndex((candidate) => candidate.id === comic.id)
      if (anchorIndex >= 0 && comicIndex >= 0) {
        const [start, end] = [anchorIndex, comicIndex].sort((left, right) => left - right)
        setSelectedComicIds(new Set(comics.slice(start, end + 1).map((candidate) => candidate.id)))
        setSelectedComic(comic)
        return
      }
    }
    if (!event.metaKey && !event.ctrlKey) {
      setSelectedComicIds(new Set([comic.id]))
      setSelectionAnchorId(comic.id)
      setSelectedComic(comic)
      return
    }
    const next = new Set(selectedComicIds)
    if (next.has(comic.id)) next.delete(comic.id)
    else next.add(comic.id)
    setSelectedComicIds(next)
    setSelectionAnchorId(comic.id)
    setSelectedComic(next.has(comic.id) ? comic : data?.comics.find((candidate) => next.has(candidate.id)) ?? null)
  }
  const updateLibrarySort = (field: LibrarySortField) => setLibrarySort((current) => current.field === field ? { field, direction: current.direction === 'ascending' ? 'descending' : 'ascending' } : { field, direction: 'ascending' })
  const updateRowDraft = (comic: Comic, field: EditableRowField, value: string) => setRowDrafts((current) => ({ ...current, [comic.id]: { ...current[comic.id], [field]: value } }))
  const clearRowDraft = (comic: Comic, field: EditableRowField) => setRowDrafts((current) => {
    const next = { ...current }
    const { [field]: _removed, ...remaining } = next[comic.id] ?? {}
    if (Object.keys(remaining).length) next[comic.id] = remaining
    else delete next[comic.id]
    return next
  })
  const commitRowEdit = async (comic: Comic, field: EditableRowField, value: string) => {
    if (value === String(comic[field] ?? '')) {
      clearRowDraft(comic, field)
      return
    }
    if (!libraryApi) return
    try {
      await libraryApi.updateComicMetadata(comic.comicInfoId, { [field]: value })
      clearRowDraft(comic, field)
      setAutoMatchMessage(`${field === 'number' ? 'Issue number' : field[0].toUpperCase() + field.slice(1)} updated.`)
      setLibraryRevision((revision) => revision + 1)
    } catch (updateError) {
      setMatchError(updateError instanceof Error ? updateError.message : 'The library field could not be updated.')
    }
  }
  const saveBulkMetadata = async (fields: Record<string, string>, incrementFields: string[]) => {
    if (!libraryApi || !selectedComics.length) return
    setBulkEditorSaving(true)
    setBulkEditorError(null)
    try {
      const result = await libraryApi.bulkUpdateComicMetadata(selectedComics.map((comic) => comic.comicInfoId), fields, incrementFields)
      setBulkEditorOpen(false)
      setAutoMatchMessage(`${result.updatedComics} comics updated. Backup created at ${result.backupPath}`)
      setLibraryRevision((revision) => revision + 1)
    } catch (bulkError) {
      setBulkEditorError(bulkError instanceof Error ? bulkError.message : 'The selected comics could not be updated.')
    } finally { setBulkEditorSaving(false) }
  }
  const openRowContext = (comic: Comic, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    setRowContext({ comic, x: event.clientX, y: event.clientY })
  }
  const selectedComics = data?.comics.filter((comic) => selectedComicIds.has(comic.id)) ?? []
  const selectedAutoMatchTarget = selectedComics.length ? { label: `${selectedComics.length} selected ${selectedComics.length === 1 ? 'file' : 'files'}`, isLibrary: false, comicInfoIds: selectedComics.map((comic) => comic.comicInfoId) } : null

  const toggleAdvancedTools = (visible: boolean) => {
    setAdvancedToolsVisible(visible)
    if (visible) return
    setAdminOpen(false)
    setBulkEditorOpen(false)
    setAlterUpdateOpen(false)
    setPathExtractionConfirmationOpen(false)
    setAutoMatchConfirmationOpen(false)
    setAutoMatchTarget(null)
    setMatchDialogOpen(false)
    setReviewComic(null)
    setImportDialogOpen(false)
    setGcdSyncOpen(false)
    setEnrichmentDetailsOpen(false)
    setEditorTab((current) => current === 'matching' ? 'general' : current)
  }

  return (
    <main className={`app-shell ${advancedToolsVisible ? '' : 'advanced-tools-hidden'} ${panels.folders ? '' : 'folders-hidden'} ${panels.covers ? '' : 'covers-hidden'} ${panels.list ? '' : 'list-hidden'} ${panels.details ? '' : 'details-hidden'}`}>
      {advancedToolsVisible && mappingWindowOpen && <MappingWindow FolderTree={FolderTree} onClose={() => setMappingWindowOpen(false)} onSaved={() => setLibraryRevision((revision) => revision + 1)} />}
      {advancedToolsVisible && alterUpdateOpen && <AlterUpdateDialog onClose={() => setAlterUpdateOpen(false)} onRemoved={(comicInfoIds) => {
        if (selectedComic && comicInfoIds.includes(selectedComic.comicInfoId)) setEnrichment({})
        setImportPlan(null)
        setLibraryRevision((revision) => revision + 1)
      }} />}
      {bulkEditorOpen && <BulkMetadataDialog comicCount={selectedComics.length} saving={bulkEditorSaving} error={bulkEditorError} onCancel={() => setBulkEditorOpen(false)} onSave={(fields, incrementFields) => void saveBulkMetadata(fields, incrementFields)} />}
      {pathExtractionConfirmationOpen && selectedFolder && <PathExtractionConfirmation folderName={selectedFolder.name} onCancel={() => setPathExtractionConfirmationOpen(false)} onContinue={(overwriteExisting, recursive) => { setPathExtractionConfirmationOpen(false); void extractPathMetadata(selectedFolder.id, overwriteExisting, recursive) }} />}
      {editorDialogOpen && selectedComic && editorTab === 'matching' && <div className="modal-backdrop editor-match-backdrop" role="presentation" onMouseDown={() => setEditorTab('general')}><section className="editor-match-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-match-title" onMouseDown={(event) => event.stopPropagation()}><header className="dialog-header"><div><p className="eyebrow">GCD MATCHING</p><h2 id="editor-match-title">Find comic data</h2></div><button className="dialog-close" type="button" title="Return to comic information" onClick={() => setEditorTab('general')}><X size={18} /></button></header><div className="editor-match-body"><p>Search the GCD database using the comic's title, issue, and volume.</p><div className="match-parameters"><label>Title<input value={matchParameters.title} onChange={(event) => setMatchParameters((current) => ({ ...current, title: event.target.value }))} placeholder="Series title" /></label><label>Issue<input value={matchParameters.number} onChange={(event) => setMatchParameters((current) => ({ ...current, number: event.target.value }))} inputMode="decimal" placeholder="Issue number" /></label><label>Volume<input value={matchParameters.volume} onChange={(event) => setMatchParameters((current) => ({ ...current, volume: event.target.value }))} inputMode="numeric" placeholder="Volume" /></label></div><label className="overwrite-toggle"><input type="checkbox" checked={overwriteExistingProposals} onChange={(event) => setOverwriteExistingProposals(event.target.checked)} /><span>Overwrite existing proposals</span></label>{matchError && <p className="match-error">{matchError}</p>}</div><footer className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setEditorTab('general')}>Back</button><button className="auto-match-button" type="button" disabled={matching} onClick={() => { setEditorTab('general'); void findMatches() }}>{matching ? 'Searching...' : 'Find matches'}</button></footer></section></div>}
      <aside className="sidebar">
        <div className="brand"><Archive size={22} /><span>YAC <b>GCD</b></span></div>
        <div className="library-label"><span>LIBRARY</span><span className="source-dot" title="YACReader database connected" /></div>
        <button className={`folder-item root ${filters.folderId === allComicsFolderId ? 'selected' : ''}`} onClick={() => selectFolder(allComicsFolderId)} type="button"><BookOpen size={16} />All comics</button>
        {data && <FolderTree folders={data.folders} selectedId={filters.folderId} onSelect={selectFolder} />}
        <div className="sidebar-footer"><span>PROTECTED LIBRARY</span><small>{data?.libraryPath ?? 'Opening library...'}</small></div>
      </aside>
      <section className="library-pane">
        <header className="topbar">
          <label className="search-box"><Search size={18} /><input value={filters.search} onChange={(event) => updateFilter({ search: event.target.value })} placeholder="Search title, issue, creator, publisher" /><kbd>/</kbd></label>
          <button className={`icon-button ${showFilters ? 'active' : ''}`} type="button" title="Toggle filters" onClick={() => setShowFilters((shown) => !shown)}><SlidersHorizontal size={18} /></button>
          <button className="icon-button" type="button" title="Open help" aria-label="Open help" onClick={() => setHelpOpen(true)}><Info size={18} /></button>
          <label className="advanced-tools-toggle"><input type="checkbox" checked={advancedToolsVisible} disabled={autoMatching || matching || gcdSyncBusy || importing || pathExtracting || bulkEditorSaving || editorSaving} onChange={(event) => toggleAdvancedTools(event.target.checked)} /><span>Advanced tools</span></label>
          <div className="admin-actions" ref={adminActionsRef}>
            <button className="admin-menu-button" type="button" aria-expanded={adminOpen} aria-haspopup="menu" onClick={() => { setAdminSubmenu(null); setAdminOpen((open) => !open) }}>Admin <ChevronDown size={15} /></button>
            {adminOpen && <div className="admin-menu" role="menu" aria-label="Admin">
              <div className="admin-menu-group" role="none">
                <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={adminSubmenu === 'match'} aria-controls={adminSubmenu === 'match' ? 'admin-match-menu' : undefined} onClick={() => setAdminSubmenu((current) => current === 'match' ? null : 'match')}><WandSparkles size={16} />Match<ChevronRight className="admin-submenu-arrow" size={15} /></button>
                {adminSubmenu === 'match' && <div id="admin-match-menu" className="admin-submenu" role="menu" aria-label="Match">
                  <button type="button" role="menuitem" disabled={!libraryApi || autoMatching || gcdSyncBusy} onClick={() => { setAdminOpen(false); setMappingWindowOpen(true) }}><BookOpen size={16} />Map library to GCD</button>
                  <button type="button" role="menuitem" disabled={!libraryApi || autoMatching} onClick={() => openAutoMatch({ folderId: 1, label: 'the entire library', isLibrary: true })}><WandSparkles size={16} />Auto-match all</button>
                </div>}
              </div>
              <div className="admin-menu-group" role="none">
                <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={adminSubmenu === 'update'} aria-controls={adminSubmenu === 'update' ? 'admin-update-menu' : undefined} onClick={() => setAdminSubmenu((current) => current === 'update' ? null : 'update')}><Upload size={16} />Update<ChevronRight className="admin-submenu-arrow" size={15} /></button>
                {adminSubmenu === 'update' && <div id="admin-update-menu" className="admin-submenu" role="menu" aria-label="Update">
                  <button type="button" role="menuitem" disabled={!libraryApi} onClick={() => { setAdminOpen(false); void showImportPreview() }}><Upload size={16} />Apply update</button>
                  <button type="button" role="menuitem" disabled={!libraryApi} onClick={() => { setAdminOpen(false); setAlterUpdateOpen(true) }}><Pencil size={16} />Alter update</button>
                </div>}
              </div>
              <div className="admin-menu-group" role="none">
                <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={adminSubmenu === 'maintenance'} aria-controls={adminSubmenu === 'maintenance' ? 'admin-maintenance-menu' : undefined} onClick={() => setAdminSubmenu((current) => current === 'maintenance' ? null : 'maintenance')}><SlidersHorizontal size={16} />Maintenance<ChevronRight className="admin-submenu-arrow" size={15} /></button>
                {adminSubmenu === 'maintenance' && <div id="admin-maintenance-menu" className="admin-submenu" role="menu" aria-label="Maintenance">
                  <button type="button" role="menuitem" disabled={!libraryApi} onClick={() => { setAdminOpen(false); void libraryApi.exportEnrichment() }}><Download size={16} />Export updates</button>
                  <button type="button" role="menuitem" disabled={!libraryApi} onClick={() => void importUpdatePackage()}><Upload size={16} />Import updates</button>
                  <button type="button" role="menuitem" disabled={!libraryApi || autoMatching || gcdSyncBusy} onClick={() => void showGcdSyncPreview()}><RefreshCw size={16} />Sync from GCD</button>
                </div>}
              </div>
            </div>}
          </div>
        </header>
        <div className="panel-toggles" aria-label="Workspace panels"><button className={panels.folders ? 'active' : ''} type="button" onClick={() => setPanels((current) => ({ ...current, folders: !current.folders }))}>Folders</button><button className={panels.covers ? 'active' : ''} type="button" onClick={() => setPanels((current) => ({ ...current, covers: !current.covers }))}>Covers</button><button className={panels.list ? 'active' : ''} type="button" onClick={() => setPanels((current) => ({ ...current, list: !current.list }))}>List</button><button className={panels.details ? 'active' : ''} type="button" onClick={() => setPanels((current) => ({ ...current, details: !current.details }))}>Details</button></div>
        {showFilters && <div className="filter-bar">
          <label>Metadata<select value={filters.metadata} onChange={(event) => updateFilter({ metadata: event.target.value })}><option value="all">Everything</option><option value="missing">Missing title</option><option value="complete">Has title</option></select></label>
          <label>Reading<select value={filters.reading} onChange={(event) => updateFilter({ reading: event.target.value })}><option value="all">All statuses</option><option value="unread">Unread</option><option value="read">Read</option></select></label>
          <label>GCD status<select value={filters.gcdStatus} onChange={(event) => updateFilter({ gcdStatus: event.target.value })}><option value="all">All comics</option><option value="pending">Hide GCD-updated</option></select></label>
          <label>Publisher<select value={filters.publisher} onChange={(event) => updateFilter({ publisher: event.target.value })}><option value="all">All publishers</option>{data?.publishers.map((publisher) => <option key={publisher} value={publisher}>{publisher}</option>)}</select></label>
          <button className="text-button" type="button" onClick={() => updateFilter({ metadata: 'all', reading: 'all', gcdStatus: 'all', publisher: 'all' })}><X size={15} />Clear</button>
        </div>}
        <div className="content-header"><div><nav className="breadcrumb" aria-label="Library path"><button type="button" onClick={() => selectFolder(allComicsFolderId)}>All comics</button>{folderBreadcrumbs.map((folder) => <span key={folder.id}><span aria-hidden="true">/</span><button type="button" onClick={() => selectFolder(folder.id)}>{folder.name}</button></span>)}</nav><h1>{filters.folderId === allComicsFolderId ? 'All comics' : selectedFolder?.name}</h1><p className="count">{data?.total.toLocaleString() ?? 0} comics found</p></div><div className="content-actions">{selectedFolder && <button className="auto-match-branch-button" type="button" disabled={!libraryApi || pathExtracting} onClick={() => setPathExtractionConfirmationOpen(true)}><WandSparkles size={16} />Extract from paths</button>}{selectedFolder && <button className={`auto-match-branch-button ${selectedAutoMatchTarget ? 'selected-action-button' : ''}`} type="button" disabled={!libraryApi || autoMatching} onClick={() => openAutoMatch(selectedAutoMatchTarget ?? { folderId: selectedFolder.id, label: selectedFolder.name, isLibrary: selectedFolder.id === libraryRootFolderId })}><WandSparkles size={16} />{selectedAutoMatchTarget ? 'Auto-match selected' : 'Auto-match'}</button>}{selectedAutoMatchTarget && selectedComics.length > 1 && <button className="auto-match-branch-button selected-action-button" type="button" disabled={!libraryApi} onClick={() => { setBulkEditorError(null); setBulkEditorOpen(true) }}><Pencil size={16} />Bulk edit ({selectedComics.length})</button>}</div></div>
        {error && <div className="error-panel"><b>Unable to open the YACReader library.</b><span>{error}</span></div>}
        {loading ? <div className="loading">Reading your library...</div> : <div className="comic-grid">
          {data?.comics.map((comic) => <button key={comic.id} type="button" aria-pressed={selectedComicIds.has(comic.id)} className={`comic-card ${selectedComicIds.has(comic.id) ? 'selected' : ''}`} onClick={(event) => selectComic(comic, event)}>
            <div className="cover-placeholder">{comic.coverUrl && <img src={comic.coverUrl} alt={`Cover for ${comic.title || comic.fileName}`} onError={(event) => { event.currentTarget.hidden = true }} />}{comic.read === 1 && <i>READ</i>}</div>
            <div className="comic-caption"><b>{comic.title || comic.fileName.replace(/\.[^.]+$/, '')}</b><span>{[comic.publisher, comic.number && `#${comic.number}`].filter(Boolean).join(' · ') || 'Metadata pending'}</span></div>
          </button>)}</div>}
        {data && <LibraryProposalSummary comics={data.comics} />}
        {data && <LibraryList comics={sortedComics} selectedComicIds={selectedComicIds} drafts={rowDrafts} sort={librarySort} onSort={updateLibrarySort} onSelect={selectComic} onDraftChange={updateRowDraft} onCommit={(comic, field, value) => void commitRowEdit(comic, field, value)} onContextMenu={openRowContext} />}
        {filters.folderId === allComicsFolderId && data && data.total > data.pageSize && <nav className="pagination" aria-label="Comic pages"><button type="button" title="Previous page" aria-label="Previous page" disabled={data.page === 1} onClick={() => updateFilter({ page: data.page - 1 })}><ChevronLeft size={17} /></button><span>Page {data.page} of {pageCount}</span><button type="button" title="Next page" aria-label="Next page" disabled={data.page === pageCount} onClick={() => updateFilter({ page: data.page + 1 })}><ChevronRight size={17} /></button></nav>}
      </section>
      <aside className="detail-pane">
        {selectedComic && <ProposedUpdates fields={enrichment} className="detail-proposed-updates" />}
        {selectedComic && <div className="detail-cover">{selectedComic.coverUrl && <img src={selectedComic.coverUrl} alt={`Cover for ${selectedComic.title || selectedComic.fileName}`} onError={(event) => { event.currentTarget.hidden = true }} />}</div>}
        {selectedComic ? <>
          <div className="detail-heading"><div className="detail-title-row"><div><p className="eyebrow">COMIC DETAILS</p><h2>{selectedComic.title || selectedComic.fileName}</h2></div><button className="metadata-button" type="button" title="Edit comic information" onClick={() => void openMetadataEditor()} disabled={metadataLoading}><Info size={16} /></button></div><span>{selectedComic.path}</span></div>
            {editorDialogOpen && selectedComic && <div className="modal-backdrop" role="presentation" onMouseDown={() => !editorSaving && setEditorDialogOpen(false)}><section className="metadata-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" onMouseDown={(event) => event.stopPropagation()}><header className="dialog-header"><div><p className="eyebrow">YACREADER LIBRARY</p><h2 id="metadata-editor-title">Edit comic information</h2></div><button className="dialog-close" type="button" title="Cancel edits" onClick={() => setEditorDialogOpen(false)} disabled={editorSaving}><X size={18} /></button></header>{metadataLoading ? <div className="loading">Loading comic information...</div> : <><div className="metadata-tabs" role="tablist" aria-label="Comic information categories">{editorTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={editorTab === tab.id} className={editorTab === tab.id ? 'active' : ''} onClick={() => setEditorTab(tab.id)}>{tab.label}</button>)}</div><div className="metadata-editor-body">{editorError && <p className="match-error">{editorError}</p>}{editorMessage && <p className="editor-message">{editorMessage}</p>}{editorTab === 'general' && <section className="metadata-editor-grid"><MetadataEditorField field="series" label="Series" value={editorMetadata.series} onChange={updateEditorMetadata} /><MetadataEditorField field="title" label="Title" value={editorMetadata.title} onChange={updateEditorMetadata} /><MetadataEditorField field="number" label="Issue number" value={editorMetadata.number} onChange={updateEditorMetadata} /><MetadataEditorField field="count" label="Issue count" value={editorMetadata.count} onChange={updateEditorMetadata} /><MetadataEditorField field="volume" label="Volume" value={editorMetadata.volume} onChange={updateEditorMetadata} /><MetadataEditorField field="storyArc" label="Story arc" value={editorMetadata.storyArc} onChange={updateEditorMetadata} /><MetadataEditorField field="arcNumber" label="Arc number" value={editorMetadata.arcNumber} onChange={updateEditorMetadata} /><MetadataEditorField field="arcCount" label="Arc count" value={editorMetadata.arcCount} onChange={updateEditorMetadata} /><MetadataEditorField field="alternateSeries" label="Alternative series" value={editorMetadata.alternateSeries} onChange={updateEditorMetadata} /><MetadataEditorField field="alternateNumber" label="Alternative number" value={editorMetadata.alternateNumber} onChange={updateEditorMetadata} /><MetadataEditorField field="alternateCount" label="Alternative count" value={editorMetadata.alternateCount} onChange={updateEditorMetadata} /><MetadataEditorField field="seriesGroup" label="Series group" value={editorMetadata.seriesGroup} onChange={updateEditorMetadata} /><MetadataEditorField field="genere" label="Genre" value={editorMetadata.genere} onChange={updateEditorMetadata} /><div className="metadata-readonly"><span>Size</span><b>{editorSize}</b></div></section>}{editorTab === 'plot' && <section className="metadata-editor-grid"><MetadataEditorField field="synopsis" label="Synopsis" value={editorMetadata.synopsis} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="characters" label="Characters" value={editorMetadata.characters} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="teams" label="Teams" value={editorMetadata.teams} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="locations" label="Locations" value={editorMetadata.locations} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="mainCharacterOrTeam" label="Main character or team" value={editorMetadata.mainCharacterOrTeam} onChange={updateEditorMetadata} /></section>}{editorTab === 'authors' && <section className="metadata-editor-grid"><MetadataEditorField field="writer" label="Writer(s)" value={editorMetadata.writer} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="penciller" label="Penciler(s)" value={editorMetadata.penciller} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="inker" label="Inker(s)" value={editorMetadata.inker} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="colorist" label="Colorist(s)" value={editorMetadata.colorist} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="letterer" label="Letterer(s)" value={editorMetadata.letterer} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="coverArtist" label="Cover artist(s)" value={editorMetadata.coverArtist} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="editor" label="Editor(s)" value={editorMetadata.editor} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="imprint" label="Imprint" value={editorMetadata.imprint} onChange={updateEditorMetadata} /></section>}{editorTab === 'publishing' && <section className="metadata-editor-grid"><div className="publication-date"><MetadataEditorField field="day" label="Day" value={editorMetadata.day} onChange={updateEditorMetadata} /><MetadataEditorField field="month" label="Month" value={editorMetadata.month} onChange={updateEditorMetadata} /><MetadataEditorField field="year" label="Year" value={editorMetadata.year} onChange={updateEditorMetadata} /></div><MetadataEditorField field="publisher" label="Publisher" value={editorMetadata.publisher} onChange={updateEditorMetadata} /><MetadataEditorField field="format" label="Format" value={editorMetadata.format} onChange={updateEditorMetadata} /><label className="metadata-editor-field checkbox-field"><span>Color/BW</span><input type="checkbox" checked={editorMetadata.color === '1'} onChange={(event) => updateEditorMetadata('color', event.target.checked ? '1' : '0')} /></label><MetadataEditorField field="ageRating" label="Age rating" value={editorMetadata.ageRating} onChange={updateEditorMetadata} /><label className="metadata-editor-field"><span>Type</span><select value={editorMetadata.type} onChange={(event) => updateEditorMetadata('type', event.target.value)}><option value="">Not set</option><option value="0">Comic</option><option value="1">Manga</option><option value="2">Western Manga</option><option value="3">Web Comic</option><option value="4">4koma</option></select></label><MetadataEditorField field="languageISO" label="Language (ISO)" value={editorMetadata.languageISO} onChange={updateEditorMetadata} /></section>}{editorTab === 'notes' && <section className="metadata-editor-grid"><MetadataEditorField field="review" label="Review" value={editorMetadata.review} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="notes" label="Notes" value={editorMetadata.notes} onChange={updateEditorMetadata} multiline /><MetadataEditorField field="tags" label="Tags" value={editorMetadata.tags} onChange={updateEditorMetadata} multiline /></section>}</div><footer className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setEditorDialogOpen(false)} disabled={editorSaving}>Cancel</button><button className="save-button editor-save-button" type="button" onClick={() => void saveComicMetadata()} disabled={editorSaving}>{editorSaving ? 'Saving...' : 'Save changes'}</button></footer></>}</section></div>}
          <dl className="metadata"><div><dt>Issue</dt><dd>{selectedComic.number || 'Not set'}</dd></div><div><dt>Publisher</dt><dd>{selectedComic.publisher || 'Not set'}</dd></div><div><dt>Date</dt><dd>{selectedComic.date || 'Not set'}</dd></div><div><dt>Creators</dt><dd>{[selectedComic.writer, selectedComic.penciller, selectedComic.inker].filter(Boolean).join(', ') || 'Not set'}</dd></div><div><dt>Story arc</dt><dd>{selectedComic.storyArc || 'Not set'}</dd></div></dl>
          {advancedToolsVisible && <><section className="match-panel">
            <div className="form-header"><span>GCD matching</span><small>Review before import</small></div>
            <div className="match-parameters"><label>Title<input value={matchParameters.title} onChange={(event) => setMatchParameters((current) => ({ ...current, title: event.target.value }))} placeholder="Series title" /></label><label>Issue<input value={matchParameters.number} onChange={(event) => setMatchParameters((current) => ({ ...current, number: event.target.value }))} inputMode="decimal" placeholder="Issue number" /></label><label>Volume<input value={matchParameters.volume} onChange={(event) => setMatchParameters((current) => ({ ...current, volume: event.target.value }))} inputMode="numeric" placeholder="Volume" /></label></div>
            <div className="match-search"><button type="button" onClick={() => void findMatches()} disabled={matching || selectedComicIds.size !== 1}>{matching ? 'Searching...' : matches.length ? 'Refine matches' : 'Find matches'}</button></div>
            {matchError && <p className="match-error">{matchError}</p>}
            {matches.length > 0 && <button className="review-results" type="button" onClick={() => setMatchDialogOpen(true)}>Review {matches.length} GCD candidates</button>}
          </section>
          <form className="enrichment-form" onSubmit={(event) => { event.preventDefault(); void saveEnrichment() }}><div className="form-header"><span>GCD enrichment</span><small>Stored separately</small></div>{enrichmentFields.slice(0, 4).map(([key, label]) => <label key={key}>{label}<input value={enrichment[key] ?? ''} inputMode={key === 'issueNumber' ? 'decimal' : undefined} pattern={key === 'issueNumber' ? '\\d+(\\.\\d+)?' : undefined} placeholder={key === 'issueNumber' ? 'e.g. 12 or 12.5' : undefined} onChange={(event) => setEnrichment((current) => ({ ...current, [key]: event.target.value }))} /></label>)}<button className="enrichment-details-toggle" type="button" aria-expanded={enrichmentDetailsOpen} aria-controls="enrichment-details" onClick={() => setEnrichmentDetailsOpen((open) => !open)}>Additional GCD details <ChevronDown size={15} /></button>{enrichmentDetailsOpen && <div className="enrichment-details" id="enrichment-details">{enrichmentFields.slice(4).map(([key, label]) => <label key={key}>{label}<input value={enrichment[key] ?? ''} inputMode={key === 'issueNumber' ? 'decimal' : undefined} pattern={key === 'issueNumber' ? '\\d+(\\.\\d+)?' : undefined} placeholder={key === 'issueNumber' ? 'e.g. 12 or 12.5' : undefined} onChange={(event) => setEnrichment((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div>}<button className="save-button" type="submit">Save proposed data</button></form>
          </>}
        </> : <div className="empty-detail">Select a comic to inspect its metadata.</div>}
      </aside>
      {editorDialogOpen && selectedComic && !metadataLoading && !matchDialogOpen && <EditorNavigationDock canGoPrevious={editorComicIndex > 0} canGoNext={editorComicIndex >= 0 && editorComicIndex < sortedComics.length - 1} saving={editorSaving} onNavigate={requestEditorNavigation} />}
      {editorNavigationTarget && <div className="modal-backdrop" role="presentation"><section className="editor-navigation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="editor-navigation-title"><header className="dialog-header"><div><p className="eyebrow">UNSAVED CHANGES</p><h2 id="editor-navigation-title">Save changes before navigating?</h2></div></header><div className="editor-navigation-body">Changes to {selectedComic?.title || selectedComic?.fileName} have not been saved.</div><footer className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setEditorNavigationTarget(null)}>Cancel</button><button className="secondary-button" type="button" onClick={() => void resolveEditorNavigation(false)}>No</button><button className="save-button editor-save-button" type="button" onClick={() => void resolveEditorNavigation(true)}>Yes</button></footer></section></div>}
      {rowContext && <div className="row-context-menu" role="menu" style={{ left: rowContext.x, top: rowContext.y }}><button type="button" role="menuitem" onClick={() => { const comic = rowContext.comic; setRowContext(null); setSelectedComic(comic); setSelectedComicIds(new Set([comic.id])); void openMetadataEditor(comic) }}>Edit metadata</button></div>}
        {matchDialogOpen && reviewComic && <MatchReviewDialog reviewComic={reviewComic} matches={matches} selectedMatch={selectedMatch} matching={matching} parameters={reviewMatchParameters} onParametersChange={setReviewMatchParameters} onSearch={() => void searchReviewMatches()} onSelectMatch={(match) => { setSelectedMatch(match); setEnrichment(match.proposedFields) }} onSave={() => selectedMatch && void applyMatch(selectedMatch, reviewComic, overwriteExistingProposals)} onClose={closeMatchReview} />}
      {metadataDialogOpen && selectedComic && <div className="modal-backdrop" role="presentation" onMouseDown={() => setMetadataDialogOpen(false)}><section className="metadata-dialog" role="dialog" aria-modal="true" aria-labelledby="metadata-dialog-title" onMouseDown={(event) => event.stopPropagation()}><header className="dialog-header"><div><p className="eyebrow">STORED COMIC METADATA</p><h2 id="metadata-dialog-title">{selectedComic.fileName}</h2></div><button className="dialog-close" type="button" title="Close stored metadata" onClick={() => setMetadataDialogOpen(false)}><X size={18} /></button></header><div className="metadata-tabs" role="tablist" aria-label="Metadata categories">{metadataTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={metadataTab === tab.id} className={metadataTab === tab.id ? 'active' : ''} onClick={() => setMetadataTab(tab.id)}>{tab.label}</button>)}</div><div className="metadata-dialog-body"><section><div className="metadata-section-heading"><h3>{activeMetadataTab.label}</h3><span>{metadataTab === 'proposed' ? 'App-side enrichment.db' : 'Read-only library.ydb'}</span></div><dl className="stored-metadata">{activeMetadataTab.fields.map(([key, label]) => { const isProposed = metadataTab === 'proposed'; const values = isProposed ? enrichment : storedMetadata; const available = isProposed || Boolean(storedMetadata && Object.hasOwn(storedMetadata, key)); return <div key={key}><dt>{label}</dt><dd>{presentValue(values?.[key], available)}</dd></div> })}</dl></section></div><footer className="dialog-footer"><button className="secondary-button" type="button" onClick={() => setMetadataDialogOpen(false)}>Close</button></footer></section></div>}
      {importDialogOpen && importPlan && <div className="modal-backdrop" role="presentation" onMouseDown={() => !importing && setImportDialogOpen(false)}><section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" onMouseDown={(event) => event.stopPropagation()}><header className="dialog-header"><div><p className="eyebrow">YACREADER UPDATE PREVIEW</p><h2 id="import-dialog-title">{importPlan.updatedFields === undefined ? `${importPlan.eligibleComics} comics to be updated` : 'Library update complete'}</h2></div><button className="dialog-close" type="button" title="Close update preview" onClick={() => setImportDialogOpen(false)} disabled={importing}><X size={18} /></button></header><div className="import-dialog-body">{importPlan.updatedFields === undefined ? <><div className="import-summary"><b>{importPlan.changes.length} fields across {importPlan.eligibleComics} comics can be added</b><span>Only empty YACReader fields are eligible. Existing values are never overwritten.</span></div><dl className="import-counts"><div><dt>Proposed records</dt><dd>{importPlan.proposedRecords}</dd></div><div><dt>Existing values protected</dt><dd>{importPlan.skippedExisting}</dd></div><div><dt>Invalid issue numbers skipped</dt><dd>{importPlan.skippedInvalidIssue}</dd></div><div><dt>Unsupported fields skipped</dt><dd>{importPlan.skippedUnsupported}</dd></div><div><dt>Missing comics skipped</dt><dd>{importPlan.missingComics}</dd></div></dl><div className="import-change-list">{importPlan.changes.slice(0, 30).map((change) => <div key={`${change.comicInfoId}-${change.libraryField}`}><b>{change.fileName}</b><span>{change.libraryField}: {change.value}</span></div>)}{importPlan.changes.length > 30 && <p>Plus {importPlan.changes.length - 30} more fields.</p>}</div></> : <div className="import-summary complete"><b>{importPlan.updatedFields} YACReader fields were updated.</b><span>A consistent backup was created before the transaction.</span><code>{importPlan.backupPath}</code></div>}{importError && <p className="match-error">{importError}</p>}</div><footer className="dialog-footer"><button className="secondary-button" type="button" disabled={importing} onClick={() => setImportDialogOpen(false)}>{importPlan.updatedFields === undefined ? 'Cancel' : 'Close'}</button>{importPlan.updatedFields === undefined && <button className="save-button" type="button" disabled={importing || importPlan.changes.length === 0} onClick={() => void applyImport()}>{importing ? 'Updating library...' : 'Create backup and apply updates'}</button>}</footer></section></div>}
      {autoMatchConfirmationOpen && autoMatchTarget && <AutoMatchConfirmation target={autoMatchTarget} onCancel={() => { setAutoMatchConfirmationOpen(false); setAutoMatchTarget(null) }} onContinue={(overwriteExisting, recursive, refinement) => { setAutoMatchConfirmationOpen(false); void autoMatchExact(autoMatchTarget, overwriteExisting, recursive, refinement) }} />}
      {gcdSyncOpen && <GcdSyncDialog key={gcdSyncPlan?.planId ?? 'scanning'} plan={gcdSyncPlan} progress={gcdSyncProgress} result={gcdSyncResult} busy={gcdSyncBusy} error={gcdSyncError} onClose={() => setGcdSyncOpen(false)} onScan={() => void showGcdSyncPreview()} onApply={(replaceExisting) => void applyGcdSync(replaceExisting)} />}
      {autoMatching && <AutoMatchProgressDialog progress={autoMatchProgress} />}
      {autoMatchMessage && <div className="automation-notice" role="status"><span>{autoMatchMessage}</span><button type="button" title="Dismiss automatic matching result" onClick={() => setAutoMatchMessage(null)}><X size={15} /></button></div>}
      {helpOpen && <HelpPage onClose={() => setHelpOpen(false)} />}
    </main>
  )
}

export default App
