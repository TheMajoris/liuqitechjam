import type { PixelGrid } from "./pixel-texture";

/**
 * Original pixel art for the workspace, authored as character grids.
 *
 * One character is one pixel; `.` is transparent. Colours are supplied by a
 * palette at rasterisation time, so a single body drawing serves every Agent
 * and no per-Agent artwork has to be produced by hand. Nothing here is
 * third-party art, so there is nothing to attribute.
 *
 * Legend
 *   k outline      h hair        H hair highlight
 *   s skin         S skin shade  c shirt            C shirt shade
 *   a accent       p trousers    b shoes            w lens / glass
 */

export const AVATAR_SIZE = { width: 16, height: 24 } as const;

/** Standing/seated pose. Legs sit behind the desk when the Agent is seated. */
const BODY_STAND: PixelGrid = [
  "................",
  "................",
  "....kkkkkkkk....",
  "...khhhhhhhhk...",
  "..khhhhhhhhhhk..",
  "..khhsssssshhk..",
  "..khssssssssHk..",
  "..khssssssssHk..",
  "..kksssssssskk..",
  "...kSssssssSk...",
  "....kssssssk....",
  ".....kssssk.....",
  "....kcccccck....",
  "..kkcccaaccckk..",
  "..kscccaacccsk..",
  "..kscccaacccsk..",
  "..ksccccccccsk..",
  "..ksccccccccsk..",
  "...kCCCCCCCCk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppp..pppk...",
  "...kbbk..kbbk...",
  "................",
];

/** Stride out. Only the legs differ, which is all the eye needs at this size. */
const BODY_WALK_A: PixelGrid = [
  ...BODY_STAND.slice(0, 21),
  "..kppk..kppk....",
  ".kbbbk...kbbk...",
  "................",
];

const BODY_WALK_B: PixelGrid = [
  ...BODY_STAND.slice(0, 21),
  "....kppppppk....",
  "....kbbkkbbk....",
  "................",
];

export const AVATAR_BODIES = {
  stand: BODY_STAND,
  walkA: BODY_WALK_A,
  walkB: BODY_WALK_B,
} as const;

export type AvatarBody = keyof typeof AVATAR_BODIES;

/** Faces overlay the head at this offset. 8x4, drawn over plain skin. */
export const FACE_OFFSET = { x: 4, y: 6 } as const;

export const AVATAR_FACES = {
  neutral: ["........", ".ee..ee.", "........", "...mm..."],
  focus: [".kk..kk.", ".ee..ee.", "........", "..mmmm.."],
  think: ["........", "..e..e..", "........", "...mm..."],
  happy: ["........", ".ee..ee.", "..m..m..", "...mm..."],
  worried: [".k....k.", ".ee..ee.", "........", "..mmmm.."],
  sleep: ["........", ".mm..mm.", "........", "...mm..."],
} as const satisfies Record<string, PixelGrid>;

export type AvatarFace = keyof typeof AVATAR_FACES;

/** Forearms reaching to the keyboard. Two frames make the typing loop. */
export const HANDS_OFFSET = { x: 4, y: 16 } as const;

export const AVATAR_HANDS = {
  a: ["ss....ss", "........"],
  b: ["........", "ss....ss"],
} as const satisfies Record<string, PixelGrid>;

export type AvatarHands = keyof typeof AVATAR_HANDS;

/** Accessories make Agents distinguishable without bespoke artwork. */
export const ACCESSORY_OFFSET = { x: 2, y: 2 } as const;

export const AVATAR_ACCESSORIES = {
  none: ["............"],
  glasses: [
    "............",
    "............",
    "............",
    "............",
    ".kwwkkkwwk..",
    ".kkk...kkk..",
  ],
  cap: [
    "..kkkkkkkk..",
    ".kaaaaaaaak.",
    "kaaaaaaaaaak",
    "kkkkkkkkkkkk",
  ],
  headset: [
    "...kkkkkk...",
    "..k......k..",
    ".ka......ak.",
    ".ka......ak.",
    ".kk......kk.",
  ],
} as const satisfies Record<string, PixelGrid>;

