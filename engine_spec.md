# Origami Folding Engine — Design & Implementation Specification (v1)

> Instruction document for the coding agent (Claude Code).
> Read this file fully before writing any code. Follow the milestones in §10 in order.
> This engine is a research artifact: **correctness guarantees matter more than features.**

---

## 0. Purpose and non-goals

### 0.1 What we are building

A simulator of **flat-folded origami states with layer ordering**, plus a three.js viewer.
The engine consumes discrete fold operations and maintains, at every step, a *provably valid*
folded state: face geometry, face orientation (front/back), and the stacking order of
overlapping paper layers. The viewer renders these states in 3D and animates individual folds.

The engine will later serve as the verification core of a research pipeline
(diagram → VLM-proposed op → engine → validity + render-and-compare). Therefore:

- Every operation must either succeed deterministically or fail with a **machine-readable
  reason** (§3.6). "Silently produce a wrong state" is never acceptable.
- The core must be **headless and pure** (no three.js, no DOM) so it can run in tests
  and in a server-side verification loop.

### 0.2 Guarantees the engine must provide (these are the point of the project)

- **G1 Closure.** Applying a valid operation to a valid state always yields a valid state
  (or a typed error, never a corrupt state).
- **G2 Determinism.** Same state + same op parameters → byte-identical serialized result.
  No randomness, no floating-point nondeterminism in the core.
- **G3 Checkability.** A standalone checker (§6) can validate any state against all
  invariants (§2.4) independently of how it was produced.

### 0.3 Non-goals for v1 (do NOT implement; see §11 for v2 hooks)

- Inside/outside reverse folds, squash, petal, sink, tucks/insertions (any op that places
  a moving flap *between* existing layers).
- Curved paper, open 3D intermediate states (non-flat dihedral angles at rest), thickness
  physics, cloth simulation.
- Diagram/SVG parsing and VLM interfacing (separate package later; the engine only takes
  explicit op parameters).

---

## 1. Architecture

### 1.1 Package layout (monorepo, TypeScript, strict mode)

```
packages/
  core/                 # PURE TypeScript. Zero deps on three.js / DOM.
    src/geom/           # Rational arithmetic, Vec2, Line, Segment, Polygon, predicates
    src/state/          # Face, CreaseEdge, Spot, FoldedState, History, serialization
    src/ops/            # fold(ALL | ONE_LAYER), flip, precrease, unfoldLast, movingSet
    src/check/          # invariant checker (I1–I6), precondition checks (P1–P2)
    src/render2d/       # top-view SVG projection Π(S)  (verification & paper figures)
    src/io/             # JSON schema, FOLD-format import/export
    test/               # vitest: unit + property + golden regression
  viewer/               # three.js + Vite app. Depends on core. UI only.
    src/build3d/        # state → ONE mesh: the source square, folded (two-sided materials)
    src/animate/        # timing curve; the fold itself is build3d's setProgress
    src/interact/       # face picking, axis candidates, validity preview
```

### 1.2 Hard rules for the coding agent

1. `core` never imports three.js, never touches `window`/`document`.
2. All core state objects are **immutable**. Ops are pure functions
   `apply(state, op) → Result`. History = list of `(op, stateRef)`.
3. All core geometry uses **exact rational arithmetic** (§5). `number` (float) appears
   only in `render2d` output attributes and in `viewer`.
4. Never merge faces, never simplify geometry "for cleanliness" — splits are part of the
   state's history and identity.
5. A milestone (§10) is done only when its acceptance tests pass. Do not start the next
   milestone with red tests.
6. When a design question is not answered by this document, add a `// SPEC-GAP:` comment
   and choose the most conservative option (reject the op rather than guess).

---

## 2. Mathematical model (definitions — these become Section 3 of the paper)

Coordinate convention: the paper lives in the *xy*-plane; the viewer looks down the −z axis;
"**above**" = closer to the viewer. A **valley** fold brings the moving flap up and over
(moving stack ends *above*); a **mountain** fold sends it behind (ends *below*).

### D1. Paper and source space

The paper `P` is a polygon in **source space** (default: unit square `[0,1]²`, CCW).
Source space never changes; it is where creases accumulate.

### D2. Faces and crease graph  *(user's term: "crease graph")*

The state maintains a polygonal mesh subdividing `P`:

- **Face** `f`: a convex or simple polygon in source space (CCW vertex list), with a unique
  stable `id`. Faces are created only by splitting existing faces; splits record parentage.
- **Edge** between two faces sharing a source-space segment. Each edge stores:
  - `kind`: `BOUNDARY` (paper edge), `CREASE` (has been **folded** — topology exists only
    where the isometry changes; unfolded crease *marks* are not edges, see pending
    creases below), `SPLIT` (artificial cut introduced by overlap normalization §2.3 or
    axis splitting; both sides currently have identical transforms).
  - for `CREASE`: `assignment ∈ {M, V}` — **intrinsic** to the paper (defined w.r.t. the
    front side of the sheet), *not* view-dependent. The view-dependent appearance
    (what a diagram would draw after flips) is computed, never stored. This distinction
    is a classic bug source; keep it.
- **Pending creases** (annotation layer, not topology): a list of
  `{ seg: [Vec2, Vec2] /* source space */, assignment: 'M'|'V' }` recording crease marks
  made by fold-and-unfold steps (§3.4). Source space never changes, so these need no
  maintenance under folds; their folded positions are computed through the owning faces'
  `T` on demand (axis-candidate enumeration §8.3, optional rendering §7, v2 collapse
  preconditions §11).

The **crease graph** is this mesh's dual: nodes = faces, arcs = shared edges.

### D3. Transforms and sides

Each face carries an isometry `T_f : source → folded` represented exactly as a 2×2 rational
matrix + rational translation, with `det(T_f) ∈ {+1, −1}`.

- Initial state: `T_f = identity` for the single face.
- Every fold composes a **reflection** about the (folded-space) axis line onto the moving
  faces' transforms. Reflections about lines through rational points are rational (§5).
- **Side rule:** `side(f) = front` iff `det(T_f) = +1`. Do **not** store a separate
  front/back flag; derive it. (Reflection parity ⇔ which face of the paper is up.)

**Invariant I1 (isometry continuity).** For every edge `(f,g)`:
if `kind = SPLIT`, then `T_f = T_g`;
if `kind = CREASE`, then `T_g = Refl(L) ∘ T_f` where `L` is the folded image
of the shared segment (both faces map the shared segment to the same folded segment).

### D4. Folded state, spots, layer order  *(user's term: "layer graph")*

**Congruent-overlap normal form (CONF).** The state is kept normalized so that any two
faces' folded polygons are either **identical** or have **disjoint interiors**. (This is
what "split partial overlaps into full overlaps" means, made precise.)

- **Spot** `S`: an equivalence class of faces with identical folded polygons.
  `spotId = canonicalHash(foldedPolygon)` (§5.4).
- **Stack.** For each spot, `stack(S)` = the list of its faces ordered bottom→top.
  This is the layer order. There is no global integer "layer number"; pairwise
  above/below relations are derived from stacks. Two faces are comparable iff they share
  a spot (in CONF, iff their folded polygons coincide).

