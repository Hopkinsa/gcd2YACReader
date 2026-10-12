function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/^[-\s]+|[-\s]+$/g, '').trim()
}

function issueNumber(value) {
  const number = String(value || '').trim()
  return /^\d+(?:\.\d+)?$/.test(number) ? String(Number(number)) : ''
}

function parentFolder(comic) {
  const fileName = String(comic.fileName || '').toLocaleLowerCase()
  const segments = String(comic.path || '').split(/[\\/]+/).filter(Boolean)
  if (segments.at(-1)?.toLocaleLowerCase() === fileName) segments.pop()
  return cleanText(segments.at(-1))
}

function fileStem(comic) {
  return cleanText(String(comic.fileName || '').replace(/\.[^.]+$/, ''))
}

function isEventPrefix(prefix, comic) {
  const folder = parentFolder(comic)
  const normalizedFolder = folder.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')
  const normalizedPrefix = cleanText(prefix).toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')
  return /\bevents?\b/i.test(folder) && normalizedFolder.endsWith(normalizedPrefix)
}

export function extractPathMetadata(comic) {
  const source = fileStem(comic)
  const isTradePaperback = /\bTPB\b/i.test(source)
  let working = cleanText(source.replace(/\bTPB\b/gi, ' '))
  if (!working) return {}

  const result = {}
  let alternateMatch = working.match(/^(.+?)\s*-\s*#\s*(\d+(?:\.\d+)?)\b\s*(?:-\s*)?(.+)$/)
  if (alternateMatch) {
    result.alternateSeries = cleanText(alternateMatch[1])
    result.alternateNumber = issueNumber(alternateMatch[2])
    working = cleanText(alternateMatch[3])
  } else {
    alternateMatch = working.match(/^#\s*(\d+(?:\.\d+)?)\b\s*-\s*(.+)$/)
    if (alternateMatch) {
      const alternateSeries = parentFolder(comic)
      if (alternateSeries) result.alternateSeries = alternateSeries
      result.alternateNumber = issueNumber(alternateMatch[1])
      working = cleanText(alternateMatch[2])
    } else {
      alternateMatch = working.match(/^(.+?)\s*#\s*(\d+(?:\.\d+)?)\b\s*-\s*(.+)$/)
      if (alternateMatch && isEventPrefix(alternateMatch[1], comic)) {
        result.alternateSeries = cleanText(alternateMatch[1])
        result.alternateNumber = issueNumber(alternateMatch[2])
        working = cleanText(alternateMatch[3])
      }
    }
  }

  const ofMatch = working.match(/\s*\(\s*of\s*(\d+)\s*\)\s*$/i)
  const trailingCount = issueNumber(ofMatch?.[1])
  if (ofMatch) working = cleanText(working.slice(0, ofMatch.index))

  let series = ''
  let number = ''
  let suffix = ''
  const numberedSeries = working.match(/^(.+?)\s*#\s*(\d+(?:\.\d+)?)\b(.*)$/)
  const dashedSeries = isTradePaperback ? null : working.match(/^(.+?)\s*-\s*(\d+(?:\.\d+)?)$/)
  const trailingNumberSeries = isTradePaperback ? null : working.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/)
  if (numberedSeries) {
    series = cleanText(numberedSeries[1])
    number = issueNumber(numberedSeries[2])
    suffix = cleanText(numberedSeries[3])
  } else if (dashedSeries) {
    series = cleanText(dashedSeries[1])
    number = issueNumber(dashedSeries[2])
  } else if (trailingNumberSeries) {
    series = cleanText(trailingNumberSeries[1])
    number = issueNumber(trailingNumberSeries[2])
  } else {
    series = working
  }

  const volumeMatch = series.match(/\s+\bv(?:ol(?:ume)?)?\.?\s*(\d+)\b/i)
  if (volumeMatch) {
    result.volume = issueNumber(volumeMatch[1])
    series = cleanText(series.replace(volumeMatch[0], ' '))
  }
  if (series) {
    result.series = series
    result.title = series
  }
  if (number) result.number = number

  if (suffix) {
    const arc = suffix.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/)
    if (arc && trailingCount) {
      result.storyArc = cleanText(arc[1])
      result.arcNumber = issueNumber(arc[2])
      result.arcCount = trailingCount
    } else {
      result.storyArc = suffix
      if (trailingCount) result.arcCount = trailingCount
    }
  } else if (trailingCount) {
    result.count = trailingCount
  }

  return result
}