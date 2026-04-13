import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HERO_IMAGES } from '../projects/projects.data';

@Component({
  selector: 'app-hero-slider',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hero-slider.component.html',
  styleUrls: ['./hero-slider.component.scss'],
})
export class HeroSliderComponent implements OnInit, OnDestroy {
  @Input() title = '';
  @Input() subtitle = '';
  @Input() ctaLabel = '';
  @Output() ctaClick = new EventEmitter<void>();

  images = HERO_IMAGES;
  currentIndex = 0;
  prevIndex = -1;

  private timer?: ReturnType<typeof setInterval>;
  private clearPrevTimer?: ReturnType<typeof setTimeout>;

  ngOnInit() {
    this.timer = setInterval(() => this.next(), 4500);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.clearPrevTimer);
  }

  goTo(index: number) {
    if (index === this.currentIndex) return;
    clearTimeout(this.clearPrevTimer);
    this.prevIndex = this.currentIndex;
    this.currentIndex = index;
    // Clear prev slightly after the CSS transition finishes (1.2s)
    this.clearPrevTimer = setTimeout(() => { this.prevIndex = -1; }, 1400);
  }

  next() {
    this.goTo((this.currentIndex + 1) % this.images.length);
  }

  prev() {
    this.goTo((this.currentIndex - 1 + this.images.length) % this.images.length);
  }
}