**FoldedState** `= (faces, edges, transforms, spots/stacks, pendingCreases, history)`.

### D5. Flat-connectivity across spots

Faces `f ∈ stack(S)` and `f' ∈ stack(S')` of adjacent spots are **flat-connected across
boundary segment e** if they share a source-space edge of kind `SPLIT` — i.e., they are
the same physical sheet continuing across `e` with `T_f = T_{f'}`.

### D6. Dimensionality of the state ("2.5D" — read this if you expected xyz coordinates)

The state is a **layered flat-folded state**: exact 2D geometry plus a *discrete* layer
index per overlap region (the stack position). Core has **no continuous z**. This is
deliberate and **lossless** for our setting: at any flat step, the paper's 3D embedding is
fully determined by (folded 2D polygons, per-spot stack orders) up to paper thickness.
Continuous z exists only at render time (§8.1). Consequence for implementers:
"manage the state in 3D" ≡ "maintain the stacks correctly". Anything that genuinely
requires 3D poses (open, non-flat intermediates) is out of scope v1 (§11).

### D7. Flap (derived concept — never stored)

Given a state and a **hinge line** ℓ (folded space), a **flap** is a nonempty *proper*
subset of faces `M`, lying strictly on one side of ℓ, such that every source-space edge
between `M` and its complement has its folded image **on ℓ** (this is exactly P1).
Equivalently: the only place `M` is attached to the rest of the sheet is along ℓ, so `M`
can rotate rigidly about ℓ without tearing.

Properties implementers must internalize:

- **Face ≠ flap.** A face is an atomic stored polygon of the mesh; a flap is a set of
  faces *derived* for a given hinge. The engine never stores flaps — it computes the
  minimal flap containing a seed via the closure of §3.2 (and the ALL fold's moving set
  is the maximal flap on the chosen side).
- **Hinge-relative.** The same paper region is a flap for one line and not for another.
  "Is this a flap?" is a property of the pair (state, ℓ), never of the state alone.
- **Not unique.** One hinge can host several flaps simultaneously (top flap, bottom flap,
  a top-k block); this is why fold ops take a seed / mode to disambiguate.
- **Foldable flap** in direction V (resp. M) = flap that additionally satisfies P2
  (top- resp. bottom-extractable in every shared spot). "Only foldable things fold"
  = "the requested set is a foldable flap".
- **Terminology caveat for the paper:** origami-design literature (e.g., Lang's tree
  theory) uses "flap" for an *appendage of a base* — a different concept. Define our
  operational usage explicitly in Section 3 and do not mix the two.

### 2.4 Validity invariants (the checker in §6 verifies all of these)

- **I1 Continuity** — as in D3.
- **I2 Area conservation.** Σ area(face, source) = area(P); folded areas equal source
  areas (isometry); splits lose nothing.
- **I3 CONF.** All folded polygons pairwise identical-or-interior-disjoint; spot table
  consistent with polygons; every face appears in exactly one stack, exactly once.
- **I4 Taco-taco (no crossing folds).** For every pair of *folded* creases `c=(a,b)`,
  `c'=(a′,b′)` whose folded hinge segments overlap along a segment of positive length and
  whose four faces lie in a common spot `S`: the index intervals `[a,b]` and `[a′,b′]`
  in `stack(S)` must be **nested or disjoint — never interleaved**
  (forbidden: `a < a′ < b < b′` in stack order, up to symmetry).
- **I5 Taco-tortilla.** For every folded crease `c=(a,b)` with `a,b ∈ stack(S)`, and every
  face `f ∈ stack(S)` that is flat-connected across an edge lying on `c`'s hinge segment
  to a face in the adjacent spot: `index(f)` must **not** lie strictly between
  `index(a)` and `index(b)`. (Paper that continues across the hinge cannot sit inside
  the taco.)
- **I6 Tortilla-tortilla (cross-spot consistency).** For adjacent spots `S, S′` sharing
  boundary segment `e`: for any `f,g ∈ stack(S)` flat-connected across `e` to
  `f′,g′ ∈ stack(S′)`: `f above g ⇔ f′ above g′`.

Notes: antisymmetry/acyclicity *within* a spot holds by construction (stacks are arrays).
I4–I6 are the standard flat-foldability non-crossing conditions (cf. Flat-Folder / the
computational-origami literature); cite accordingly in the paper.

### 2.5 Attachment guarantee — why the state is always one connected sheet

A recurring soundness question: *do the faces stay attached like real paper, or is this
a bag of loose polygons plus a stacking order?* The answer is a strict division of
labor; implementers must not blur it:

- **Material connectivity** lives in source space: faces are a refinement of one square,
  splits never separate (children stay adjacent via `SPLIT` edges), so the crease graph
  is connected by induction from the initial single face. No op can cut paper.
- **Folded-configuration attachment** is exactly **I1**: adjacent faces map their shared
  segment to the same folded segment (flat across `SPLIT`, hinged across `CREASE`).
  Folds preserve I1 *constructively*: P1 confines the mover/static boundary to the axis,
  and the reflection fixes axis points — then the checker re-verifies it (exact rational
  equality, no epsilons).
- **Motion attachment**: the animated fold is a rigid rotation about the hinge line,
  whose points are fixed for all t — the flap swings attached, and t = π lands on the
  I1-satisfying reflection. Layer fanning (§8.2) is cosmetic only.
- **Stacks are NOT attachment.** Geometry + topology answer "where is the paper and how
  is it joined"; stacks answer only "who is above whom where paper coincides".
  Orthogonal responsibilities by design.

**One-sheet theorem (target claim for the paper, machine-checked via §9.2):** every
reachable state satisfies (a) the source polygons partition `P` (pairwise interior-
disjoint, union = `P`), (b) the crease graph is connected, and (c) I1 holds on every
edge — hence the state is a piecewise-isometric image of a single square. Together with
I4–I6 this is the discrete form of the standard folded-state definition (isometry +
non-crossing layering); cite Demaine & O'Rourke.

---

## 3. Operations

All ops share this pipeline:

```
validate params → split faces where needed (§3.0) → compute moving set (§3.2 for ONE_LAYER)
→ check preconditions P1/P2 → apply transforms → renormalize to CONF → rebuild stacks
→ run checker (I1–I6) → return Result
```

### 3.0 Common machinery

**Axis.** A fold axis is an exact line in **folded space**, given as two rational points.
(Upstream code — UI or the future diagram interpreter — is responsible for choosing it;
the engine also exposes `enumerateAxisCandidates(state)` (§8.3) but never guesses.)

**Split-at-axis.** Before any fold, every face whose folded polygon's interior is crossed
by the axis line is split along the axis: split the folded polygon; pull the cut back to
source space via `T_f⁻¹`; create a `SPLIT` edge (it will be promoted to `CREASE` if this
fold actually creases there).
**Consequence (reduction principle):** "folding *part of* a face" is not a primitive and
must never be implemented as one — it always reduces to split-at-axis followed by folding
a flap made of **whole** faces. Whether that partial fold is legal is then decided
entirely by the closure + P1/P2 on the split result, with no special cases.

