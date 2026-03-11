export interface BoundsRect {
  x: number
  y: number
  width: number
  height: number
}

interface TrackAreaInput {
  cursor: { x: number, y: number }
  gameBounds?: BoundsRect
  overlayBounds: BoundsRect
  panelWidthCss: number
  widgetWidthCss: number
  devicePixelRatio: number
  isLinux: boolean
}

export interface PriceCheckTrackArea {
  area: BoundsRect
  side: 'stash' | 'inventory'
  usedLinuxFallback: boolean
  anchorBounds: BoundsRect
}

export function computePriceCheckTrackArea (input: TrackAreaInput): PriceCheckTrackArea {
  const authoritativeBounds = isFiniteBounds(input.gameBounds)
    ? input.gameBounds
    : undefined
  const anchorBoundsRaw = (input.isLinux && authoritativeBounds)
    ? authoritativeBounds
    : input.overlayBounds
  const anchorBounds = input.isLinux
    ? roundBounds((authoritativeBounds != null) ? anchorBoundsRaw : scaleBounds(anchorBoundsRaw, input.devicePixelRatio))
    : anchorBoundsRaw
  const usedLinuxFallback = Boolean(input.isLinux && !authoritativeBounds)

  const unitScale = input.isLinux ? input.devicePixelRatio : 1
  const widgetWidth = input.isLinux
    ? Math.round(input.widgetWidthCss * unitScale)
    : input.widgetWidthCss
  const panelWidth = input.isLinux
    ? Math.round(input.panelWidthCss * unitScale)
    : input.panelWidthCss

  const middleX = anchorBounds.x + anchorBounds.width / 2
  const side = input.cursor.x > middleX ? 'inventory' : 'stash'

  const x = side === 'inventory'
    ? anchorBounds.x + anchorBounds.width - panelWidth - widgetWidth
    : anchorBounds.x + panelWidth

  const areaRaw = {
    x,
    y: anchorBounds.y,
    width: widgetWidth,
    height: anchorBounds.height
  }

  return {
    area: input.isLinux ? roundBounds(areaRaw) : areaRaw,
    side,
    usedLinuxFallback,
    anchorBounds
  }
}

function isFiniteBounds (value?: BoundsRect): value is BoundsRect {
  if (value == null) return false

  return Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
}


function roundBounds (bounds: BoundsRect): BoundsRect {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}


function scaleBounds (bounds: BoundsRect, scale: number): BoundsRect {
  return {
    x: bounds.x * scale,
    y: bounds.y * scale,
    width: bounds.width * scale,
    height: bounds.height * scale
  }
}
