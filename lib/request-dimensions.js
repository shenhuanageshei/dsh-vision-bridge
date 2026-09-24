/**
 * Oversized-file guard (design §6/§11-O5): `lib/index.js` must stay within its
 * line ceiling, so the pure geometry it needs lives in this own module. The
 * attachment request size used to be derived by the host; on 0.1.7 the caller
 * passes a request target instead, so the projection runs on this side.
 */

/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel budget.
 *
 * Ported from the host's `@deepseek-ai/dsh-attachment` request-projection
 * geometry (`lib/index.js`, `requestImageDimensions`) — kept per-branch
 * identical to that implementation so both generations project to the same
 * numbers. The projection is idempotent: an already-projected size projects to
 * itself, so projecting twice changes nothing.
 *
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns inward-rounded dimensions; small images are not enlarged.
 */
export function projectRequestDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
  }
  return { width: projectedWidth, height: projectedHeight };
}
