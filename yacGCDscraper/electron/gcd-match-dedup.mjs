function candidateQuality(candidate) {
  return [
    candidate.variantOfId === null || candidate.variantOfId === undefined || candidate.id === candidate.variantOfId ? 1 : 0,
    candidate.title ? 1 : 0,
    candidate.onSaleDate ? 1 : 0,
    candidate.pageCount ? 1 : 0,
    candidate.barcode ? 1 : 0,
  ].reduce((total, value) => total + value, 0)
}

export function canonicalGcdCandidates(candidates) {
  const variants = new Map()
  candidates.forEach((candidate) => {
    const identity = candidate.variantOfId || candidate.id
    const existing = variants.get(identity)
    if (!existing || candidate.score > existing.score || (candidate.score === existing.score && candidateQuality(candidate) > candidateQuality(existing))) variants.set(identity, candidate)
  })
  const deduplicated = [...variants.values()].sort((left, right) => right.score - left.score || candidateQuality(right) - candidateQuality(left) || left.id - right.id)
  return deduplicated[0]?.score === 100 && deduplicated[1]?.score < 100 ? [deduplicated[0]] : deduplicated
}