/**
 * Bakes the mascot body catalog into `shared/mascot-bodies.ts`. Run with `pnpm gen:bodies`.
 *
 * Fails with a non-zero exit if any expression would clip at any body's final anchor at
 * any aim: fix the geometry, never the check.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { MOUTH_STROKE } from "../src/components/cursor-face-data.ts"
import { BODY_DEFS, type BodyDef } from "./mascot-bodies/builders.ts"
import { applyFit, boundsOf, fitTransform, flatten } from "./mascot-bodies/geometry.ts"
import { maskFromPolylines } from "./mascot-bodies/raster.ts"
import { fieldFromMask, largestInscribedCircle, type Sdf } from "./mascot-bodies/sdf.ts"
import { buildClouds, maxScaleAt, report } from "./mascot-bodies/solve.ts"

const DEFAULT_ID = "cursor"

/** The avatar renders every expression facing forward, which zeroes the authored gaze. */
const LOOK_AROUND = 0

const AIMS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
] as const

/** Mask resolution. 256 puts a pixel at ~0.9 face-space units. */
const RASTER_SIZE = 256

interface Anchor {
  x: number
  y: number
  scale: number
}

type Fit = ReturnType<typeof fitTransform>

interface Solved {
  def: BodyDef
  fit: Fit
  sdf: Sdf
  scale: number
  seed: Anchor
}

const CLOUD_SETS = AIMS.map(aim => buildClouds(LOOK_AROUND, MOUTH_STROKE, aim))

/** Pooled, not solved per aim: a face has one anchor, so the four aims constrain the same
 * placement. */
const ALL_CLOUDS = CLOUD_SETS.flat()

/** The scale cap. 1.0 reproduces the proportions the expressions were drawn at. */
const CAP = 1

function solveBody(def: BodyDef): Solved {
  // `def.viewBox` is advisory and wrong for two bodies; bounds come from the outline.
  const polylines = flatten(def.d)
  const fit = fitTransform(boundsOf(polylines))
  const mask = maskFromPolylines(applyFit(polylines, fit), RASTER_SIZE)
  const sdf = fieldFromMask(mask, RASTER_SIZE)

  // Seed at the largest inscribed circle, then sweep outward coarse to fine. Every level
  // runs (no early break): a ring that improves nothing says nothing about the next one.
  const circle = largestInscribedCircle(sdf)
  let best: Anchor = {
    x: circle.x,
    y: circle.y,
    scale: maxScaleAt(ALL_CLOUDS, sdf, circle.x, circle.y, CAP),
  }
  let step = Math.max(circle.radius, 12)
  for (let level = 0; level < 8; level++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue
        const x = best.x + dx * step
        const y = best.y + dy * step
        const scale = maxScaleAt(ALL_CLOUDS, sdf, x, y, CAP)
        if (scale > best.scale + 1e-4) best = { x, y, scale }
      }
    }
    step /= 2
  }

  // Rounding can nudge a marginal expression back over the edge, so round first and then
  // walk the scale down until the rounded numbers are clean.
  const seed: Anchor = {
    x: round(best.x, 2),
    y: round(best.y, 2),
    scale: Math.max(Math.floor(best.scale * 1000) / 1000, 0.02),
  }
  for (let i = 0; i < 40 && seed.scale > 0.02 && clearanceAt(sdf, seed) < 0; i++) {
    seed.scale = round(seed.scale - 0.005, 3)
  }

  return { def, fit, sdf, scale: seed.scale, seed }
}

/** Negative means something clips. */
function clearanceAt(sdf: Sdf, anchor: Anchor): number {
  let worst = Infinity
  for (const clouds of CLOUD_SETS) {
    const c = report(clouds, sdf, anchor).clearance
    if (c < worst) worst = c
  }
  return worst
}

function clippingAt(sdf: Sdf, anchor: Anchor): number[][] {
  return CLOUD_SETS.map(clouds => report(clouds, sdf, anchor).clipping)
}

const round = (n: number, places: number) => Number(n.toFixed(places))

/** Candidates are rounded to emit precision before scoring, so the winning anchor is one
 * that was actually measured. */
function anchorAt(sdf: Sdf, seed: Anchor, scale: number): Anchor {
  const circle = largestInscribedCircle(sdf)
  const candidates: Anchor[] = [
    { x: round(seed.x, 2), y: round(seed.y, 2), scale },
    { x: round(circle.x, 2), y: round(circle.y, 2), scale },
  ]
  let best = candidates[0]
  let bestClearance = clearanceAt(sdf, best)
  for (const candidate of candidates.slice(1)) {
    const clearance = clearanceAt(sdf, candidate)
    if (clearance > bestClearance) {
      best = candidate
      bestClearance = clearance
    }
  }

  let step = Math.max(circle.radius, 12)
  for (let level = 0; level < 7; level++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue
        const candidate = {
          x: round(best.x + dx * step, 2),
          y: round(best.y + dy * step, 2),
          scale,
        }
        const clearance = clearanceAt(sdf, candidate)
        if (clearance > bestClearance) {
          best = candidate
          bestClearance = clearance
        }
      }
    }
    step /= 2
  }
  return best
}

const quote = (s: string) => JSON.stringify(s)

