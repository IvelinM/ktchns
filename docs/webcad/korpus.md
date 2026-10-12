# WebCAD — the МОДУЛ carcass

[← index](../webcad.md) · panel-level geometry: [geometry.md](geometry.md) · code: `webcad-geometry.ts` (`korpusPanels`/`buildKorpus`)

`korpusPanels(p, withDoor)` is the **single source** of the carcass layout — used both
to build the 3D group (`buildKorpus`) and to generate the schedule. It returns
`KorpusPanel[]`, each `{ name, AB, BC, rx, ry, rz, px, py, pz, pvc }`. `name` is the
Bulgarian role (ЛЯВА СТРАНИЦА / ДЯСНА СТРАНИЦА / ДЪНО / ТАВАН or РЕБРО ТАВАН 1/2 / ГРЪБ /
ВРАТИЧКА) and becomes the **ЕЛЕМЕНТ** column in the itemised schedule.

`buildKorpus` reads `t = ПЛОСКОСТ_ДЕБЕЛИНА` and `kant = КАНТ_ДЕБЕЛИНА` from the
instance params and passes them into `makeMesh` for every panel. (`module` unifies what
used to be two near-identical families, `cabinet-door`/КОРПУС С ВРАТА and
`cabinet-ribs`/КОРПУС С РЕБРА — see [families.md](families.md).)

## Present-panel toggles (`С_*`, default on except С_РЕБРА)

`С_ГРЪБ`, `С_ЛЯВА_СТРАНИЦА`, `С_ДЯСНА_СТРАНИЦА`, `С_ТАВАН`, `С_РЕБРА`, `С_ДЪНО`,
`С_ВРАТИЧКА`. **Positive sense**: checked = panel present; uncheck to remove it.

`С_ТАВАН` and `С_РЕБРА` are **mutually exclusive** (`setToggleParam` in
admin-page.component.ts unchecks one when you check the other): `С_ТАВАН` builds one
full ТАВАН panel; `С_РЕБРА` instead builds two narrow ribs — РЕБРО ТАВАН 1 (front) and
РЕБРО ТАВАН 2 (back), each `РЕБРА_ШИРИНА` deep (default 100 mm), spanning ШИРИНА minus
the side thicknesses. Ribs never trim the side panels' height (sides always run full
height under ribs); a full ТАВАН panel does, per its own `ВИДИМ_*` flag below. The
door's top/bottom edges always follow the usual `ВРАТИЧКА_ФУГА_ОТГОРЕ`/`ОТДОЛУ` reveal
(offset by the `ВРАТИЧКА_*_РЪБ_ОФСЕТ` params below), the same formula regardless of
С_ТАВАН vs С_РЕБРА.

## Depth envelope (critical)

`ДЪЛБОЧИНА` is the **outer** depth. The back occupies the rear `t`, the door the front
`t`; the **sides, top and bottom fit between them**:
```
innerD = D − t(back if present) − t(door if present)
innerZ = (t_back − t_door) / 2          // depth-centre of the inner panels
back at z = −(D/2 − t/2)   door at z = +(D/2 − t/2)
```

## Width / visible-edge joinery (`*_ВИДИМ_КАНТ_*`)

Each flag picks which panel covers the other at a shared edge:
- **true** → that panel's edge runs to the **outer face** and covers the neighbour (its
  banded edge stays visible).
- **false** → it is **inset** by one `t` so the neighbour covers it.

Back: each of its four edges follows `ГРЪБ_ВИДИМ_*` (defaults on). Top/bottom: the
`ТАВАН/ДЪНО_ВИДИМ_*` flags (default off) drive the width **and** the matching side
panel's height — when the top covers the side, the side is shortened to sit under it;
else the side runs full height and covers the top. Joints stay mutually consistent.

## Door (ВРАТИЧКА)

All four edges PVC-banded. `ВРАТИЧКА_ФУГА_ОТЛЯВО/ОТДЯСНО/ОТГОРЕ/ОТДОЛУ` inset the door
by `DOOR_FUGA = 2 mm` on each checked side, recentring it. Defaults: ОТЛЯВО=1,
ОТДЯСНО=1, ОТГОРЕ=0, ОТДОЛУ=0.

> Add a carcass panel by adding it in `korpusPanels` (with a `name` + `pvc`) — it then
> flows into both the 3D build and the [schedule](schedule.md) automatically.
