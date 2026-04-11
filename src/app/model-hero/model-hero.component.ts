import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  Input,
  Output,
  EventEmitter,
  NgZone,
  isDevMode,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

/** Camera waypoint: position + lookAt target */
interface CamState {
  x: number; y: number; z: number;
  lx: number; ly: number; lz: number;
}

@Component({
  selector: 'app-model-hero',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './model-hero.component.html',
  styleUrls: ['./model-hero.component.scss'],
})
export class ModelHeroComponent implements AfterViewInit, OnDestroy {
  /** Translatable text passed in from parent */
  @Input() title = 'IM Studio';
  @Input() subtitle = 'Проектиране · Изработка · Монтаж';
  @Input() ctaLabel = 'Обади ни се';
  @Output() ctaClick = new EventEmitter<void>();

  @ViewChild('canvas')  canvasRef!:  ElementRef<HTMLCanvasElement>;
  @ViewChild('section') sectionRef!: ElementRef<HTMLElement>;
  @ViewChild('wrapper') wrapperRef!: ElementRef<HTMLElement>;
  @ViewChild('heroText') heroTextRef!: ElementRef<HTMLElement>;

  loading  = true;
  hasError = false;

  private renderer!:  THREE.WebGLRenderer;
  private scene!:     THREE.Scene;
  private camera!:    THREE.PerspectiveCamera;
  private controls?:  OrbitControls;
  private raf?:       number;
  private ro?:        ResizeObserver;

  /**
   * Proxy object that GSAP mutates; the render loop reads it every frame.
   * Initialized to the first camera waypoint (front perspective).
   */
  private cam: CamState = { x: 0, y: 1.2, z: 5.5, lx: 0, ly: 0.2, lz: 0 };

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    // Boot Three.js completely outside Angular's zone — no change-detection cost
    this.zone.runOutsideAngular(() => this.boot());
  }

  // ─── Three.js setup ─────────────────────────────────────────────────────────

  private boot(): void {
    const canvas  = this.canvasRef.nativeElement;
    const wrapper = this.wrapperRef.nativeElement;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x080808, 1);
    this.resize();

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      45,
      wrapper.clientWidth / wrapper.clientHeight,
      0.01,
      500,
    );
    this.applyCamera();

    // Load model
    new GLTFLoader().load(
      'assets/3D/slav.glb',
      (gltf: GLTF) => this.onLoaded(gltf.scene),
      undefined,
      (err: unknown) => {
        console.error('[ModelHero] GLTFLoader error', err);
        this.zone.run(() => { this.loading = false; this.hasError = true; });
      },
    );

    // Keep canvas sized to wrapper
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrapper);

    // Render loop
    this.loop();
  }

  private onLoaded(model: THREE.Group): void {
    // ── Center + uniform scale to fit inside ~3-unit sphere ──────────────────
    const box    = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale  = 3 / maxDim;

    model.scale.setScalar(scale);
    model.position.sub(center.multiplyScalar(scale));

    // ── Wireframe on every mesh ───────────────────────────────────────────────
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0xd4a96a,   // warm gold — kitchen aesthetic
      wireframe: true,
    });

    model.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh;
        // Dispose old materials to free GPU memory
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else {
          mesh.material.dispose();
        }
        mesh.material = wireMat;
      }
    });

    this.scene.add(model);

    this.zone.run(() => { this.loading = false; });

    // ── Camera control: OrbitControls in dev, GSAP ScrollTrigger in prod ─────
    if (isDevMode()) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    } else {
      this.setupScrollTrigger();
      this.animateHeroText();
    }
  }

  // ─── GSAP ScrollTrigger ──────────────────────────────────────────────────────

  /**
   * Maps page scroll progress to camera waypoints.
   *
   *   0 %  → front perspective    (cam.z = 5.5)
   *  30 %  → elevated angle       (cam.y↑, slight orbit left)
   *  60 %  → side orbit           (cam.x far right, low)
   * 100 %  → close detail shot    (cam.z = 2.2, looking up slightly)
   */
  private setupScrollTrigger(): void {
    const section = this.sectionRef.nativeElement;

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: section,
        start: 'top top',
        end:   'bottom bottom',
        scrub: 1.5,           // lag smoothing (seconds)
      },
    });

    // 0 % → 30 %: rise and tilt left
    tl.to(this.cam, {
      x: -1.5, y: 3.5, z: 4.5,
      lx: 0.2, ly: 0.4, lz: 0,
      duration: 3,
      ease: 'none',
    });

    // 30 % → 60 %: swing to the right side
    tl.to(this.cam, {
      x: 5, y: 1.2, z: 1.5,
      lx: 0, ly: 0, lz: 0,
      duration: 3,
      ease: 'none',
    });

    // 60 % → 100 %: pull in close for detail
    tl.to(this.cam, {
      x: 0.3, y: 0.5, z: 2.2,
      lx: 0, ly: 0.1, lz: 0,
      duration: 4,
      ease: 'power2.inOut',
    });
  }

  /** Fade hero text out as the user starts scrolling */
  private animateHeroText(): void {
    const textEl = this.heroTextRef?.nativeElement;
    if (!textEl) return;

    ScrollTrigger.create({
      trigger: this.sectionRef.nativeElement,
      start: 'top top',
      end: '20% top',
      scrub: true,
      onUpdate: (self) => {
        textEl.style.opacity = String(1 - self.progress);
      },
    });
  }

  // ─── Render loop ─────────────────────────────────────────────────────────────

  private loop(): void {
    this.raf = requestAnimationFrame(() => this.loop());

    if (this.controls) {
      this.controls.update();
    } else {
      this.applyCamera();
    }

    this.renderer.render(this.scene, this.camera);
  }

  private applyCamera(): void {
    this.camera.position.set(this.cam.x, this.cam.y, this.cam.z);
    this.camera.lookAt(this.cam.lx, this.cam.ly, this.cam.lz);
  }

  private resize(): void {
    const wrapper = this.wrapperRef?.nativeElement;
    if (!wrapper) return;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    this.renderer?.setSize(w, h);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  ngOnDestroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.controls?.dispose();
    ScrollTrigger.getAll().forEach(t => t.kill());
    this.renderer?.dispose();
  }
}
