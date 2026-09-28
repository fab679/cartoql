import { useCallback, useRef } from 'react'

/**
 * A column drag handle: pointer-captured resize between panels. No libraries —
 * pointer events + one moving callback; double-click resets to the default.
 */
export function ColumnResize({
  onResize,
  onReset,
  ariaLabel,
}: {
  readonly onResize: (deltaPx: number) => void
  readonly onReset: () => void
  readonly ariaLabel: string
}) {
  const dragFrom = useRef<number | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      dragFrom.current = event.clientX
    },
    [],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragFrom.current === null) return
      const delta = event.clientX - dragFrom.current
      if (delta === 0) return
      dragFrom.current = event.clientX
      onResize(delta)
    },
    [onResize],
  )

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId)
    dragFrom.current = null
  }, [])

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onResize(-24) }
        if (event.key === 'ArrowRight') { event.preventDefault(); onResize(24) }
      }}
      className="col-resize w-[3px] shrink-0 cursor-col-resize bg-line transition-colors hover:bg-brass/60"
    />
  )
}