export type AvatarAccessory = keyof typeof AVATAR_ACCESSORIES;

export const ACCESSORY_ORDER: AvatarAccessory[] = ["none", "glasses", "headset", "cap"];

/** A task sheet, used for the board card and the handoff animation. */
export const TASK_SHEET: PixelGrid = [
  "kkkkkkkk",
  "kwwwwwwk",
  "kwaaawwk",
  "kwwwwwwk",
  "kwaaaawk",
  "kwwwwwwk",
  "kwaaawwk",
  "kkkkkkkk",
];

/** Potted plant, for the corners of the room. */
export const PLANT: PixelGrid = [
  "...gg...",
  "..gggg..",
  ".gg.ggg.",
  "gg.g.ggg",
  ".gggggg.",
  "...gg...",
  "..kkkk..",
  "..kppk..",
  "..kppk..",
  "...kk...",
];

/** Monitor content. Rotating the rows gives the "code is scrolling" frames. */
export const SCREEN_CODE: PixelGrid = [
  "llll.lll..........",
  "..llllll.lll......",
  "llll.ll...........",
  ".llllll.llll......",
  "lll.ll............",
  "..lllll.ll........",
  "llll.lll.lll......",
  "..lll.............",
  "lll.lllll.ll......",
  ".llll.ll..........",
  "ll.lll............",
];

/** Dim, static content for a monitor whose Agent is not running. */
export const SCREEN_RESTING: PixelGrid = [
  "..................",
  "...lll.lll........",
  "..................",
  "..ll.ll...........",
  "..................",
  "...llll...........",
  "..................",
  "..ll..............",
  "..................",
  "...lll.l..........",
  "..................",
];

export function rotateRows(grid: PixelGrid, offset: number): PixelGrid {
  if (grid.length === 0) return grid;
  const shift = ((offset % grid.length) + grid.length) % grid.length;
  return [...grid.slice(shift), ...grid.slice(0, shift)];
}

export const SCREEN_FRAME_COUNT = 4;

/* ==========================================================================
   Figure: the silhouette an Agent's character is drawn with.

   One body drawing still serves every Agent; the figure adds a small overlay
   on top of it. Doing it as overlays rather than three full body sets keeps
   the walk cycle, the hands, and the face offsets in exactly one place, so a
   change to the pose cannot drift between figures.

   These are presentation only. Nothing about an Agent's capabilities, its
   role, or its permissions is derived from the figure it is drawn with.
   ========================================================================== */

export const AVATAR_FIGURES = ["neutral", "feminine", "masculine"] as const;
export type AvatarFigure = (typeof AVATAR_FIGURES)[number];

/** Hair overlays sit over the head and shoulders, starting two rows down. */
export const FIGURE_HAIR_OFFSET = { x: 0, y: 2 } as const;

export const AVATAR_FIGURE_HAIR = {
  // The base drawing already carries a mid-length cut.
  neutral: ["................"],
  // Long hair falling either side of the head, ending at the shoulder.
  feminine: [
    "................",
    "................",
    "................",
    ".k............k.",
    ".kh..........hk.",
    ".kh..........hk.",
    ".kh..........hk.",
    ".kh..........hk.",
    ".khh........hhk.",
    ".khh........hhk.",
    ".kh..........hk.",
    "..k..........k..",
  ],
  // A flat crop with sideburns.
  masculine: [
    "................",
    "................",
    "................",
    "...hhhhhhhhhh...",
    "................",
    "................",
    "...h........h...",
  ],
} as const satisfies Record<AvatarFigure, PixelGrid>;

/** Outfit overlays replace the hip rows, so the walk frames stay untouched. */
export const FIGURE_OUTFIT_OFFSET = { x: 0, y: 19 } as const;

export const AVATAR_FIGURE_OUTFIT = {
  neutral: ["................"],
  // A flared hem over the trousers, which still show through below it.
  feminine: [
    "..kCCCCCCCCCCk..",
    ".kCCCCCCCCCCCCk.",
  ],
  masculine: ["................"],
} as const satisfies Record<AvatarFigure, PixelGrid>;

