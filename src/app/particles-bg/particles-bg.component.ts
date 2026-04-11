import {
  Component,
  AfterViewInit,
  OnDestroy,
  NgZone,
} from '@angular/core';
import { tsParticles } from '@tsparticles/engine';
import { loadSlim } from '@tsparticles/slim';

@Component({
  selector: 'app-particles-bg',
  standalone: true,
  template: `<div id="particles-bg"></div>`,
  styles: [`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 999;
      pointer-events: none;
    }
    #particles-bg,
    #particles-bg canvas {
      width: 100%;
      height: 100%;
      pointer-events: none !important;
    }
  `],
})
export class ParticlesBgComponent implements AfterViewInit, OnDestroy {
  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(async () => {
      await loadSlim(tsParticles);
      await tsParticles.load({
        id: 'particles-bg',
        options: {
          fpsLimit: 60,
          fullScreen: { enable: false },
          background: { color: { value: 'transparent' } },
          particles: {
            number: {
              value: 250,
              density: { enable: true },
            },
            color: { value: '#d4a96a' },
            opacity: {
              value: { min: 0.1, max: 0.3 },
              animation: {
                enable: true,
                speed: 0.8,
                sync: false,
              },
            },
            size: {
              value: { min: 1.5, max: 3.5 },
            },
            move: {
              enable: true,
              speed: 0.7,
              direction: 'none',
              outModes: { default: 'out' },
            },
            links: {
              enable: true,
              distance: 150,
              color: '#d4a96a',
              opacity: 0.15,
              width: 1,
            },
          },
          interactivity: {
            detectsOn: 'window',
            events: {
              onHover: {
                enable: true,
                mode: 'repulse',
              },
              onClick: {
                enable: true,
                mode: 'push',
              },
            },
            modes: {
              repulse: {
                distance: 120,
                duration: 0.4,
              },
              push: {
                quantity: 4,
              },
            },
          },
          detectRetina: true,
        },
      });
    });
  }

  ngOnDestroy(): void {
    tsParticles.domItem(0)?.destroy();
  }
}
