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