/* ==========================================================================
   Robot crew.

   A whole-room alternative to the people: same poses, same stations, same
   state vocabulary, drawn as machines that stand at their desks. The idle
   life — wandering, breaks, dozing — is deliberately switched off for them,
   because "always at its post" is the entire point of the mode.
   ========================================================================== */

const BOT_STAND: PixelGrid = [
  "................",
  ".......kk.......",
  "......kaak......",
  "....kkkkkkkk....",
  "...kmmmmmmmmk...",
  "...kmwwwwwwmk...",
  "...kmwaaaawmk...",
  "...kmwwwwwwmk...",
  "...kmmmmmmmmk...",
  "....kmmmmmmk....",
  ".....kmmmmk.....",
  ".....kmmmmk.....",
  "....kcccccck....",
  "..kkcccaaccckk..",
  "..kmcccaacccmk..",
  "..kmcccaacccmk..",
  "..kmccccccccmk..",
  "..kmccccccccmk..",
  "...kCCCCCCCCk...",
  "...kmmmmmmmmk...",
  "...kmmmmmmmmk...",
  "...kmmm..mmmk...",
  "...kbbk..kbbk...",
  "................",
];

const BOT_WALK_A: PixelGrid = [
  ...BOT_STAND.slice(0, 21),
  "..kmmk..kmmk....",
  ".kbbbk...kbbk...",
  "................",
];

const BOT_WALK_B: PixelGrid = [
  ...BOT_STAND.slice(0, 21),
  "....kmmmmmmk....",
  "....kbbkkbbk....",
  "................",
];

export const ROBOT_BODIES = {
  stand: BOT_STAND,
  walkA: BOT_WALK_A,
  walkB: BOT_WALK_B,
} as const satisfies Record<AvatarBody, PixelGrid>;

/**
 * The visor, as an eight-by-four overlay on the same offsets the faces use.
 *
 * A robot reports state with its lamp rather than an expression, so each entry
 * is the same bar at a different width or colour. `sleep` is a standby dot
 * rather than closed eyes: nothing here is ever asleep.
 */
export const ROBOT_FACES = {
  neutral: ["........", "..aaaa..", "........", "........"],
  focus: ["........", ".aaaaaa.", "........", "........"],
  think: ["........", "..a..a..", "........", "........"],
  happy: ["........", "..aaaa..", "...aa...", "........"],
  worried: ["........", "..ee.ee.", "........", "........"],
  sleep: ["........", "...ee...", "........", "........"],
} as const satisfies Record<AvatarFace, PixelGrid>;

/** Manipulators at the keyboard; the same two-frame loop as the hands. */
export const ROBOT_HANDS = {
  a: ["mm....mm", "........"],
  b: ["........", "mm....mm"],
} as const satisfies Record<AvatarHands, PixelGrid>;

/* ==========================================================================
   Leaving the office.

   Two props for the departure sequence: the notice that arrives, and the box
   the Agent carries out with it. Drawn in their own palette rather than the
   avatar's, because neither belongs to the character — cardboard is cardboard
   whatever colour shirt an Agent wears.

   Legend
     k outline    B cardboard   w tape / paper    r ink    g leaf
   ========================================================================== */

export const DEPARTURE_PALETTE = {
  k: "#2f2b26",
  B: "#c08c58",
  w: "#f4f2ec",
  r: "#c55353",
  g: "#4f8a5c",
} as const;

/** A packing box with a desk plant poking out of it. */
export const MOVING_BOX: PixelGrid = [
  "....gg.g....",
  "...gggggg...",
  "....g.g.....",
  "..kkkkkkkk..",
  "..kBBBBBBk..",
  "..kBwwwwBk..",
  "..kBBBBBBk..",
  "..kBBBBBBk..",
  "..kkkkkkkk..",
];

/** The notice, fluttering down. */
export const PINK_SLIP: PixelGrid = [
  "kkkkkkkk",
  "kwwwwwwk",
  "kwrrrrwk",
  "kwwwwwwk",
  "kwrrrwwk",
  "kwwwwwwk",
  "kwrrwwwk",
  "kkkkkkkk",
];
