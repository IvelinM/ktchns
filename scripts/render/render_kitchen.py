"""
Photoreal render of a WebCAD scene with Blender + Cycles.

Input is a `.glb` exported from the /admin tool
(Visualisation ▸ Export for render). That file carries the full Render-mode PBR look
(metalness/roughness + embedded textures, which map 1:1 onto Blender's Principled BSDF)
and a camera matching the on-screen view, so the render frames what you framed.

Usage:
    blender -b --python render_kitchen.py -- <in.glb> [out.png] \
        [--samples N] [--width N] [--hdri NAME] [--engine cycles|eevee]

Defaults: out = <in>.png, samples = 256, width = 1600, hdri = interior, engine = cycles.
Use the render.ps1 wrapper on Windows — it locates blender.exe for you.

Notes
-----
* WebCAD works in **millimetres**; glTF/Blender assume metres, so the import is scaled
  by 0.001 (about the origin, camera included, so framing is preserved).
* Rendering runs on the **CPU** by default — reliable everywhere, including Intel Iris Xe
  (which is why the in-browser GPU path tracer never worked here). Cycles + OpenImageDenoise
  gives clean, V-Ray-class output; it just takes seconds-to-minutes instead of real time.
* World lighting uses one of Blender's **bundled** studio HDRIs (no external asset needed):
  interior, studio, courtyard, city, forest, night, sunrise, sunset.
"""

import bpy
import sys
import os
import math


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not argv:
        print('ERROR: pass the .glb path after "--".')
        sys.exit(1)
    glb = os.path.abspath(argv[0])
    if not os.path.exists(glb):
        print('ERROR: file not found: %s' % glb)
        sys.exit(1)
    opts = {'samples': 256, 'width': 1600, 'hdri': 'interior', 'engine': 'cycles', 'out': None}
    rest, i = argv[1:], 0
    while i < len(rest):
        a = rest[i]
        if a == '--samples':
            opts['samples'] = int(rest[i + 1]); i += 2
        elif a == '--width':
            opts['width'] = int(rest[i + 1]); i += 2
        elif a == '--hdri':
            opts['hdri'] = rest[i + 1]; i += 2
        elif a == '--engine':
            opts['engine'] = rest[i + 1].lower(); i += 2
        elif not a.startswith('--') and opts['out'] is None:
            opts['out'] = a; i += 1
        else:
            i += 1
    opts['glb'] = glb
    opts['out'] = os.path.abspath(opts['out']) if opts['out'] else os.path.splitext(glb)[0] + '.png'
    return opts


def import_and_scale(glb):
    """Import the GLB and scale mm→m about the origin by parenting to a root empty."""
    bpy.ops.import_scene.gltf(filepath=glb)
    scene = bpy.context.scene
    root = bpy.data.objects.new('WEBCAD_ROOT', None)
    scene.collection.objects.link(root)
    # Parent every current top-level object to the root WITHOUT compensating the parent
    # inverse, so the root's 0.001 scale multiplies each child's position and size.
    for o in list(scene.objects):
        if o is not root and o.parent is None:
            o.parent = root
    root.scale = (0.001, 0.001, 0.001)
    bpy.context.view_layer.update()


def find_or_make_camera(scene):
    cam = next((o for o in scene.objects if o.type == 'CAMERA'), None)
    if cam is None:
        # No camera in the GLB — build one that frames all mesh geometry from the front-right.
        cam_data = bpy.data.cameras.new('AutoCam')
        cam = bpy.data.objects.new('AutoCam', cam_data)
        scene.collection.objects.link(cam)
        mn = [1e9, 1e9, 1e9]
        mx = [-1e9, -1e9, -1e9]
        for o in scene.objects:
            if o.type != 'MESH':
                continue
            for c in o.bound_box:
                w = o.matrix_world @ __import__('mathutils').Vector(c)
                for k in range(3):
                    mn[k] = min(mn[k], w[k]); mx[k] = max(mx[k], w[k])
        ctr = [(mn[k] + mx[k]) / 2 for k in range(3)]
        span = max(mx[k] - mn[k] for k in range(3)) or 2.0
        cam.location = (ctr[0] + span, ctr[1] - span, ctr[2] + span * 0.7)
        d = __import__('mathutils').Vector(ctr) - __import__('mathutils').Vector(cam.location)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    # WebCAD's camera uses a VERTICAL field of view — match it so framing is aspect-independent.
    cam.data.sensor_fit = 'VERTICAL'
    return cam


def setup_world(scene, hdri_name):
    world = bpy.data.worlds.new('WebCADWorld')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground')
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])

    hdri_path = None
    try:
        world_dir = os.path.join(bpy.utils.system_resource('DATAFILES'), 'studiolights', 'world')
        cand = os.path.join(world_dir, hdri_name + '.exr')
        if os.path.exists(cand):
            hdri_path = cand
        elif os.path.isdir(world_dir):
            exrs = sorted(f for f in os.listdir(world_dir) if f.endswith('.exr'))
            if exrs:
                hdri_path = os.path.join(world_dir, exrs[0])
    except Exception as e:
        print('WARN: could not locate bundled HDRI:', e)

    if hdri_path:
        env = nt.nodes.new('ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(hdri_path)
        nt.links.new(env.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 1.0
        print('World HDRI:', os.path.basename(hdri_path))
    else:
        bg.inputs['Color'].default_value = (0.62, 0.64, 0.68, 1.0)
        bg.inputs['Strength'].default_value = 1.5
        print('World HDRI: none found — using a flat grey sky.')


def add_floor_and_sun(scene):
    # Matte floor at z=0 (the WebCAD ground plane) so free-standing cabinets get contact shadows.
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = 'Floor'
    mat = bpy.data.materials.new('FloorMat')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (0.30, 0.30, 0.32, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.75
    floor.data.materials.append(mat)

    # A soft sun for crisp-but-not-hard directional shadows on top of the HDRI ambient.
    sun_data = bpy.data.lights.new('Sun', 'SUN')
    sun_data.energy = 2.0
    sun_data.angle = math.radians(3.0)  # softens the shadow edge
    sun = bpy.data.objects.new('Sun', sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(52), math.radians(18), math.radians(35))


def configure_render(scene, opts, cam):
    aspect = float(cam.get('viewAspect', 16.0 / 9.0)) if cam else 16.0 / 9.0
    w = int(opts['width'])
    h = max(1, round(w / aspect))
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = opts['out']

    if opts['engine'] == 'eevee':
        for name in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
            try:
                scene.render.engine = name
                break
            except TypeError:
                continue
    else:
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'           # reliable everywhere; GPU on Iris Xe is not
        scene.cycles.samples = int(opts['samples'])
        scene.cycles.use_denoising = True
    print('Engine %s, %dx%d, %d samples' % (scene.render.engine, w, h, opts['samples']))


def main():
    opts = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    import_and_scale(opts['glb'])
    cam = find_or_make_camera(scene)
    setup_world(scene, opts['hdri'])
    add_floor_and_sun(scene)
    configure_render(scene, opts, cam)

    print('Rendering →', opts['out'])
    bpy.ops.render.render(write_still=True)
    print('DONE:', opts['out'])


main()
