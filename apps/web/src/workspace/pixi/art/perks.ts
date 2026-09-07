import type { PixelGrid, PixelPalette } from "./pixel-texture";

/**
 * Office perks: the furniture a room gets when nobody is using it for work.
 *
 * Everything here is decoration in the strictest sense. A perk occupies no
 * seat, is never a station an Agent walks to, and carries no state — the room
 * behaves identically whether all of them are on or none are. They stand in
 * the open floor below the corridor ring, in fixed slots chosen to miss the
 * plants and the walking routes, so turning several on can never produce a
 * pile-up or block a route.
 */

/**
 * One palette for every perk, so a new piece of furniture costs a grid and
 * nothing else.
 *
 *   k outline     m metal      w white/glass   s screen
 *   t table       T table shade
 *   b wood        B wood shade
 *   r red         o orange     y yellow        g green
 *   a accent      p pink       n net
 */
export const PERK_PALETTE: PixelPalette = {
  k: "#2f2b26",
  m: "#8b90a2",
  w: "#eef2f8",
  s: "#39405a",
  t: "#3f7fa6",
  T: "#2f6382",
  b: "#a3876a",
  B: "#7d6549",
  r: "#c55353",
  o: "#d89a3a",
  y: "#e3c05a",
  g: "#4f8a5c",
  a: "#6954d9",
  p: "#c07ba0",
  n: "#f4f2ec",
};

const PING_PONG: PixelGrid = [
  "................................",
  "......w.........................",
  "..............knnk..............",
  "..............knnk......krrk....",
  "kkkkkkkkkkkkkkknnkkkkkkkkkkkkkkk",
  "kttttttttttttttnnttttttttttttttk",
  "kttttttttttttttnnttttttttttttttk",
  "kTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTk",
  "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
  "....k......................k....",
  "....k......................k....",
  "....k......................k....",
  "....k......................k....",
  "................................",
];

const FOOSBALL: PixelGrid = [
  "............................",
  "kkkkkkkkkkkkkkkkkkkkkkkkkkkk",
  "kggggggggggggggggggggggggggk",
  "kgmmgggmmgggmmgggmmgggmmgggk",
  "kggggggggggggggggggggggggggk",
  "kgmmgggmmgggmmgggmmgggmmgggk",
  "kggggggggggggggggggggggggggk",
  "kkkkkkkkkkkkkkkkkkkkkkkkkkkk",
  "kBBBBBBBBBBBBBBBBBBBBBBBBBBk",
  "kkkkkkkkkkkkkkkkkkkkkkkkkkkk",
  "..k......................k..",
  "..k......................k..",
  "..k......................k..",
  "............................",
];

const COFFEE_BAR: PixelGrid = [
  "..............",
  "...kkkkkkkk...",
  "...kmmmmmmk...",
  "...kmssssmk...",
  "...kmssssmk...",
  "...kmmmmmmk...",
  "...kmmrrmmk...",
  "...kmmmmmmk...",
  "...kk.mm.kk...",
  "....k.ww.k....",
  "kkkkkkkkkkkkkk",
  "kbbbbbbbbbbbbk",
  "kBBBBBBBBBBBBk",
  "kkkkkkkkkkkkkk",
  ".k..........k.",
  ".k..........k.",
  ".k..........k.",
  "..............",
];

const ARCADE: PixelGrid = [
  "............",
  "..kkkkkkkk..",
  "..kaaaaaak..",
  "..kassssak..",
  "..kassssak..",
  "..kassssak..",
  "..kaaaaaak..",
  "..kayyyyak..",
  "..kaaaaaak..",
  "..karraaak..",
  "..kaaaaaak..",
  "..kkkkkkkk..",
  "..kaaaaaak..",
  "..kaaaaaak..",
  "..kaaaaaak..",
  "..kaaaaaak..",
  "..kaaaaaak..",
  "..kaaaaaak..",
  "..kkkkkkkk..",
  "............",
];