**CONF maintenance (split propagation).** After moving faces are reflected, their folded
polygons may partially overlap existing spots. Repeat until stable:
if polygons of faces `f, g` partially overlap, compute the overlap boundary lines, split
**both** faces (and, transitively, every face in any affected spot, so all members of a
spot stay congruent), pulling every cut back to source space via the owning face's `T⁻¹`
and recording `SPLIT` edges. Termination: each pass strictly reduces total non-conforming
overlap area; all arithmetic exact, so no epsilon loops. Guard with an iteration cap +
`SPEC-GAP` error rather than infinite loop.

**Stack rebuild.** After renormalization, spots are recomputed from canonical polygon
hashes; stacks are carried over: faces keep their relative order; split children inherit
the parent's position (children of one parent occupy different spots, so no intra-spot
tie can arise from a split).

### 3.1 `FOLD { mode: ALL }`  — fold everything on one side of the axis

Params: `axis`, `movingSide ∈ {left,right of directed axis}`, `direction ∈ {V(alley), M(ountain)}`.

1. Split-at-axis. Moving set `M` = all faces whose folded polygon lies (strictly) on
   `movingSide`. Edges on the axis between `M` and static become `CREASE` with the given
   intrinsic assignment (convert view-relative V/M to intrinsic using current view parity;
   the *op parameter* is view-relative because that is what diagrams and users specify —
   document this conversion in code).
2. Apply `T_f ← Refl(axis) ∘ T_f` for all `f ∈ M`.
3. **Layer update rule (deterministic — this is the heart of the engine):**
   Rotating a stack rigidly by 180° about an in-plane axis **reverses its internal
   bottom→top order**. Therefore, for each target spot:
   - `direction = V`: `stack ← [ …existingStatics, …reverse(movers) ]` (movers on top).
   - `direction = M`: `stack ← [ …reverse(movers), …existingStatics ]` (movers below).
   Movers landing on mover-only spots: just `reverse` (their mutual order, uniformly
   transformed, is handled by the same rule with an empty static part).
4. Renormalize, rebuild, check.

**Lemma L1 (motion feasibility for ALL).** The continuous 180° rigid rotation of `M`
about the axis is collision-free: movers and statics occupy disjoint half-planes except
on the hinge, and movers move as one rigid stack. → The viewer's animation for ALL needs
**no** collision detection.

