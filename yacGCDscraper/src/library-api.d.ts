export type GcdBrowserRecord = {
  id: number
  name?: string
  yearBegan?: number
  issueCount?: number
  number?: string
  title?: string
  variantOfId?: number | null
  variantName?: string
  seriesId?: number
  seriesName?: string
  publisherName?: string
  indiciaPublisher?: string
  onSaleDate?: string
}

declare global {
  interface Window {
    libraryApi: {
      loadLibrary: (filters: { folderId: number; page: number; pageSize: number; search: string; metadata: string; reading: string; publisher: string; gcdStatus: string; sort?: 'path' | 'title' }) => Promise<unknown>
      browseGcd: (options: { publisherId?: number; seriesId?: number; search?: string; page?: number }) => Promise<{ level: 'publishers' | 'series' | 'issues'; records: GcdBrowserRecord[]; page: number; hasMore: boolean }>
      createMappings: (options: { comicId: number; gcdIssueId: number; matchFolder?: boolean; overwriteExisting?: boolean }) => Promise<{ scanned: number; saved: number; skippedExisting: number; ambiguous: number; unmatched: number; failed: number }>
      getComicMetadata: (comicId: number) => Promise<Record<string, unknown> | null>
      updateComicMetadata: (comicId: number, fields: Record<string, unknown>) => Promise<{ backupPath: string }>
      bulkUpdateComicMetadata: (comicInfoIds: number[], fields: Record<string, string>, incrementFields: string[]) => Promise<{ backupPath: string; updatedComics: number }>
      extractPathMetadata: (options: { folderId: number; recursive?: boolean; overwriteExisting?: boolean }) => Promise<{ scanned: number; updatedComics: number; updatedFields: number; skippedExisting: number; backupPath: string | null }>
      getEnrichment: (comicInfoId: number) => Promise<Record<string, string>>
      saveEnrichment: (comicInfoId: number, fields: Record<string, string>) => Promise<void>
      exportEnrichment: () => Promise<void>
      previewImport: () => Promise<unknown>
      importEnrichment: () => Promise<unknown>
      previewGcdSync: () => Promise<unknown>
      applyGcdSync: (options: { planId: string; replaceExisting: boolean }) => Promise<{ updatedFields: number; updatedComics: number; backupPath: string | null }>
      onGcdSyncProgress: (listener: (progress: { scanned: number; total: number; matched: number; unmatched: number; failed: number }) => void) => () => void
      importEnrichmentPackage: () => Promise<unknown>
      autoMatchExact: (options?: { folderId?: number; comicInfoIds?: number[]; recursive?: boolean; overwriteExisting?: boolean; refinement?: { title: string; volume: string; publisher: string } }) => Promise<unknown>
      onAutoMatchProgress: (listener: (progress: { scanned: number; total: number; proposed: number; unmatched: number }) => void) => () => void
      findMatches: (comic: unknown, parameters: { title: string; number: string; volume: string }) => Promise<unknown>
    }
  }
}