# WebCAD — the КОРПУС С ВРАТА carcass

[← index](../webcad.md) · panel-level geometry: [geometry.md](geometry.md)

`korpusPanels(p, withDoor)` is the **single source** of the carcass layout — used both
to build the 3D group (`buildKorpus`) and to generate the schedule. It returns
`KorpusPanel[]`, each `{ name, AB, BC, rx, ry, rz, px, py, pz, pvc }`. `name` is the
Bulgarian role (ЛЯВА СТРАНИЦА / ДЯСНА СТРАНИЦА / ДЪНО / ТАВАН / ГРЪБ / ВРАТИЧКА) and
becomes the **ЕЛЕМЕНТ** column in the itemised schedule.

`buildKorpus` reads `t = ПЛОСКОСТ_ДЕБЕЛИНА` and `kant = КАНТ_ДЕБЕЛИНА` from the
instance params and passes them into `makeMesh` for every panel.

## Present-panel toggles (`С_*`, default on)

`С_ГРЪБ`, `С_ЛЯВА_СТРАНИЦА`, `С_ДЯСНА_СТРАНИЦА`, `С_ТАВАН`, `С_ДЪНО`, `С_ВРАТИЧКА`.
**Positive sense**: checked = panel present; uncheck to remove it.

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
