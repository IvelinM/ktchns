import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatRippleModule } from '@angular/material/core';
import { Project, PROJECTS } from './projects.data';
import { ProjectSliderComponent } from './project-slider/project-slider.component';

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatRippleModule, ProjectSliderComponent],
  templateUrl: './projects.component.html',
  styleUrls: ['./projects.component.scss'],
})
export class ProjectsComponent {
  projects: Project[] = PROJECTS;
  activeProject: Project | null = null;

  open(project: Project) {
    this.activeProject = project;
  }

  close() {
    this.activeProject = null;
  }
}
