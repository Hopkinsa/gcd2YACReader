import { useEffect, useState, type ComponentType } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, File, Folder, Link, Search, WandSparkles, X } from 'lucide-react'
import type { GcdBrowserRecord } from './library-api'

type MappingFolder = { id: number; parentId: number; name: string; path: string; numChildren: number | null }
type MappingComic = { id: number; comicInfoId: number; fileName: string; path: string; series: string | null; title: string | null; number: string | null; publisher: string | null; date: string | null; proposedFields: Record<string, string> }
type LibraryPage = { folders: MappingFolder[]; comics: MappingComic[]; page: number; pageSize: number; total: number }
type GcdPage = Awaited<ReturnType<Window['libraryApi']['browseGcd']>>
type MappingResult = Awaited<ReturnType<Window['libraryApi']['createMappings']>>

function RecordDetails({ label, fields }: { label: string; fields: [string, unknown][] }) {
  return <section className="mapping-details" aria-label={label}><dl>{fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{String(value ?? '').trim() || 'Not set'}</dd></div>)}</dl></section>
}

export default function MappingWindow({ FolderTree, onClose, onSaved }: {
  FolderTree: ComponentType<{ folders: MappingFolder[]; selectedId: number; onSelect: (folderId: number) => void }>
  onClose: () => void
  onSaved: () => void
}) {
  const api = window.libraryApi
  const [folderId, setFolderId] = useState(1)
  const [librarySearch, setLibrarySearch] = useState('')
  const [libraryPage, setLibraryPage] = useState(1)
  const [library, setLibrary] = useState<(LibraryPage & { requestKey: string }) | null>(null)
  const [comic, setComic] = useState<MappingComic | null>(null)
  const [publisher, setPublisher] = useState<GcdBrowserRecord | null>(null)
  const [series, setSeries] = useState<GcdBrowserRecord | null>(null)
  const [issue, setIssue] = useState<GcdBrowserRecord | null>(null)
  const [gcdSearch, setGcdSearch] = useState('')
  const [gcdPage, setGcdPage] = useState(1)
  const [gcd, setGcd] = useState<(GcdPage & { requestKey: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MappingResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [savedPair, setSavedPair] = useState('')
  const [revision, setRevision] = useState(0)
  const pair = comic && issue ? `${comic.id}:${issue.id}` : ''
  const folderName = library?.folders.find((folder) => folder.id === folderId)?.name || 'Library'
  const libraryRequest = JSON.stringify([folderId, libraryPage, librarySearch, revision])
  const gcdRequest = JSON.stringify([publisher?.id, series?.id, gcdSearch, gcdPage])
  const libraryLoading = library?.requestKey !== libraryRequest
  const gcdLoading = gcd?.requestKey !== gcdRequest

  useEffect(() => {
    let active = true
    api.loadLibrary({ folderId, page: libraryPage, pageSize: 100, search: librarySearch, metadata: 'all', reading: 'all', publisher: 'all', gcdStatus: 'all', sort: 'path' })
      .then((data) => { if (active) setLibrary({ ...data as LibraryPage, requestKey: libraryRequest }) })
      .catch((failure: Error) => { if (active) { setError(failure.message); setLibrary({ folders: [], comics: [], page: 1, pageSize: 100, total: 0, requestKey: libraryRequest }) } })
    return () => { active = false }
  }, [api, folderId, libraryPage, librarySearch, libraryRequest])

  useEffect(() => {
    let active = true
    api.browseGcd({ publisherId: publisher?.id, seriesId: series?.id, search: gcdSearch, page: gcdPage })
      .then((data) => { if (active) setGcd({ ...data, requestKey: gcdRequest }) })
      .catch((failure: Error) => { if (active) { setError(failure.message); setGcd({ level: 'publishers', records: [], page: gcdPage, hasMore: false, requestKey: gcdRequest }) } })
    return () => { active = false }
  }, [api, publisher?.id, series?.id, gcdSearch, gcdPage, gcdRequest])

  const selectFolder = (id: number) => {
    setFolderId(id); setLibraryPage(1); setComic(null); setResult(null)
  }
  const navigateGcd = (nextPublisher: GcdBrowserRecord | null, nextSeries: GcdBrowserRecord | null) => {
    setPublisher(nextPublisher); setSeries(nextSeries); setIssue(null); setGcdPage(1); setResult(null)
  }
  const save = async (matchFolder: boolean) => {
    if (!comic || !issue) return
    setBusy(true); setError(null); setResult(null)
    try {
      const outcome = await api.createMappings({ comicId: comic.id, gcdIssueId: issue.id, matchFolder, overwriteExisting: replaceExisting })
      setResult(outcome)
      if (!matchFolder) {
        setSavedPair(pair)
        setComic({ ...comic, proposedFields: { ...comic.proposedFields, gcdIssueId: String(issue.id) } })
      }
      setRevision((current) => current + 1)
      onSaved()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Mapping could not be saved.') }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop mapping-backdrop" role="presentation"><section className="mapping-window" role="dialog" aria-modal="true" aria-labelledby="mapping-title">
    <header className="dialog-header"><div><p className="eyebrow">ADMIN</p><h2 id="mapping-title">Map library to GCD</h2></div><button className="dialog-close" type="button" title="Close mapping window" aria-label="Close mapping window" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    {error && <p className="mapping-error" role="alert">{error}</p>}
    <div className="mapping-workspace" aria-busy={busy}>
      <section className="mapping-pane" aria-label="Library mapping browser">
        <header className="mapping-pane-heading"><h3>Library</h3><small>{comic ? `Comic info ID ${comic.comicInfoId}` : folderName}</small></header>
        <label className="mapping-search"><Search size={15} /><input aria-label="Search library records" placeholder="Search library records" value={librarySearch} disabled={busy} onChange={(event) => { setLibrarySearch(event.target.value); setLibraryPage(1); setComic(null) }} /></label>
        <div className="mapping-library-navigation">
          <div className="mapping-folder-list"><FolderTree folders={library?.folders || []} selectedId={folderId} onSelect={(id) => { if (!busy) selectFolder(id) }} /></div>
          <div className="mapping-record-list" role="list" aria-label="Library comics">
            {libraryLoading ? <p className="mapping-empty" role="status">Loading comics...</p> : library?.comics.length ? library.comics.map((record) => <button type="button" role="listitem" key={record.id} disabled={busy} aria-current={comic?.id === record.id ? 'true' : undefined} className={`mapping-record ${comic?.id === record.id ? 'selected' : ''}`} onClick={() => { setComic(record); setResult(null) }}><File size={15} /><span><b>{record.fileName}</b><small>{[record.series, record.number && `#${record.number}`].filter(Boolean).join(' · ')}</small></span>{record.proposedFields?.gcdIssueId && <Link size={14} aria-label={`Mapped to GCD issue ${record.proposedFields.gcdIssueId}`} />}</button>) : <p className="mapping-empty">No comics found.</p>}
          </div>
        </div>
        <nav className="mapping-pagination" aria-label="Library record pages"><button type="button" title="Previous library page" aria-label="Previous library page" disabled={busy || libraryLoading || libraryPage <= 1} onClick={() => { setLibraryPage((current) => current - 1); setComic(null) }}><ChevronLeft size={16} /></button><span>{library?.total ?? 0} records</span><button type="button" title="Next library page" aria-label="Next library page" disabled={busy || libraryLoading || !library || library.page * library.pageSize >= library.total} onClick={() => { setLibraryPage((current) => current + 1); setComic(null) }}><ChevronRight size={16} /></button></nav>
        <RecordDetails label="Selected library record" fields={[["File Path", comic?.path], ['Series title', comic?.series], ['Issue title', comic?.title], ['Issue number', comic?.number], ['Publisher', comic?.publisher], ['Date', comic?.date]]} />
        <p className="mapping-link-status">{comic?.proposedFields?.gcdIssueId ? `Linked GCD issue ID ${comic.proposedFields.gcdIssueId}` : comic ? 'Not mapped' : 'No comic selected'}</p>
      </section>
      <section className="mapping-pane" aria-label="GCD mapping browser">
        <header className="mapping-pane-heading"><h3>GCD</h3><small>{issue ? `Issue ID ${issue.id}` : series ? `Series ID ${series.id}` : 'Publishers'}</small></header>
        <label className="mapping-search"><Search size={15} /><input aria-label="Search GCD records" placeholder={series ? 'Search series, issue title or number' : publisher ? 'Search series or issue titles' : 'Search publishers, series or titles'} value={gcdSearch} disabled={busy} onChange={(event) => { setGcdSearch(event.target.value); setGcdPage(1); setIssue(null) }} /></label>
        <nav className="mapping-breadcrumbs" aria-label="GCD navigation"><button type="button" disabled={busy} onClick={() => navigateGcd(null, null)}>Publishers</button>{publisher && <><ChevronRight size={12} /><button type="button" disabled={busy} onClick={() => navigateGcd(publisher, null)}>{publisher.name}</button></>}{series && <><ChevronRight size={12} /><span>{series.name}</span></>}</nav>
        <div className="mapping-record-list mapping-gcd-list" role="list" aria-label="GCD records">
          {gcdLoading ? <p className="mapping-empty" role="status">Loading GCD records...</p> : gcd?.records.length ? gcd.records.map((record) => <button type="button" role="listitem" key={record.id} disabled={busy} aria-current={issue?.id === record.id ? 'true' : undefined} className={`mapping-record ${issue?.id === record.id ? 'selected' : ''}`} onClick={() => { if (gcd.level === 'publishers') navigateGcd(record, null); else if (gcd.level === 'series') navigateGcd(publisher, record); else { setIssue(record); setResult(null) } }}>{gcd.level === 'issues' ? <BookOpen size={16} /> : <Folder size={16} />}<span><b>{gcd.level === 'issues' ? `#${record.number || '?'}${record.title ? ` · ${record.title}` : ''}` : record.name}</b><small>{gcd.level === 'series' ? [record.yearBegan, `${record.issueCount ?? 0} ${record.issueCount === 1 ? 'issue' : 'issues'}`, `Series ID ${record.id}`].filter((value) => value !== undefined && value !== null && value !== '').join(' · ') : gcd.level === 'issues' ? `${record.variantName || 'Issue'} · ID ${record.id}` : `Publisher ID ${record.id}`}</small></span>{gcd.level !== 'issues' && <ChevronRight size={14} />}</button>) : <p className="mapping-empty">No GCD records found.</p>}
        </div>
        <nav className="mapping-pagination" aria-label="GCD record pages"><button type="button" title="Previous GCD page" aria-label="Previous GCD page" disabled={busy || gcdLoading || gcdPage <= 1} onClick={() => { setGcdPage((current) => current - 1); setIssue(null) }}><ChevronLeft size={16} /></button><span>Page {gcdPage}</span><button type="button" title="Next GCD page" aria-label="Next GCD page" disabled={busy || gcdLoading || !gcd?.hasMore} onClick={() => { setGcdPage((current) => current + 1); setIssue(null) }}><ChevronRight size={16} /></button></nav>
        <RecordDetails label="Selected GCD record" fields={[["Series title", issue?.seriesName || series?.name], ['Issue title', issue?.title], ['Issue number', issue?.number], ['Publisher', issue?.publisherName || publisher?.name], ['Indicia Publisher', issue?.indiciaPublisher], ['On-sale date', issue?.onSaleDate]]} />
      </section>
    </div>
    <footer className="mapping-footer">
      {result && <p role="status">{result.saved} mappings and proposals saved{result.scanned > 1 ? ` · ${result.skippedExisting} existing · ${result.ambiguous} ambiguous · ${result.unmatched} unmatched · ${result.failed} failed` : ''}</p>}
      <div className="mapping-footer-actions"><label className="overwrite-toggle"><input type="checkbox" checked={replaceExisting} disabled={busy} onChange={(event) => setReplaceExisting(event.target.checked)} /><span>Replace existing mappings</span></label><button className="secondary-button" type="button" disabled={busy || !pair || pair !== savedPair} onClick={() => void save(true)}><WandSparkles size={16} />Map remaining folder by issue</button><button className="save-button editor-save-button" type="button" disabled={busy || !pair || libraryLoading || gcdLoading} onClick={() => void save(false)}><Link size={16} />{busy ? 'Saving...' : 'Save mapping and proposal'}</button></div>
    </footer>
  </section></div>
}