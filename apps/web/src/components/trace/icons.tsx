/**
 * The observability views' glyph set.
 *
 * Drawn here rather than pulled from a package: the set is a dozen strokes,
 * and a dependency would ship a whole catalogue to render them. Every icon is
 * a 16-unit square on `currentColor`, so it inherits the colour and the
 * disabled state of the control it sits in.
 *
 * Icons are always `aria-hidden`. A control that shows only a glyph carries
 * its name in `aria-label` and `title`, never in the drawing — and only where
 * the glyph is conventional enough to be read without one. A tick and a cross
 * beside a search box read as confirm and cancel, so the outcome filter kept
 * its words and has no icon here.
 */
interface IconProps {
  /** Rendered size in pixels; the stroke is scaled with it. */
  size?: number;
}

function Glyph({ size = 14, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2 14 14" />
    </Glyph>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 3 5 8l5 5" />
    </Glyph>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 3 5 5-5 5" />
    </Glyph>
  );
}

/** Return to the list: an arrow, so it reads as leaving rather than stepping. */
export function BackIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13 8H3" />
      <path d="m7 4-4 4 4 4" />
    </Glyph>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M13.5 7a5.5 5.5 0 1 0-.6 3.4" />
      <path d="M13.6 3.3v3.4h-3.4" />
    </Glyph>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 2v7.5" />
      <path d="m5 7 3 3 3-3" />
      <path d="M2.75 12.5h10.5" />
    </Glyph>
  );
}

/** Ordering: a descending stack, which is what every sort here produces. */
export function SortIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 4.5h9" />
      <path d="M3 8h6" />
      <path d="M3 11.5h3" />
    </Glyph>
  );
}

/** Grouping: rows gathered into one row. */
export function GroupIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m8 2.5 5.5 3-5.5 3-5.5-3z" />
      <path d="m2.5 9.5 5.5 3 5.5-3" />
    </Glyph>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m4.5 4.5 7 7" />
      <path d="m11.5 4.5-7 7" />
    </Glyph>
  );
}