const SNACK_WALL: PixelGrid = [
  "............",
  ".kkkkkkkkkk.",
  ".krrrrrrrrk.",
  ".krwwwwwwrk.",
  ".krwoowoork.",
  ".krwoowoork.",
  ".krwwwwwwrk.",
  ".krwyywyyrk.",
  ".krwyywyyrk.",
  ".krwwwwwwrk.",
  ".krwggwggrk.",
  ".krwggwggrk.",
  ".krwwwwwwrk.",
  ".krrrrrrrrk.",
  ".krkkkkkkrk.",
  ".krrrrrrrrk.",
  ".kkkkkkkkkk.",
  ".k........k.",
  ".k........k.",
  "............",
];

const BEANBAGS: PixelGrid = [
  "................",
  "...kkkk...kkkk..",
  "..kooook.kppppk.",
  "..kooook.kppppk.",
  "..kkkkkk.kkkkkk.",
  "................",
];

const NAP_POD: PixelGrid = [
  "....................",
  ".....kkkkkkkkkk.....",
  "...kkaaaaaaaaaakk...",
  "..kaaaaaaaaaaaaaak..",
  "..kaassssssssssaak..",
  "..kaassssssssssaak..",
  "..kaaaaaaaaaaaaaak..",
  "..kkaaaaaaaaaaaakk..",
  "...kkkkkkkkkkkkkk...",
  "....k..........k....",
  "....k..........k....",
  "...kkk........kkk...",
  "....................",
];

const OFFICE_DOG: PixelGrid = [
  "..........",
  "..kk...kk.",
  ".kbbk.kbbk",
  ".kbbbbbbbk",
  "kbbwbbbbbk",
  "kbbbbbbbbk",
  ".k.k..k.k.",
  "..........",
];

export interface PerkDefinition {
  id: PerkId;
  /** What the toggle says. */
  label: string;
  /** One line for the toggle's help text. */
  note: string;
  grid: PixelGrid;
  /** Bottom-centre anchor, in world units. */
  x: number;
  y: number;
}

export type PerkId =
  | "pingPong"
  | "foosball"
  | "coffeeBar"
  | "arcade"
  | "snackWall"
  | "beanbags"
  | "napPod"
  | "officeDog";

/**
 * Fixed slots along the open floor south of the bottom corridor (y 212+).
 *
 * Hard-coded rather than packed at runtime so the room looks the same every
 * time it is drawn, and so the gaps between the four standing plants at
 * x = 30, 120, 232 and 300 are respected no matter which perks are on.
 */
export const PERKS: readonly PerkDefinition[] = [
  {
    id: "pingPong",
    label: "Ping-pong table",
    note: "The one every office photo has.",
    grid: PING_PONG,
    x: 75,
    y: 252,
  },
  {
    id: "coffeeBar",
    label: "Espresso bar",
    note: "Free coffee, the original perk.",
    grid: COFFEE_BAR,
    x: 104,
    y: 254,
  },
  {
    id: "foosball",
    label: "Foosball table",
    note: "For settling design arguments.",
    grid: FOOSBALL,
    x: 150,
    y: 252,
  },
  {
    id: "arcade",
    label: "Arcade cabinet",
    note: "Two credits, no quarters needed.",
    grid: ARCADE,
    x: 180,
    y: 254,
  },
  {
    id: "officeDog",
    label: "Office dog",
    note: "Attends every stand-up. Contributes little.",
    grid: OFFICE_DOG,
    x: 206,
    y: 256,
  },
  {
    id: "snackWall",
    label: "Snack wall",
    note: "Stocked daily, empty by eleven.",
    grid: SNACK_WALL,
    x: 255,
    y: 254,
  },
  {
    id: "beanbags",
    label: "Beanbags",
    note: "Impossible to get out of gracefully.",
    grid: BEANBAGS,
    x: 278,
    y: 256,
  },
  {
    id: "napPod",
    label: "Nap pod",
    note: "For the humans. The Agents do not use it.",
    grid: NAP_POD,
    x: 340,
    y: 254,
  },
];

export const PERK_IDS: readonly PerkId[] = PERKS.map((perk) => perk.id);

export function isPerkId(value: string): value is PerkId {
  return (PERK_IDS as readonly string[]).includes(value);
}