### 3.2 `FOLD { mode: ONE_LAYER }` — fold the top flap only
*(user's terms: "hinge adjacency" = P1; "collision test" = P2 + I4–I6)*

Params: `axis`, `movingSide`, `direction`, optional `seedFaceIds`.

**Moving-set selection (deterministic closure).**
1. Split-at-axis.
2. Seeds: if `seedFaceIds` given, use them (viewer/VLM grounding path). Otherwise:
   for every spot whose polygon touches the axis segment from `movingSide`, take the
   **top** face of its stack (for `V`; the **bottom** face for `M`).
3. Closure: repeat — add any face `g ∉ M` that shares an edge with some `f ∈ M` whose
   folded image does **not** lie on the axis line — until fixed point.
   (Rationale: an off-axis connection would be torn by the fold; the connected paper
   must come along.)

**Preconditions (checked after closure, before applying):**
- **P1 No tearing / hinge anchoring.** Every source-space edge between `M` and its
  complement must have its folded image **on the axis line**. Additionally `M` must lie
  entirely on `movingSide`, and the complement must be nonempty. If closure leaked to the
  static side or across a non-axis edge → `E_TEAR`.
- **P2 Extractability (motion feasibility).** For `direction = V`: in every spot
  containing both some `f ∈ M` and some `s ∉ M`, **every** mover is above **every**
  static in that stack. For `M`: below. Otherwise → `E_BLOCKED { spot, witnessPair }`.

**Lemma L2.** Given P1 + P2 and a flat state, the 180° rotation of `M` is collision-free:
where movers and statics share xy-support they are separated in stack order on the correct
side (P2); elsewhere the sweep arc stays strictly above (resp. below) the plane except at
the hinge. → Animation for ONE_LAYER also needs no collision detection. (Write this
argument as a comment in `ops/fold.ts`; it goes into the paper.)

**Apply + layer update:** identical to §3.1 steps 2–4 (same reversal rule; movers go on
top of / below the statics of each target spot).

**Selective folding across overlaps (what seed selection buys you).** Because P2 is
evaluated **per spot**, "foldable" means *the moving portion is exposed where it moves* —
not "the whole flap is globally on top". Concretely:

- **Bottom flap folded behind:** seed the bottom face with `direction = M` → movers must
  be at the bottom of every shared spot → valid (e.g., the cup model's back flap, without
  flipping the model).
- **Buried-but-locally-exposed flap:** a face that is layer 2-of-3 in region A but topmost
  in region B may still fold, provided the axis is placed so that only its region-B pieces
  move. CONF (§3.0) has already split it into per-region faces, so the closure + P1/P2
  decide this **exactly** — no special-casing.
- **Top-k block (some-layers fold):** seed the top k faces of a spot; if the closure keeps
  the movers a contiguous top (resp. bottom) block in every shared spot, P2 passes →
  "fold k layers together" works with no extra code.
- **Correctly refused:** folding a covered portion up *through* covering paper →
  `E_BLOCKED { spot, pair }`. The refusal is a feature, and it is physically right — real
  paper cannot do this either without first moving the covering flap. The witness names
  the blocking face; the viewer's red highlight (§8.3) and the future VLM retry loop both
  consume it. The only genuine capability gap is tuck/insert (mover placed *between*
  layers), which is the v2 hook in §11, not a bug.

**Remark (empirical, found during M3 testing).** Because the paper is one sheet, the
closure absorbs any covering layer that is hinged to the mover off-axis — such layers
fold *along with* the mover rather than blocking it. A genuine `E_BLOCKED` therefore
requires a covering layer anchored **independently** of the mover (canonical construction:
fold the left third onto the center, then the right third on top of it; the left flap is
now pinned by an independently anchored flap). Paper-worthy phrasing: in single-sheet
origami, "blocked" means blocked by an independently anchored flap.

### 3.3 `FLIP { axis?: vertical | horizontal | line }`

Turn the whole model over (diagram instruction "flip"). Default axis: vertical line
through the model's bounding-box center.
`T_f ← Refl(axis) ∘ T_f` for **all** faces; **reverse every stack**; sides flip via det
automatically. No creases created. Note: intrinsic M/V assignments do not change; their
*view-dependent* appearance does — recompute on render, never rewrite stored assignments.

### 3.4 `PRECREASE { … same params as FOLD … }`  — annotation-only (v1.1 redesign)

Semantics: fold, then unfold — geometry returns, only a crease **mark** remains.
**Design decision:** unfolded creases are *not* topology. In the target corpus of easy
instruction diagrams, crease marks are not rendered in subsequent panels (they are
unobservable), and the dashed line in a panel is an *action* annotation, not state.
Topology exists only where the isometry changes (D2/D3).

Implementation:
1. Optionally dry-run the full FOLD pipeline on a scratch state (validates that the
   crease is physically makeable; catches interpreter nonsense). Discard the scratch.
2. Commit only: append `{ seg (source space), assignment }` to `state.pendingCreases`.
   **No face splits, no new edges.** Cost: one list append.
3. Lazy split: if a later fold's axis coincides with a pending crease, split-at-axis
   (§3.0) creates the real `CREASE` edges then; optionally remove the consumed pending
   entry (cosmetic).

Consumers of `pendingCreases`: axis-candidate enumeration (§8.3, highest-priority
candidate class), optional crease-mark layer in Π(S) (§7 — off by default for corpora
that never draw marks; on for book-style diagrams), and v2 `WATERBOMB_COLLAPSE`
preconditions (§11). The viewer's "fold here next" dashed-line effect is a UI preview
(§8.3), unrelated to this op.

### 3.5 `UNFOLD_LAST { count = 1 }`

Snapshot-based: revert to the state before the last `count` ops (history stores immutable
refs, so this is O(1)). General "unfold that fold from 10 steps ago" is **out of scope v1**
(`E_UNSUPPORTED`). Real instructions almost always unfold the most recent fold(s).

### 3.6 Result type and error codes

```ts
type Result =
  | { ok: true; state: FoldedState; report: CheckReport }
  | { ok: false; error: OpError };

type OpError =
  | { code: 'E_TEAR';        edges: EdgeId[] }              // P1 violated
  | { code: 'E_BLOCKED';     spot: SpotId; pair: [FaceId, FaceId] }  // P2
  | { code: 'E_EMPTY_MOVE' } | { code: 'E_AXIS_DEGENERATE' }
  | { code: 'E_INVARIANT';   invariant: 'I1'|'I2'|'I3'|'I4'|'I5'|'I6'; witness: unknown }
  | { code: 'E_UNSUPPORTED'; detail: string };
```

Every error carries a **witness** (the offending faces/edges/spot). The future VLM loop
and the viewer's "why can't I fold this?" tooltip both consume these.

---

## 4. Data structures and serialization

### 4.1 Core interfaces (guide, not gospel — keep fields, may add)

```ts
// geom (all rational)
class Rat { n: bigint; d: bigint; /* always reduced, d > 0 */ }
type Vec2 = { x: Rat; y: Rat };
type Iso  = { m: [[Rat,Rat],[Rat,Rat]]; t: Vec2 };   // det ∈ {+1, -1} enforced
type Poly = Vec2[];                                   // simple, CCW in source space

interface Face   { id: FaceId; srcPoly: Poly; T: Iso; parent?: FaceId }
interface Edge   { id: EdgeId; faces: [FaceId, FaceId | null];  // null = paper boundary
                   srcSeg: [Vec2, Vec2];
                   kind: 'BOUNDARY'|'CREASE'|'SPLIT';
                   assignment?: 'M'|'V' }              // intrinsic; CREASE only
interface PendingCrease { seg: [Vec2, Vec2] /* source space */; assignment: 'M'|'V' }
interface Spot   { id: SpotId /* canonical hash */; poly: Poly /* folded */;
                   stack: FaceId[] /* bottom→top */ }
interface FoldedState {
  faces: Map<FaceId, Face>; edges: Map<EdgeId, Edge>; spots: Map<SpotId, Spot>;
  pendingCreases: PendingCrease[];
  step: number; prev?: FoldedState; lastOp?: Op;
}
```

### 4.2 JSON serialization (goldens, diffs, VLM loop)

- Deterministic key order; rationals as `"n/d"` strings; ids stable across runs
  (derive child ids as `parentId + ':' + splitCounter`).
- `serialize(state)` / `parse(json)` round-trip must be exact (property test).

### 4.3 FOLD-format interop (`io/fold.ts`)

Import/export the community **FOLD** file format (Demaine & Ku, github.com/edemaine/fold):
`vertices_coords, edges_vertices, edges_assignment, faces_vertices`, and crucially
**`faceOrders`** for layer ordering. Export = flatten our stacks to pairwise
`[f, g, s]` triples; import = accept flat-folded FOLD files for cross-checking against
Flat-Folder / Origami Simulator outputs.
⚠ Verify the exact sign convention of `s` against the FOLD spec before implementing —
do not guess it. This interop is how the paper demonstrates compatibility and runs
comparisons; treat it as a first-class feature, not an afterthought.

### 4.4 Canonical operation serialization (freeze at v1 — the system's instruction set)

Every producer of operations — golden scripts, the search solver, the VLM adapter,
human GT annotation — MUST emit this one format; the engine is its sole consumer.
One parser, one validator. Treat changes as breaking API changes (`v` field).

```json
{ "v": 1, "type": "FOLD",
  "axis": { "kind": "through_points", "a": ["1/2","1"], "b": ["0","1/2"] },
  "mode": "ALL",            // or "ONE_LAYER"
  "direction": "V",         // or "M"
  "movingSide": 1,          // sign of cross(b−a, p−a) for the moving half-plane
  "seedFaceIds": ["f3:1"]   // optional; ONE_LAYER grounding
}
{ "v": 1, "type": "FLIP", "axis": { "...": "optional, default vertical center" } }
{ "v": 1, "type": "PRECREASE", "...": "same params as FOLD" }
{ "v": 1, "type": "UNFOLD_LAST", "count": 1 }
```

Rules:
- Coordinates are rational strings `"n/d"`, never floats — same convention as §4.2.
- `axis.kind` admits exactly two forms: `through_points` (rational **witness** form —
  the default; encodes the snapping policy §5.1.1 by construction) and
  `candidate_ref { step, candidateId }` for grounded selector outputs (search/VLM),
  which the engine resolves against its own enumeration — guaranteeing the axis is
  fold-constructible. A raw-coefficient axis form is **deliberately not provided**.
- The `movingSide` sign convention is defined here once and used everywhere.
- Round-trip `op → JSON → op` is identity; an op sequence is a **folding program**;
  program + initial paper reproduces the state byte-identically (G2). Programs are
  first-class artifacts (published with the dataset; GT = human-signed programs).

---

## 5. Geometry kernel (`core/src/geom`)

### 5.1 Exact rational arithmetic

- `Rat` over `bigint`, always reduced (gcd), `d > 0`. Ops: `add, sub, mul, div, neg, cmp,
  sign, isZero`. No float constructors in core except an explicit
  `Rat.fromDecimalString` for test fixtures.
- Why: reflections about lines through rational points are rational maps; splits and
  intersections of rational segments are rational. Exactness ⇒ G2 determinism and
  spot-identity by hashing, with zero epsilon tuning.
- Cost control: reduce after every op; if `bitLength(n)+bitLength(d)` exceeds a threshold
  (e.g., 512), emit a warning event (denominator blowup means upstream axes weren't
  snapped to constructible lines — that is upstream's bug, not license to use floats).

#### 5.1.1 Coordinate field limitation and reference-fold snapping (v1.1 finding)

Discovered during golden #2: reference folds whose defining constraint is an **angle
incidence** (fold-to-bisect, edge-onto-line — Huzita–Justin O3/O5/O6 style) generally
have **irrational** axes: the bisector of 45° has slope `tan 22.5° = √2 − 1`. This is
not a corner case — the kite base ("fold both edges onto the diagonal") is exactly this
class and pervades easy models. Axes from O1 (through two points), O2 (point onto point
⇒ perpendicular bisector), and O4 (perpendicular through a point) stay rational.

**Snapping policy (mandatory):** never round axis *coefficients*. Instead, **rationalize
the reference witnesses**: pick a rational landing point *on* the target feature within
diagram tolerance, then derive the axis exactly from the witnesses via O1/O2/O4
machinery. Intended incidences (corner touches edge, etc.) then hold *exactly*; the
error appears only as a small angular deviation from the idealized model — absorbed by
the source diagrams' own imprecision. Rounding coefficients instead breaks incidences
and produces sliver faces/spots that perturb layer combinatorics. Goldens built this
way are "rational analogs" (e.g., golden #2) and must say so.

**Upgrade path (optional M8, gated on corpus data):** a `ℚ(√2)` number type
(`a + b√2` pairs; field ops closed; exact sign via comparing `a²` vs `2b²`; canonical
hash over `(a,b)`) makes the whole 45°-grid bisector family exact, covering the kite
base and the cup. Decide after the corpus audit reports the frequency of the
`axis_class = bisector` category (add that field to the annotation schema). Other
families (e.g., 30° ⇒ `ℚ(√3)`) are recorded but not planned.

### 5.2 Primitives

`reflectPoint(line, p)`, `reflectIso(line, T)`, `segLineIntersect`, `pointSideOfLine`
(exact sign), `splitPolyByLine(poly, line) → [polyLeft?, polyRight?, cutSeg?]`,
`polyArea` (signed, rational), `polysIdentical`, `polysInteriorDisjoint`,
`overlapRegion(polyA, polyB)` (only needed to *find* violation lines for CONF
renormalization — implement via mutual edge-line splitting rather than a general boolean
op library; keep it minimal and exact).

### 5.3 Predicates policy

Every geometric decision is an exact sign computation. There are **no epsilons** in core.
If you feel you need an epsilon, the model is wrong — stop and re-read §2/§3.

### 5.4 Canonical polygon hash (spot identity)

Normalize: ensure CCW; rotate vertex list to lexicographically smallest vertex first;
serialize rationals; hash string. Collision-free by construction (it's an exact encoding,
not a lossy hash).

---

## 6. Checker (`core/src/check`)

- `checkState(state): CheckReport` runs I1–I6 and returns per-invariant pass/fail with
  witnesses. Pure, side-effect free, usable on *any* state including imported FOLD files.
- Ops run the checker after every apply (G1). Provide `FAST_MODE` that skips I4–I6 for
  interactive dragging previews — but the committed state is always fully checked.
- The checker is **independent code**: do not "reuse" op internals to compute stacks/spots;
  recompute from raw polygons + transforms so it can catch op bugs. (This independence is
  an explicit claim in the paper.)

---

## 7. Top-view 2D renderer `Π(S)` (`core/src/render2d`)

Purpose: produce diagram-like SVG projections for (a) golden-test snapshots,
(b) paper figures, (c) the future render-and-compare verification against instruction
diagrams. This module is core (string output), no DOM.

- Visible-surface: for each spot, the **top** face of the stack determines fill
  (front color / back color via `det`).
- Edges: silhouette + edges of top faces drawn solid; crease appearance is
  **view-dependent** (compute from intrinsic assignment + parity); optional `xray` mode
  draws hidden contours faintly.
- Crease-mark layer (optional, default **off**): renders `pendingCreases` mapped through
  the owning faces' `T`. Off for the easy-diagram corpus (marks are never drawn there);
  on for book-style corpora that draw existing creases as thin lines. This is a render
  flag, not an engine change.
- Output: deterministic SVG string (fixed precision decimal conversion at the last step).

---

## 8. three.js viewer (`viewer/`)

### 8.1 Static build (`build3d`) — the embedding function `V(state; ε)`

**The engine places the paper; the renderer only rounds off the joins.** The layer model is
flat plates — a face lies at its exact folded polygon, at the height its index in its own
spot's stack gives it — and that IS the verified state. `V` draws exactly that, and adds
curves only where two faces are JOINED, because that is the one thing flat plates cannot show:
real paper turns there instead of stopping. **Zero core changes; never move 3D poses into the
state** (it would destroy exactness, G2, the invariants, and L1/L2).

Known artifacts this section exists to prevent: (i) per-face-constant z produces cliffs and
apparent separation at creases; (ii) **CONF fragmentation leaking into the render** — the
engine splits faces for layer bookkeeping, and the render must not show the bookkeeping mesh,
or flat paper shows spurious cliffs, hairline cracks, and patchwork edge lines. The state has
no separation (I1); naive rendering creates it.

1. **One mesh, in material space, conforming by construction.** There is exactly one
   `BufferGeometry`: a tessellation of the source square. It is cut into convex cells by every
   face boundary, so each cell lies wholly inside one face — its exact position and height are
   therefore well defined and no triangle straddles a join. Refinement marks EDGES and splits
   each triangle by how many of its edges are marked (1 → 2, 2 → 3, 3 → 4) with a shared
   midpoint cache, so a neighbour is never left with a vertex hanging in the middle of its edge.
   Sizing is graded — fine on a join, coarsening away from one — because flat paper is placed by
   an exact isometry and needs no resolution, while a curve is only as round as its chords. The
   `uv` attribute carries each vertex's material coordinate. **Because it is one surface, there
   is nothing to stitch**: the seams, corner walls, T-junctions and hollow hinges that the
   v1.3/v1.4 assembly of slabs, ribbons and caps kept producing cannot arise.

2. **Everything outside a join is EXACT.** A material point p on face f is drawn at
   `applyIso(f.T, p)` horizontally and at `level(f) × ε` vertically — to the last decimal, not
   approximately. The top view is Π(S) by construction rather than by luck, nothing
   accumulates, and `test/mesh.test.ts` checks it directly against the state.

3. **A CREASE becomes a U-turn.** The two layers it joins lie on the SAME side of the crease
   line, Δz apart, so the paper doubles back: a semicircle of radius Δz/2 whose ends leave both
   layers tangentially, drawn from a band of material π·Δz/4 deep on each side. Turns that nest
   share **one centre**, so they are concentric and the layer nested inside really is inside,
   which is what a folded edge shows. (Giving each its own centre separates the centres by more
   than the radius between them, and each inner turn then pokes out through the one that should
   enclose it. Shipped once; visible immediately.)

   **The centre sits one OUTERMOST RADIUS in from the fold line**, so that outermost rim lands
   exactly ON the line — where the engine says the paper ends — and the tighter turns sit back
   behind it by the paper wrapped around them. Put the centre at the far side of the band
   instead and every rim comes out δ − r short: the folded edges are all drawn inside the
   computed outline, no two layers' rims agree, and since a short rim is an outward push, a
   crease meeting the sheet's border at an angle flicks the corner out past that border. The
   band is then wider than the turn needs and the remainder runs FLAT out to where the plate
   resumes, with material split between arc and flat in proportion to their lengths so the band
   stretches by one factor throughout — 2(π−1)/π ≈ 1.36 at full size. That stretch is the price
   of the rim landing on the line: a turn is only as long as its material if the plates retreat
   by π·r/2, and exact plates are the one thing the renderer may not trade away.

   **Turns nest only where one's LAYER SPAN contains another's**, and the centre comes from that
   ENCLOSER — not from the widest turn on the fold line. Two turns whose spans are disjoint are
   separate folds that merely land on the same line; tying them to a common centre drags the
   shallower one a layer gap in behind a turn that does not enclose it and steps the folded edge
   (the rolling fold grew an ear at its outer end). Band width is likewise each crease's own,
   which also stops a shallow turn inheriting a deep one's wide band and eating the plate.

   **Height is ONE FIELD over the material, not a sum of per-face corrections.** Every face
   pulls the sheet toward its own level with a reach of its deepest join, and the height at a
   point is the weighted average of the faces that reach it: exactly the engine's level deep
   inside a face, the midpoint at a crease, and a smooth spiral where creases CROSS and four
   faces reach at once. Summing per-face corrections instead tears the paper: two faces meeting
   at a crease near a crossing correct toward DIFFERENT third faces — a three-layer turn on one
   side, a one-layer turn on the other — so they disagree by ε on the very edge they share, and
   on the cup that ripped one triangle to 118× its own area at every crossing. A field cannot
   disagree with itself. The weight is not free either: it must reproduce the U-turn's own
   height profile, `w = (1−s)/(1+s)` with `s = sin(π·d/2δ)`. A smoothstep there stalls at the
   crease and crushes the paper into the fold by 300×.

   The turn's sideways lean FADES OUT where a crease ends inside the paper, so where two
   creases cross the fold goes crisp instead of fighting the crease it meets. Ends on the
   square's outline are not faded — nothing crosses there and the fold must stay round to the
   edge of the sheet.

   The lean is instead held below THE ROOM THE PAPER ACTUALLY HAS: how deep the shallower of the
   two faces runs, out of the join, at that point along it. A lean is only payable where there
   is paper to pay with, and running a crease into the border at an angle leaves a wedge
   shallower than the lean, which carries the corner off the sheet and hangs a sliver past it.
   Measuring the room is what tells that apart from a crease ending SQUARE against the border,
   which has a full plate's depth to its last point — fade the turn out there (the cheap way to
   stop the sliver) and every rim flares back to the fold line over the last band-width, an ear
   on the end of the model. A fold's cross section at the border is the same cross section as in
   the middle. Both faces are measured and the smaller wins, so the two sides of a crease always
   agree and the sheet cannot part along it.

   **A join may never claim more than a small fraction of the paper** (4 % of the square, and a
   third of the face it sits on). THE FLAT PLATES ARE THE MODEL: a face has to read as a stiff
   flat sheet at the height the engine gave it. Without the cap the bands grow with ε, so
   Explode turned every face into one continuous blob with no flat paper left anywhere; with
   it, the plates stay flat and the joins become the narrow stretched ribbons an exploded
   diagram wants. When the cap cannot hold a nest's outermost turn, EVERY turn behind that same
   encloser is drawn at the ONE same reduced scale, so the nest keeps its order — the outer
   still wrapping the inner — as ribbons inside the band rather than loops swinging out past the
   fold line. (Scaling them separately is what separates their centres again.) And a
   face only reaches out THROUGH ITS OWN JOINS, never in every direction: reaching by plain
   distance lets it jump a neighbour thinner than the band and drag that level into paper it
   does not touch, which waved every plate once the layers were apart.

4. **A SPLIT with a level change becomes a drape.** One sheet crossing the edge of the pile
   beneath it stays flat on the pile right up to the cut and falls away beyond it on an S-curve
   that leaves both levels flat. (A facet legitimately spans many levels — in the cup, 0 to 6 —
   and CONF cuts it exactly where the level changes, so the engine says precisely where this
   happens.)

5. **The band's material is reparametrised onto the curve; it does NOT preserve length, and
   that is the point.** The v1.5 build folded the sheet the way paper actually folds — arcs
   consuming material, layers ending short by what they spent going round — and every quantity
   then depended on every other: layers drifted from where the engine put them, the drift
   accumulated fold over fold, flat paper strained at corners, and pinning any one of them
   broke another. A stack of layers with THICKNESS genuinely cannot fold flat; the material
   does not add up. Letting a few millimetres of paper stretch inside a bend buys back
   exactness everywhere else, and nothing outside the band can tell.

6. **Two skins, one surface.** The sheet's normal genuinely turns over where the paper does, so
   a `FrontSide` material always shows the source square's +z side and a `BackSide` material
   always the other: two meshes over one geometry, and the paper's two colours follow it around
   every fold with nothing to keep in sync. Per-fragment needs — dry-run tinting, hover,
   picking — are served by geometry *groups* keyed on the faces inside that one geometry.

7. **Edge-line policy.** Draw `BOUNDARY` and folded `CREASE` edges; **never SPLIT edges** —
   they are bookkeeping, invisible on real paper. A drawn line is a chain of MESH EDGES lying
   along the crease's material segment, so it is on the surface by construction and follows
   every curve it crosses. Unfolded PRECREASE marks are dashed. Hidden lines need no policy:
   the paper occludes them.

8. **UI parameters & presets.** One slider: `ε` ("layer gap", [0.001, 0.05]), **default 0.006**.
   It is the only shape parameter — layers Δz apart are joined by a semicircle of radius Δz/2,
   so turns nested at one crease touch without overlapping. A separate "hinge radius" knob is
   not a free parameter but a contradiction: insisting on radius R forces the two layers it
   joins to sit 2R apart, which *is* the layer gap, and setting it independently inflates the
   stack by 2R per fold. (Shipped once, in v1.4, as `bend`.) Preset **Explode** spreads the
   stack over about the silhouette's smaller dimension, `ε = clamp(minDim / depth, ε, 0.05)` —
   never a fixed multiple of ε, since eight layers on a ⅛-wide strip would then stand three
   times taller than the paper is wide. It bounds the WHOLE STACK, not just the gap
   (`ε ≤ 0.12/depth`): one sheet legitimately runs from level 0 to level 6, so every layer of
   separation is a wall that sheet has to climb, and spread far enough it stops reading as
   paper at all. Layer-order pedagogy only, never in figure screenshots.

9. **Acceptance — measured, not eyeballed** (`packages/viewer/test/mesh.test.ts`, every golden
   model × {paper, exploded, thin}). The renderer reports which vertices it left alone
   (`Built.settled`), so the tests check its own claim rather than guess at band widths:
   - *the render IS the verified state*: every settled vertex is at the engine's exact position,
     within float32. This is the check the v1.5 simulation could never have passed.
   - *unbroken surface*: every interior triangle edge is used by exactly two triangles; an edge
     used once must lie on the square's own outline, which `uv` settles exactly. (This replaced
     the v1.4 watertight test, which asked whether a SOLID was closed — the right question for a
     build made of slabs, meaningless for one open sheet.)
   - *layer height*: every face is drawn at EXACTLY its stack index × ε.
   - *no stretching outside a join*, and *the rounding stays local*: no point is moved further
     from the engine's position than the join it belongs to is deep, which is what stops a
     "pretty" curve from quietly becoming the model.
   - *the paper does not crumple*: triangle AREA on screen against area on the flat square.
     Origami paper is stiff, and length alone does not catch this — a triangle can keep all
     three edge lengths and still be sheared into a spike. Stretch is what shows (paper pulled
     thin reads as a rip), so stretch is bounded and so is the share of the sheet carrying any;
     compression is left alone, because a compressed band draws the same clean curve and some
     of it is unavoidable where nested turns share a centre.
   - *no paper hangs past the outline the engine computed*, and none falls short of it either.
     The plates being exact says nothing about the folded EDGES between them, and seen from
     above a folded model is mostly rims.
   - *folded edges nest the way a folded edge nests*: a turn nothing encloses reaches the fold
     line exactly, a turn tucked inside another sits strictly further in, and along a fold that
     runs border to border the rim does not move. This is the check that catches an "ear" —
     paper standing somewhere no real sheet folded this way would put it.
   - *animation*: t = 1 reproduces the committed build exactly.
- Camera: default **orthographic top view** (matches diagrams) + orbit controls toggle.

### 8.2 Fold animation (`animate`)

- Animation is **not a separate renderer**. `buildModel` returns `setProgress(t)`: the last
  fold's movers swing about its hinge from 0 → π, and whatever the join curves and the layer
  heights still owe is blended in over the same interval. t = 0 is exactly the previous state's
  layout, t = 1 is exactly this one's, so nothing snaps at the end and no z-offset relaxation is
  needed — the v1.4 scheme (movers in a rotating pivot beside static slabs, then a swap to the
  post state) existed only because the two were built by different code.
- Per Lemmas L1/L2 **no collision detection is needed** — the discrete engine already
  guaranteed feasibility; the animation is presentation only.
- Mid-motion z-fighting cannot occur: layers are physically ε apart at every θ.
- `FLIP` and `PRECREASE` are not animated (a flip is a half-turn applied whole; a precrease
  moves nothing).

### 8.3 Interaction (`interact`) — "only foldable things fold"

- Hover face → highlight face + its spot's stack (side panel lists bottom→top).
- Fold flow: pick seed face(s) → pick axis from `enumerateAxisCandidates(state)`:
  existing crease lines, lines through vertex pairs, perpendicular bisectors of vertex
  pairs (Huzita–Justin O2), and edge-to-edge bisectors (O3) — engine util, exact.
  → pick direction/mode → engine dry-run returns `Result` → **green preview** (ghost of
  target position) if ok, **red highlight of the witness** (blocking faces / tearing
  edges) if not → confirm executes + animates.
- Never let the UI construct axes from raw mouse floats: mouse picks *candidates*;
  candidates are exact.
- History strip of Π(S) thumbnails per step; click = time-travel (immutable states make
  this free).


---

## 9. Testing (this suite is a deliverable of the research, not a chore)

### 9.1 Unit

Rational ops; reflection of points/isos (parity flips det); polygon split (areas sum,
cut segment on line); canonical hash (rotation/starting-vertex invariance).

### 9.2 Property tests (fast-check or hand-rolled generators)

- **Closure/G1:** random sequences of *accepted* ops on a square → checker always green.
- **Determinism/G2:** apply same sequence twice → identical serialized JSON.
- **Area/I2:** conserved after every op.
- **Involution:** `FOLD` then `UNFOLD_LAST` → state equals pre-state (serialized).
- **Flip-flip identity:** two FLIPs about the same axis → identity.
- **Reversal rule sanity:** fold a known 3-layer stack; assert exact resulting stack order.
- **One-sheet (§2.5):** after every accepted op, source polygons are pairwise
  interior-disjoint with union exactly `P`, and the crease graph is connected. Run it
  inside the G1 sweep so it holds across the whole reachable family, not just goldens.

### 9.3 Golden regression models (also the paper's correctness evidence + figure source)

**State fixtures.** A test may start from a **hand-authored FoldedState** (JSON fixture)
instead of an op script. This is how transitions *after* a v2-only step (e.g., anything
following a collapse) are tested today: "unreachable by v1 ops" does not mean "unusable
as a test start state". Every fixture must pass `checkState` including the one-sheet
test before use; a fixture that fails the checker is a bug in the fixture, not a finding.
Verdicts about whether some diagram transition is v1-expressible are rendered ONLY by
running candidate ops from such a fixture and reading the Result/witness — never by
inspecting the panel image.

Scripted op sequences with snapshotted per-step JSON + Π(S) SVG:

1. **Half/half again** (2 ALL folds) — smallest layer-reversal case; hand-verified stacks.
2. **Cup (rational analog of the traditional cup)** — includes ONE_LAYER on the front
   flap; the classic "fold front flap only" test for P2. The true cup's reference fold
   is irrational (§5.1.1); the golden uses rational witnesses per the snapping policy
   and records this justification.
3. **Hat / boat sequence** — flips + one-layer folds interacting.
4. **Blintz base then unfold** — precrease semantics.
5. **Buried-flap selective fold** — construct a state where one sheet is layer 2-of-3 in
   region A but topmost in adjacent region B; fold only its exposed region-B portion
   (must succeed), then attempt the covered region-A portion (must fail `E_BLOCKED` with
   the covering face as witness). Also required, as a **positive** case: a contiguous
   top-2 block fold — pre stack `[s, m1, m2]` (bottom→top), valley-fold `M = {m1, m2}` →
   target-spot stack is exactly `[…targetStatics, m2, m1]` (movers reversed, `m1`
   topmost); assert the exact order. A blocked non-contiguous closure (buried hinged
   layer pinned under a middle flap → `E_BLOCKED`) is the matching negative.
6. **Rabbit (real instruction diagram, 8 panels)** — first end-to-end real-diagram model;
   audit confirmed every step is v1: ALL(diag) → ALL(bottom band up) → corner folds ×2
   (ears) → FLIP → apex fold down → bottom tip fold behind (M). Script it and snapshot
   every state; this is the first "real diagram folded start-to-finish" demo.
7. **Koala (real instruction diagram, 8 panels)** — all v1, but the ear-corner folds are
   **silhouette-identical under ALL vs ONE_LAYER readings**; script BOTH readings and
   assert that only one matches the next panel's front/back coloring. This golden doubles
   as the first render-and-compare disambiguation test.
8. **Interior-anchored diagonal fold (frog-legs analog).** Exercises the op class where
   the crease segment ends at an interior vertex while the axis *line* continues through
   other layers. Construction (all v1, no collapse needed): unit square → `FOLD ALL`
   along the line through `(1/2,1)` and `(0,1/2)`, moving = top-left corner, `V` (its tip
   lands exactly at `(1/2,1/2)`) → mirror fold through `(1/2,1)`–`(1,1/2)` → a "house"
   with two front flaps meeting at `C=(1/2,1/2)`. Now attempt the leg fold along the
   line `y = x` (through `C` and corner `(0,0)`):
   - `FOLD ALL, movingSide = below-right of y=x, V` must **succeed**: split-at-axis
     splits every crossed face (including the right flap, which straddles the line
     beyond `C`); `CREASE` promotion happens only on mover/static boundaries; snapshot
     the exact stacks and Π(S).
   - `FOLD ONE_LAYER` seeded at the base's bottom-right piece: record the outcome —
     closure either grows through the off-axis top edge into the flap structure
     (equivalent moving set to ALL) or fails `E_TEAR`; assert whichever the engine
     yields, with witness, and document it in the golden. Mirror along `y = 1 − x`.
   This golden certifies the operation class of the frog leg folds; reaching the *real*
   frog state additionally requires `WATERBOMB_COLLAPSE` (§11, gated).
9. **A negative suite:** ops that MUST fail: folding a bottom flap upward over covering
   layers (`E_BLOCKED` with correct witness), a moving set whose closure leaks off-axis
   (`E_TEAR`), constructing an interleaved taco via crafted stacks fed to the checker
   (`E_INVARIANT I4`).

Hand-verify goldens against physical paper once; after that they freeze. Any diff in a
golden requires a written justification in the PR description.

### 9.4 Cross-tool check (after M5)

Export 2–3 final flat states to FOLD; load in Flat-Folder / Origami Simulator; confirm the
layer order we produced is among the valid orders they report. Record the procedure — it
becomes an evaluation paragraph in the paper.

---

## 10. Milestones (do them in order; each has acceptance criteria)

- **M0 Geometry kernel.** `Rat`, `Vec2`, line/segment ops, polygon split, hashes.
  ✅ all §9.1 unit tests.
- **M1 State + CONF.** Face/Edge/Spot, split-at-axis, CONF renormalization, stack rebuild,
  serialization round-trip. ✅ CONF property holds under randomized synthetic reflections.
- **M2 FOLD ALL + FLIP + checker I1–I3.** ✅ golden #1; involution & flip-flip tests.
- **M3 ONE_LAYER.** Moving-set closure, P1/P2, error witnesses. ✅ golden #2; negative
  suite for `E_TEAR`/`E_BLOCKED`.
- **M4 Full checker I4–I6 + PRECREASE + UNFOLD_LAST.** ✅ goldens #3–4; crafted I4/I5/I6
  violations detected with witnesses.
- **M5 render2d Π(S) + FOLD io.** ✅ SVG snapshots stable; FOLD round-trip; §9.4 done once.
- **M6 Viewer static.** State → 3D with z-offsets, front/back materials, top-view camera,
  history strip. ✅ visually matches Π(S) for all goldens.
- **M7 Animation + interaction.** Fold animation w/ layer fanning; candidate-axis picking;
  green/red dry-run preview with witnesses. ✅ scripted demo: cup folded end-to-end
  interactively, blocked fold shows red witness.

Definition of done for v1 = M7 + all tests green + `README` with the demo script.
Optional **M8 (gated):** swap the number type to `ℚ(√2)` behind the `Rat` interface if
the corpus audit shows bisector-class axes (§5.1.1) are frequent; all goldens must pass
unchanged, plus a new exact kite-base golden.

---

## 11. Out of scope v1 → v2 hooks (design now, implement later)

Keep the `Op` union open and the pipeline generic so v2 can add **composite ops** that are
deterministic macros over the layered state:

- `INSIDE_REVERSE_FOLD`, `OUTSIDE_REVERSE_FOLD`, `SQUASH`, `PETAL`, `RABBIT_EAR`
  — each has a well-defined layer effect; they are what unlocks crane-class models.
- `WATERBOMB_COLLAPSE` — multi-crease collapse of a precreased region into a flat
  triangle. Empirically required: the audited jumping-frog diagram is unfoldable past
  step 2 without it. Why it is not a v1 op: the transition applies **three different
  reflections** in one step (each wing + the top about different creases), the moving
  pieces have **bent hinges** (attachment along two non-collinear creases → never a flap,
  P1 fails), and the wings land *between* layers (violates movers-at-extreme). Its
  *result*, however, is an ordinary flat layered state, so define it as a deterministic
  macro with an explicit **precondition: the required precrease set exists in the state**
  (this is exactly what a diagram's crease-making step buys) → known face split + known
  stack pattern, no 3D simulation. Serialization attempts that must fail
  (`E_TEAR` / `E_BLOCKED`) become negative tests and a paper figure.
- `INSERT / TUCK` — requires placing movers *between* layers: P2 generalizes from
  "top/bottom extractable" to "target gap reachable"; leave a TODO pointing here.
- Open (non-flat) intermediate states: would replace `Iso` with 3D rotations about hinges;
  the crease graph and stacks survive; do not contort v1 for this.

---

## Appendix A. Worked micro-example (use as the M2 acceptance walkthrough)

Unit square, single face `f0`, `T = id`.

1. `FOLD ALL, axis x = 1/2, movingSide = right, V`:
   split → `f0:L (left)`, `f0:R (right)`; reflect `f0:R` → lands on left;
   spots: one spot `[0,1/2]×[0,1]` with stack `[f0:L, f0:R]` (mover on top);
   `det(T_{f0:R}) = −1` → shows back side. Edge at `x=1/2` = CREASE, V, folded.
2. `FOLD ALL, axis y = 1/2, movingSide = top, V`:
   split both faces → 4 faces; movers `{f0:L:T, f0:R:T}` (stack order bottom→top before
   fold: `f0:L:T, f0:R:T`); reversal rule ⇒ after fold stack (bottom→top):
   `[f0:L:B, f0:R:B, f0:R:T, f0:L:T]`.
   **This exact order is the golden assertion.** If your implementation yields
   `…, f0:L:T, f0:R:T`, the reversal rule is wrong.
3. `UNFOLD_LAST` → serialized state equals end of step 1.

## Appendix B. Terminology mapping (requirements ↔ spec)

| Original requirement | Where it lives in this spec |
|---|---|
| 1. crease graph — which faces connect via which fold lines | D2 (faces/edges, dual graph), I1 |
| 2. layer graph — which face is above/below which | D4 spots & stacks (+ derived pairwise), I3–I6 |
| 3. hinge adjacency — moving face connected to fixed region through the hinge | §3.2 moving-set closure + **P1 no-tearing** |
| 4. collision test — no passing through other paper | **P2 extractability** (motion, via L1/L2) + **I4–I6** (state) |
| (implied, previously missing) partial-overlap handling | CONF + split propagation §3.0 |
| (implied, previously missing) front/back side tracking | D3 side-from-det rule |
| (implied, previously missing) deterministic layer update | §3.1 step 3 reversal rule |
| (implied, previously missing) exactness / reproducibility | §5, G2 |