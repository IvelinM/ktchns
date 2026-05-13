import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-loader',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.scss'],
})
export class LoaderComponent implements OnInit {
  visible = true;
  fading  = false;

  ngOnInit() {
    setTimeout(() => {
      this.fading = true;
      setTimeout(() => { this.visible = false; }, 600);
    }, 2600);
  }
}