interface Baked {
  id: string
  name: string
  fit: Fit
  d: string
  anchor: Anchor
  clearance: number
  /** Only the Kotlin catalog carries them: Android's native path bounds are the cubic
   * control hull, which is wider than the drawn shape. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

function emit(bodies: Baked[]): string {
  const ids = bodies.map(s => quote(s.id)).join(", ")
  const entries = bodies
    .map(body =>
      [
        `  ${body.id}: {`,
        `    id: ${quote(body.id)},`,
        `    name: ${quote(body.name)},`,
        `    fit: ${quote(body.fit.transform)},`,
        `    body: ${quote(`<path fill="{{GRADIENT}}" d="${body.d}"/>`)},`,
        `    clip: ${quote(`<path d="${body.d}"/>`)},`,
        `    anchor: { x: ${body.anchor.x}, y: ${body.anchor.y}, scale: ${body.anchor.scale} },`,
        `  },`,
      ].join("\n")
    )
    .join("\n")

  return `/**
 * The mascot bodies a bot can wear.
 *
 * GENERATED FILE — do not hand-edit. Run \`pnpm gen:bodies\` to rebuild it from
 * \`scripts/gen-mascot-bodies.ts\`, which solves each face placement against the real
 * expression geometry and verifies that nothing clips.
 *
 * Every body carries the same face at the same size: the generator clamps the whole
 * catalog to the smallest face any one body can hold, so the mascot reads as one
 * character in different bodies rather than ten different mascots. Roomier bodies simply
 * end up with more margin around the face.
 *
 * The fields match \`CursorSilhouette\` exactly, so a body can be handed to the renderer
 * with no adapter in between.
 */

import { z } from "zod";

/** Every selectable body id, in the order the picker shows them. */
export const MASCOT_BODY_IDS = [${ids}] as const;

export type MascotBodyId = (typeof MASCOT_BODY_IDS)[number];

export const mascotBodySchema = z.enum(MASCOT_BODY_IDS);

export interface MascotBody {
  id: MascotBodyId;
  /** Human-readable name, used for the picker and the accessible label. */
  name: string;
  /** Transform mapping the outline into the face box. */
  fit: string;
  /** Body markup. \`{{GRADIENT}}\` is replaced with the bot's own gradient. */
  body: string;
  /** The same outline without a fill, used as the clip region. */
  clip: string;
  /** Where the face sits inside the body, in face-space units. */
  anchor: { x: number; y: number; scale: number };
}

/** The shipped mascot, and the fallback for any unrecognised value. */
export const DEFAULT_MASCOT_BODY: MascotBodyId = ${quote(DEFAULT_ID)};

export const MASCOT_BODIES: Record<MascotBodyId, MascotBody> = {
${entries}
};

/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botMascotBody(value: unknown): MascotBodyId {
  return mascotBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;
}
`
}

function main(): void {
  const solved = BODY_DEFS.map(solveBody)

  const cursor = solved.find(s => s.def.id === DEFAULT_ID)
  if (!cursor) throw new Error(`the catalog has no ${DEFAULT_ID} body to anchor its face size to`)

  const width = Math.max(...solved.map(s => s.def.id.length))
  console.log("largest face each body can hold, worst of the four pointer aims:")
  for (const body of solved) {
    console.log(`  ${body.def.id.padEnd(width)}  ${body.scale.toFixed(3).padStart(6)}`)
  }
  console.log("")

  const shared = solved.reduce((min, s) => Math.min(min, s.scale), Infinity)
  if (shared < cursor.scale) {
    const tighter = solved
      .filter(s => s.scale < cursor.scale)
      .map(s => `${s.def.id} (${s.scale})`)
      .join(", ")
    throw new Error(
      `the shared face scale ${shared} is below ${DEFAULT_ID}'s own ${cursor.scale}: ` +
        `${tighter} cannot hold the shipped face, so clamping the catalog would shrink ` +
        `the mascot everyone already has. Widen those outlines rather than lowering the floor.`
    )
  }

  const baked: Baked[] = []
  const clipped: string[] = []
  for (const body of solved) {
    const anchor = anchorAt(body.sdf, body.seed, shared)
    const clipping = clippingAt(body.sdf, anchor)
    clipping.forEach((expressions, i) => {
      if (expressions.length === 0) return
      const aim = AIMS[i]
      clipped.push(`${body.def.id} aim (${aim.x}, ${aim.y}): expressions ${expressions.join(", ")}`)
    })
    const fitted = boundsOf(applyFit(flatten(body.def.d), body.fit))
    baked.push({
      id: body.def.id,
      name: body.def.name,
      fit: body.fit,
      d: body.def.d,
      anchor,
      clearance: clearanceAt(body.sdf, anchor),
      bounds: {
        minX: round(fitted.minX, 4),
        minY: round(fitted.minY, 4),
        maxX: round(fitted.maxX, 4),
        maxY: round(fitted.maxY, 4),
      },
    })
  }

  console.log(`shared face scale ${shared} (${DEFAULT_ID}'s own floor is ${cursor.scale})`)
  console.log(`${"body".padEnd(width)}  ${"scale".padStart(6)}  ${"clearance".padStart(9)}`)
  for (const body of baked) {
    const scale = body.anchor.scale.toFixed(3).padStart(6)
    const clearance = body.clearance.toFixed(1).padStart(9)
    console.log(`${body.id.padEnd(width)}  ${scale}  ${clearance}`)
  }

  if (clipped.length > 0) {
    throw new Error(
      `the face clips at ${clipped.length} placement(s):\n  ${clipped.join("\n  ")}\n` +
        `An outline or the face data is wrong. Fix the geometry — this check is the ` +
        `whole point of the generator and must not be relaxed.`
    )
  }

  const out = fileURLToPath(new URL("../shared/mascot-bodies.ts", import.meta.url))
  writeFileSync(out, emit(baked))
  console.log(`wrote ${out}`)

}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
