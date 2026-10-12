const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('libraryApi', {
  loadLibrary: (filters) => ipcRenderer.invoke('library:load', filters),
  browseGcd: (options) => ipcRenderer.invoke('gcd:browse', options),
  createMappings: (options) => ipcRenderer.invoke('gcd:create-mappings', options),
  getComicMetadata: (comicId) => ipcRenderer.invoke('comic:metadata', comicId),
  updateComicMetadata: (comicId, fields) => ipcRenderer.invoke('comic:update-metadata', comicId, fields),
  bulkUpdateComicMetadata: (comicInfoIds, fields, incrementFields) => ipcRenderer.invoke('comic:bulk-update-metadata', comicInfoIds, fields, incrementFields),
  extractPathMetadata: (options) => ipcRenderer.invoke('comic:extract-path-metadata', options),
  getEnrichment: (comicInfoId) => ipcRenderer.invoke('enrichment:get', comicInfoId),
  saveEnrichment: (comicInfoId, fields) => ipcRenderer.invoke('enrichment:save', comicInfoId, fields),
  exportEnrichment: () => ipcRenderer.invoke('enrichment:export'),
  previewImport: () => ipcRenderer.invoke('enrichment:preview-import'),
  importEnrichment: () => ipcRenderer.invoke('enrichment:import'),
  previewGcdSync: () => ipcRenderer.invoke('gcd:preview-sync'),
  applyGcdSync: (options) => ipcRenderer.invoke('gcd:apply-sync', options),
  onGcdSyncProgress: (listener) => {
    const handler = (_event, progress) => listener(progress)
    ipcRenderer.on('gcd:sync-progress', handler)
    return () => ipcRenderer.removeListener('gcd:sync-progress', handler)
  },
  importEnrichmentPackage: () => ipcRenderer.invoke('enrichment:import-package'),
  autoMatchExact: (options = {}) => ipcRenderer.invoke('enrichment:auto-match-exact', options),
  onAutoMatchProgress: (listener) => {
    const handler = (_event, progress) => listener(progress)
    ipcRenderer.on('enrichment:auto-match-progress', handler)
    return () => ipcRenderer.removeListener('enrichment:auto-match-progress', handler)
  },
  findMatches: (comic, parameters) => ipcRenderer.invoke('gcd:match', comic, parameters),
})