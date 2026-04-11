import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
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
export class ProjectSliderComponent implements OnInit {
  @Input() images: string[] = [];
  @Input() projectName = '';
  @Output() closed = new EventEmitter<void>();

  currentIndex = 0;
  fading = false;

  ngOnInit() {
    document.body.style.overflow = 'hidden';
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') this.next();
    else if (event.key === 'ArrowLeft') this.prev();
    else if (event.key === 'Escape') this.close();
  }

  goTo(index: number) {
    if (this.fading || index === this.currentIndex) return;
    this.fading = true;
    setTimeout(() => {
      this.currentIndex = index;
      this.fading = false;
    }, 350);
  }

  next() {
    this.goTo((this.currentIndex + 1) % this.images.length);
  }

  prev() {
    this.goTo((this.currentIndex - 1 + this.images.length) % this.images.length);
  }

  close() {
    document.body.style.overflow = '';
    this.closed.emit();
  }
}
