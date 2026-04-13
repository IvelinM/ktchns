import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-project-slider',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule],
  templateUrl: './project-slider.component.html',
  styleUrls: ['./project-slider.component.scss'],
})
export class ProjectSliderComponent implements OnInit, OnDestroy {
  @Input() images: string[] = [];
  @Input() projectName = '';
  @Output() closed = new EventEmitter<void>();

  currentIndex = 0;
  prevIndex = -1;

  private clearPrevTimer?: ReturnType<typeof setTimeout>;

  ngOnInit() {
    document.body.style.overflow = 'hidden';
  }

  ngOnDestroy() {
    document.body.style.overflow = '';
    clearTimeout(this.clearPrevTimer);
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') this.next();
    else if (event.key === 'ArrowLeft') this.prev();
    else if (event.key === 'Escape') this.close();
  }

  goTo(index: number) {
    if (index === this.currentIndex) return;
    clearTimeout(this.clearPrevTimer);
    this.prevIndex = this.currentIndex;
    this.currentIndex = index;
    // Clear prev slightly after CSS transition ends (0.4s)
    this.clearPrevTimer = setTimeout(() => { this.prevIndex = -1; }, 700);
  }

  next() {
    this.goTo((this.currentIndex + 1) % this.images.length);
  }

  prev() {
    this.goTo((this.currentIndex - 1 + this.images.length) % this.images.length);
  }

  close() {
    this.closed.emit();
  }
}
